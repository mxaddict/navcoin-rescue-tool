import bitcoreLib from '@aguycalled/bitcore-lib';

const blsct = bitcoreLib.Transaction.Blsct;
const Script = bitcoreLib.Script;
const sha256 = bitcoreLib.crypto.Hash.sha256;
const BitcoreTransaction = bitcoreLib.Transaction;

const RECEIVE_BRANCH = 0;
const CHANGE_BRANCH = 1;

const DEFAULT_OPTS = {
  // BIP44 standard gap is 20; recovery uses 100 to absorb edge cases.
  gapLimit: 100,
  // Derive + scan in chunks of this many keys per branch iteration.
  walkBatchSize: 100,
  // Static xNAV subaddress pool. Recovery scan needs each user xNAV key in
  // the db so HaveKey lookup matches against blsct hashIds.
  xNavPoolSize: 100,
  concurrency: 25,
  progressInterval: 25,
  // Aborting stops the scan at its next step: no further lookups, no
  // stale-UTXO reap and no sync_finished. Lookups already sent stay
  // pending until they answer, or forever if their connection died.
  signal: undefined,
  // The spending password, needed to derive addresses. Not read from
  // wallet.spendingPassword: navcoin-js blanks that whenever its own sync
  // finishes, which it runs on every connect, and a blank password makes
  // address derivation quietly do nothing.
  password: undefined,
  // Where to keep the scan's progress so a scan cut off by a dropped
  // connection picks up where it stopped: `{ load, save, clear }`, each
  // async. Without one every scan starts from the first address.
  checkpoint: undefined,
};

const SCAN_CHECKPOINT_VERSION = 1;
// A checkpoint older than this is not resumed. Addresses it marks as done
// were looked at when it was written, and coins that reached them since
// would be skipped, so the older it is the less it can be trusted.
export const SCAN_CHECKPOINT_MAX_AGE_MS = 6 * 60 * 60_000;

// The resumable part of a scan: which addresses of each branch walk were
// looked up, and whether staking partners were discovered. Loaded from
// `cfg.checkpoint` when it holds a recent one, saved back as the scan
// advances, cleared when the scan finishes.
async function openProgress(cfg) {
  const store = cfg.checkpoint;
  let saved = null;
  if (store) {
    try {
      saved = await store.load();
    } catch (err) {
      console.error(`[rescue-scan] checkpoint not readable: ${err.message}`);
    }
  }

  const age = saved ? Date.now() - Date.parse(saved.startedAt) : NaN;
  const resumed =
    saved?.version === SCAN_CHECKPOINT_VERSION &&
    age >= 0 &&
    age < SCAN_CHECKPOINT_MAX_AGE_MS;
  const state = resumed
    ? saved
    : {
        version: SCAN_CHECKPOINT_VERSION,
        startedAt: new Date().toISOString(),
        walks: {},
        stakingDiscovered: false,
      };

  // One write at a time, each of the state as it is when its turn comes:
  // overlapping writes could land out of order and leave an older one last.
  let writing = Promise.resolve();

  return {
    resumed,
    state,
    walk(phase) {
      return (state.walks[phase] ??= { finished: [], lastUsedIdx: -1 });
    },
    // A scan that was aborted is being replaced by a new one; it must not
    // overwrite what its replacement saves.
    save() {
      if (!store) return writing;
      writing = writing.then(async () => {
        if (cfg.signal?.aborted) return;
        try {
          await store.save(structuredClone(state));
        } catch (err) {
          console.error(`[rescue-scan] checkpoint not saved: ${err.message}`);
        }
      });
      return writing;
    },
    async clear() {
      await writing;
      if (store) await store.clear();
    },
  };
}

/**
 * Scan bookkeeping shared by every pass.
 *
 * `outpointsSeen` collects every unspent outpoint observed this scan.
 * After scanning, a UTXO in our db that wasn't seen has been spent on
 * chain since the last scan (typically: a stake input consumed by a
 * stake reward tx), and reapStaleUtxos marks it spent so the balance
 * stops counting it — otherwise confirmed balance accumulates the spent
 * inputs while pending shows the new stake outputs, double-counting the
 * rotated value.
 *
 * `failures` counts lookups that came back as an error rather than an
 * answer: an address's history or unspent outputs, the transaction of an
 * output being added, a staking partner. Any of them makes the scan
 * incomplete — see the end of rescueScan.
 */
function createScan() {
  return { outpointsSeen: new Set(), failures: 0 };
}

// Thrown by rescueScan when it ran to the end with lookups that failed.
// What it found is in the wallet; what it could not look up is not.
export class ScanIncompleteError extends Error {
  constructor(failures) {
    super(`${failures} lookup(s) failed, so the scan is incomplete`);
    this.name = 'ScanIncompleteError';
    this.failures = failures;
  }
}

// Resolves true once the scan has run to the end with every lookup
// answered, false when there was no connection to scan with and nothing
// was done. Rejects with ScanIncompleteError when it ran to the end but
// some lookups failed.
export async function rescueScan(wallet, opts = {}) {
  if (!wallet.client) {
    return false;
  }

  const cfg = { ...DEFAULT_OPTS, ...opts };
  const password = cfg.password;
  if (cfg.skipDerive !== true && !password) {
    throw new Error('rescueScan needs the spending password to derive');
  }

  const scan = createScan();
  const progress = await openProgress(cfg);
  if (progress.resumed) {
    console.error(
      `[rescue-scan] resuming the scan started ${progress.state.startedAt}`,
    );
  }

  // Reset the staking-partner discovery cache so each scan re-queries
  // blockchain_staking_getKeys for every address. Without this, partners
  // introduced after the first sync (a new pool joins, a new cold-stake
  // contract is set up) are never discovered until daemon restart. A
  // resumed scan that already discovered them keeps what it stored.
  wallet.requestedStakingKeys = progress.state.stakingDiscovered;

  wallet.emit('bootstrap_started');

  if (cfg.skipDerive !== true && cfg.xNavPoolSize > 0) {
    const wasFilled = wallet.poolFilled;
    wallet.poolFilled = false;
    try {
      await wallet.xNavFillKeyPool(password, cfg.xNavPoolSize);
    } finally {
      wallet.poolFilled = wasFilled;
    }
  }

  if (cfg.skipDerive) {
    await scanExistingNavAddrs(wallet, cfg, scan);
  } else {
    await walkBranch(wallet, password, RECEIVE_BRANCH, cfg, scan, progress);
    await walkBranch(wallet, password, CHANGE_BRANCH, cfg, scan, progress);
  }

  await scanStaking(wallet, cfg, scan, progress);

  if (cfg.skipXNav !== true) {
    await scanXNav(wallet, cfg, scan);
  }

  cfg.signal?.throwIfAborted();
  // A lookup that failed is an address, a coin or a staking partner this
  // scan knows nothing about. Calling the wallet synced now would let a
  // sweep run on a balance with coins missing and leave them behind, so
  // the scan ends as incomplete: nothing is reaped, since not seeing an
  // outpoint means "not looked up" rather than "spent", and the checkpoint
  // is kept so a rerun retries only what failed.
  if (scan.failures > 0) {
    throw new ScanIncompleteError(scan.failures);
  }
  if (progress.resumed) {
    // The addresses the earlier attempt finished were not looked up again,
    // so their outpoints are not in `outpointsSeen` and would be reaped as
    // spent, and a UTXO marked spent stays that way in the db. Overcounting
    // until the next scan that runs start to finish is recoverable; hiding
    // a live UTXO from the sweep is not.
    console.error('[rescue-scan] resumed scan — skipping stale-UTXO reap');
  } else {
    await reapStaleUtxos(wallet, scan.outpointsSeen);
  }

  cfg.signal?.throwIfAborted();
  await progress.clear();
  wallet.emit('bootstrap_finished');
  wallet.emit('sync_finished');
  return true;
}

// Adaptive gap-bounded scan for one branch. Derives in batches and scans
// each batch via history + listunspent + GetTx + AddOutput inline. The
// confirmed balance climbs during the scan instead of only at the end.
// Walks until scannedIdx - 1 - lastUsedIdx >= gapLimit.
//
// "Used" means the address has history, whether or not anything on it is
// still unspent. Counting only addresses that hold coins ends the walk
// early in a wallet that has spent from a long run of them, as a change
// branch has after that many payments, and misses whatever lies beyond.
//
// A resumed scan walks the same addresses from the start, but skips the
// lookups for those `progress` records as finished: an address is recorded
// only once every lookup for it succeeded, so one that failed or was cut
// off by a drop is looked up again.
async function walkBranch(wallet, password, branch, cfg, scan, progress) {
  const counterName = branch === CHANGE_BRANCH ? 'NavChange' : 'Nav';
  const phase = branch === CHANGE_BRANCH ? 'change' : 'receive';

  wallet.emit('utxo_phase', phase);

  const walk = progress.walk(phase);
  const finished = new Set(walk.finished);
  let lastUsedIdx = walk.lastUsedIdx;
  let scannedIdx = 0;
  let derivedIdx = (await wallet.db.GetCounter(counterName)) ?? 0;

  wallet.emit(
    'scripthash_progress',
    0,
    Math.max(cfg.walkBatchSize, derivedIdx),
  );

  const wasFilled = wallet.poolFilled;
  wallet.poolFilled = false;

  try {
    while (true) {
      cfg.signal?.throwIfAborted();
      // Derive ahead so we always have walkBatchSize unscanned addrs ready.
      // HD derivation (especially navcoin-core's all-hardened path) is
      // CPU-bound — emit progress during the loop so the bar moves while
      // we derive.
      const needed = scannedIdx + cfg.walkBatchSize;
      while (derivedIdx < needed) {
        cfg.signal?.throwIfAborted();
        await wallet.NavCreateAddress(password, branch);
        derivedIdx++;
        if (derivedIdx % cfg.progressInterval === 0) {
          wallet.emit('scripthash_progress', scannedIdx, derivedIdx);
          await yieldEventLoop();
        }
      }

      const branchAddrs = await getBranchAddrs(wallet, branch);
      const batch = branchAddrs.slice(
        scannedIdx,
        scannedIdx + cfg.walkBatchSize,
      );
      if (batch.length === 0) break;

      const pending = batch.filter((addr) => !finished.has(addr.idx));
      let inBatchScanned = batch.length - pending.length;
      await mapConcurrent(pending, cfg, async (addr) => {
        const { ok, used } = await scanAndHydrateAddr(
          wallet,
          addr.address,
          scan,
        );
        if (used && addr.idx > lastUsedIdx) lastUsedIdx = addr.idx;
        if (ok) finished.add(addr.idx);
        inBatchScanned++;
        if (
          inBatchScanned % cfg.progressInterval === 0 ||
          inBatchScanned === batch.length
        ) {
          wallet.emit(
            'scripthash_progress',
            scannedIdx + inBatchScanned,
            Math.max(scannedIdx + inBatchScanned, derivedIdx),
          );
          walk.finished = [...finished];
          walk.lastUsedIdx = lastUsedIdx;
          await progress.save();
        }
      });

      scannedIdx += batch.length;
      await yieldEventLoop();

      // Termination: scanned past last-used by gap.
      if (scannedIdx - 1 - lastUsedIdx >= cfg.gapLimit) break;
    }
  } finally {
    wallet.poolFilled = wasFilled;
  }
}

// One-shot scan of existing NAV addrs for skipDerive sources (private-key
// imports). No walking — just iterate the imported keys once.
async function scanExistingNavAddrs(wallet, cfg, scan) {
  wallet.emit('utxo_phase', 'receive');

  const all = await wallet.db.GetNavReceivingAddresses(true);
  let scanned = 0;

  await mapConcurrent(all, cfg, async (addr) => {
    await scanAndHydrateAddr(wallet, addr.address, scan);
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === all.length) {
      wallet.emit('scripthash_progress', scanned, all.length);
    }
  });
}

// Scan one address: history → listunspent → GetTx + AddOutput inline.
// wallet.GetTx fetches the merkle proof so tx.height is set in the db,
// which is required for GetBalance to return a confirmed (vs pending)
// balance. Returns `used`, whether the address has any history, and `ok`:
// false when a lookup or a hydration failed, so the address was not fully
// scanned.
async function scanAndHydrateAddr(wallet, address, scan) {
  const sh = wallet.AddressToScriptHash(address);

  let history;
  try {
    const result = await wallet.client.blockchain_scripthash_getHistory(sh);
    history = result?.history ?? (Array.isArray(result) ? result : []);
  } catch (err) {
    console.error(`[rescue-scan] history failed ${address}: ${err.message}`);
    scan.failures += 1;
    return { ok: false, used: false };
  }
  if (history.length === 0) return { ok: true, used: false };

  let list;
  try {
    list = await wallet.client.blockchain_scripthash_listunspent(sh);
  } catch (err) {
    console.error(
      `[rescue-scan] listunspent failed ${address}: ${err.message}`,
    );
    scan.failures += 1;
    return { ok: false, used: false };
  }
  if (list.length === 0) return { ok: true, used: true };

  let ok = true;
  for (const u of list) {
    const outpoint = `${u.tx_hash}:${u.tx_pos}`;
    scan.outpointsSeen.add(outpoint);
    try {
      const tx = await wallet.GetTx(u.tx_hash, undefined, u.height, false);
      if (!tx?.hex) continue;
      const decoded = BitcoreTransaction(tx.hex);
      const out = decoded.outputs[u.tx_pos];
      if (!out) continue;
      await wallet.AddOutput(outpoint, out, u.height);
      wallet.emit('balance_changed');
    } catch (err) {
      console.error(
        `[rescue-scan] hydrate failed for ${outpoint}: ${err.message}`,
      );
      scan.failures += 1;
      ok = false;
    }
  }
  return { ok, used: true };
}

async function getBranchAddrs(wallet, branch) {
  const all = await wallet.db.GetNavReceivingAddresses(true);
  return all
    .filter((a) => Boolean(a.change) === (branch === CHANGE_BRANCH))
    .map((a) => ({ ...a, idx: parsePathIndex(a.path) }))
    .sort((a, b) => a.idx - b.idx);
}

function parsePathIndex(path) {
  if (!path) return 0;
  const parts = path.split('/');
  const last = parts[parts.length - 1].replace(/'$/, '');
  const n = parseInt(last, 10);
  return Number.isFinite(n) ? n : 0;
}

// Walk every derived NAV addr and call blockchain_staking_getKeys to
// find every staking partner the user ever cold-staked through. This is
// what wallet.GetScriptHashes() (no arg) does internally, but without
// any progress reporting — for 10k+ addr wallets that's a long silent
// pause. Doing it ourselves so we can emit progress.
async function discoverStakingPartners(wallet, cfg, scan, progress) {
  if (wallet.requestedStakingKeys) return;

  const addrs = await wallet.db.GetNavAddresses();
  if (addrs.length === 0) {
    wallet.requestedStakingKeys = true;
    return;
  }

  wallet.emit('utxo_phase', 'stake-discover');
  wallet.emit('scripthash_progress', 0, addrs.length);

  let scanned = 0;
  let failed = 0;
  await mapConcurrent(addrs, cfg, async (addr) => {
    try {
      const stakingAddresses = await wallet.client.blockchain_staking_getKeys(
        Buffer.from(addr.hash, 'hex').reverse().toString('hex'),
      );
      for (const entry of stakingAddresses ?? []) {
        try {
          await wallet.AddStakingAddress(entry[0], entry[1], false);
        } catch {
          // Duplicate / malformed entry — skip.
        }
      }
    } catch (err) {
      console.error(
        `[rescue-scan] staking_getKeys failed for ${addr.address}: ${err.message}`,
      );
      failed++;
      scan.failures += 1;
    }
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === addrs.length) {
      wallet.emit('scripthash_progress', scanned, addrs.length);
    }
  });

  wallet.requestedStakingKeys = true;
  // The partners found are in the wallet database, so a resumed scan can
  // skip this pass, but only one in which every address was answered.
  if (failed === 0) {
    progress.state.stakingDiscovered = true;
    await progress.save();
  }
}

async function scanStaking(wallet, cfg, scan, progress) {
  await discoverStakingPartners(wallet, cfg, scan, progress);

  wallet.emit('utxo_phase', 'stake');

  const stakingAddrs = await wallet.GetStakingAddresses();
  const items = [];
  for (const stakingAddr of stakingAddrs) {
    cfg.signal?.throwIfAborted();
    const shs = await wallet.GetScriptHashes(stakingAddr);
    for (const sh of shs) items.push(sh);
  }

  let scanned = 0;

  await mapConcurrent(items, cfg, async (sh) => {
    let list;
    try {
      list = await wallet.client.blockchain_scripthash_listunspent(sh);
    } catch (err) {
      console.error(`[rescue-scan] staking listunspent failed: ${err.message}`);
      scan.failures += 1;
      list = [];
    }
    for (const u of list) {
      const outpoint = `${u.tx_hash}:${u.tx_pos}`;
      scan.outpointsSeen.add(outpoint);
      try {
        const tx = await wallet.GetTx(u.tx_hash, undefined, u.height, false);
        if (!tx?.hex) continue;
        const decoded = BitcoreTransaction(tx.hex);
        const out = decoded.outputs[u.tx_pos];
        if (!out) continue;
        await wallet.AddOutput(outpoint, out, u.height);
        wallet.emit('balance_changed');
      } catch (err) {
        console.error(
          `[rescue-scan] staking hydrate failed for ${outpoint}: ${err.message}`,
        );
        scan.failures += 1;
      }
    }
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === items.length) {
      wallet.emit('scripthash_progress', scanned, items.length);
    }
  });
}

async function scanXNav(wallet, cfg, scan) {
  if (!wallet.mvk) return;

  // Anchor-history fetch can take seconds on a busy network. Mark the
  // phase up-front so the status display shows we're not idle.
  wallet.emit('utxo_phase', 'xnav-history');

  const opTrueBuf = Script.fromHex('51').toBuffer();
  const anchor = Buffer.from(sha256(opTrueBuf).reverse()).toString('hex');

  const fromHeight = wallet.creationTip || 0;

  let history;
  try {
    history = await wallet.client.blockchain_scripthash_getHistory(
      anchor,
      fromHeight,
    );
  } catch (err) {
    console.error(`[rescue-scan] xnav anchor history failed: ${err.message}`);
    scan.failures += 1;
    return;
  }

  const entries = Array.isArray(history) ? history : history?.history || [];
  if (entries.length === 0) return;

  // Build set of currently-unspent xNAV outpoints from the anchor scripthash.
  // Without this, scanXNav would re-add owned outputs that have since been
  // spent (e.g., by our own sweep tx) because it walks history not utxos.
  // listunspent on anchor returns all OP_TRUE outputs network-wide; we only
  // care about the subset we own, but the set lets us cheaply filter.
  let anchorUnspent = null;
  try {
    const list = await wallet.client.blockchain_scripthash_listunspent(anchor);
    anchorUnspent = new Set(
      (list ?? []).map((u) => `${u.tx_hash}:${u.tx_pos}`),
    );
  } catch (err) {
    console.error(
      `[rescue-scan] xnav anchor listunspent failed: ${err.message}`,
    );
    scan.failures += 1;
    // Fall through with anchorUnspent = null; we'll add all owned outputs
    // and rely on the next scan after a confirmed listunspent to clean up.
  }

  wallet.emit('utxo_phase', 'xnav');
  wallet.emit('scripthash_progress', 0, entries.length);

  // Phase 1: txKeys cache pre-filter. Bootstrap pre-populates this; misses
  // fall back to blockchain_transaction_getKeys (smaller than full tx).
  // Only owned txs get a full tx fetch in phase 2.
  const owned = [];
  let scanned = 0;

  await mapConcurrent(entries, cfg, async (entry) => {
    const txid = entry.tx_hash;
    const txKeys = await loadTxKeys(wallet, txid);

    if (!txKeys) {
      // getKeys unavailable on this server — fall back to raw tx scan.
      owned.push({ txid, height: entry.height, fallback: true });
    } else if (await hasOwnedXNavOutput(wallet, txKeys)) {
      owned.push({ txid, height: entry.height });
    }

    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === entries.length) {
      wallet.emit('scripthash_progress', scanned, entries.length);
    }
  });

  if (owned.length === 0) return;

  // Phase 2: fetch raw tx for owned candidates and AddOutput.
  wallet.emit('utxo_phase', 'xnav-claim');

  let claimed = 0;
  for (const { txid, height } of owned) {
    cfg.signal?.throwIfAborted();
    claimed++;
    if (claimed % cfg.progressInterval === 0 || claimed === owned.length) {
      wallet.emit('scripthash_progress', claimed, owned.length);
    }

    let hex;
    try {
      const tx = await wallet.GetTx(txid, undefined, height, false);
      hex = tx?.hex;
    } catch (err) {
      console.error(`[rescue-scan] xnav GetTx failed ${txid}: ${err.message}`);
      scan.failures += 1;
      continue;
    }
    if (!hex) continue;

    let decoded;
    try {
      decoded = BitcoreTransaction(hex);
    } catch {
      continue;
    }

    for (let i = 0; i < decoded.outputs.length; i++) {
      const out = decoded.outputs[i];
      if (!(out.isCt?.() || out.isNft?.())) continue;

      let hashId;
      try {
        const hid = blsct.GetHashId(out, wallet.mvk);
        if (!hid) continue;
        hashId = Buffer.from(hid).toString('hex');
      } catch {
        continue;
      }

      const acc = await wallet.db.HaveKey(hashId);
      if (!acc) continue;

      try {
        const recovered = blsct.RecoverBLSCTOutput(
          out,
          wallet.mvk,
          undefined,
          acc[0],
          acc[1],
          out.tokenId,
          out.tokenNftId,
        );
        if (!recovered) continue;
      } catch {
        continue;
      }

      const outpoint = `${txid}:${i}`;
      // Skip outputs already spent on chain. Without this filter, owned
      // xNAV outputs spent by a later tx (e.g., our own sweep) get re-added
      // as unspent every rescan and double-count the balance.
      if (anchorUnspent && !anchorUnspent.has(outpoint)) continue;
      scan.outpointsSeen.add(outpoint);
      try {
        await wallet.AddOutput(outpoint, out, height);
        wallet.emit('balance_changed');
      } catch (err) {
        console.error(
          `[rescue-scan] xnav AddOutput failed ${outpoint}: ${err.message}`,
        );
      }
    }
  }
}

// After scanning, mark any UTXO in db that wasn't seen this scan as
// spent. Catches stake inputs consumed since the last scan and any
// other UTXO no longer in the chain's listunspent set.
async function reapStaleUtxos(wallet, outpointsSeen) {
  let utxos;
  try {
    utxos = await wallet.db.GetUtxos(true);
  } catch (err) {
    console.error(`[rescue-scan] reap failed to read utxos: ${err.message}`);
    return;
  }

  let reaped = 0;
  for (const u of utxos) {
    if (outpointsSeen.has(u.id)) continue;
    if (u.spentIn) continue;
    try {
      await wallet.db.SpendUtxo(u.id, 'rescue-stale');
      reaped++;
    } catch {
      // Non-fatal: leave entry, balance will overcount until next scan.
    }
  }

  if (reaped > 0) {
    wallet.emit('balance_changed');
  }
}

async function loadTxKeys(wallet, txid) {
  try {
    const cached = await wallet.db.GetTxKeys(txid);
    if (cached) return cached;
  } catch {
    // Cache miss — fall through to remote.
  }

  try {
    const remote = await wallet.client.blockchain_transaction_getKeys(txid);
    if (!remote) return null;
    remote.txidkeys = txid;
    remote.hash = txid;
    try {
      await wallet.db.AddTxKeys(remote);
    } catch {
      // Cache write failure is non-fatal.
    }
    return remote;
  } catch (err) {
    console.error(
      `[rescue-scan] transaction_getKeys failed for ${txid}: ${err.message}`,
    );
    return null;
  }
}

async function hasOwnedXNavOutput(wallet, txKeys) {
  for (const v of txKeys.vout || []) {
    if (!v.outputKey || !v.spendingKey) continue;
    try {
      const hid = blsct.GetHashId(
        { ok: v.outputKey, sk: v.spendingKey },
        wallet.mvk,
      );
      if (!hid) continue;
      const hashId = Buffer.from(hid).toString('hex');
      if (await wallet.db.HaveKey(hashId)) return true;
    } catch {
      // Skip malformed entry.
    }
  }
  return false;
}

async function mapConcurrent(items, cfg, fn) {
  if (items.length === 0) return;
  const queue = items.slice();
  const workerCount = Math.min(cfg.concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
      cfg.signal?.throwIfAborted();
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
