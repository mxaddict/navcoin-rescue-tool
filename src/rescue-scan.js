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
};

export async function rescueScan(wallet, opts = {}) {
  if (!wallet.client) {
    return;
  }

  const cfg = { ...DEFAULT_OPTS, ...opts };
  const password = wallet.spendingPassword;

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
    await scanExistingNavAddrs(wallet, cfg);
  } else {
    await walkBranch(wallet, password, RECEIVE_BRANCH, cfg);
    await walkBranch(wallet, password, CHANGE_BRANCH, cfg);
  }

  await scanStaking(wallet, cfg);

  if (cfg.skipXNav !== true) {
    await scanXNav(wallet, cfg);
  }

  wallet.emit('bootstrap_finished');
  wallet.emit('sync_finished');

  // wallet.spendingPassword stays set so periodic re-scans can re-derive
  // and re-fill pools as new addresses come into use. The static password
  // is already a known-public constant in this codebase, so retaining it
  // in memory after the initial sync doesn't change the security posture.
}

// Adaptive gap-bounded scan for one branch. Derives in batches and scans
// each batch via history + listunspent + GetTx + AddOutput inline. The
// confirmed balance climbs during the scan instead of only at the end.
// Walks until scannedIdx - 1 - lastUsedIdx >= gapLimit.
async function walkBranch(wallet, password, branch, cfg) {
  const counterName = branch === CHANGE_BRANCH ? 'NavChange' : 'Nav';
  const phase = branch === CHANGE_BRANCH ? 'change' : 'receive';

  wallet.emit('utxo_phase', phase);

  let lastUsedIdx = -1;
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
      // Derive ahead so we always have walkBatchSize unscanned addrs ready.
      // HD derivation (especially navcoin-core's all-hardened path) is
      // CPU-bound — emit progress during the loop so the bar moves while
      // we derive.
      const needed = scannedIdx + cfg.walkBatchSize;
      while (derivedIdx < needed) {
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

      let inBatchScanned = 0;
      await mapConcurrent(batch, cfg.concurrency, async (addr) => {
        const found = await scanAndHydrateAddr(wallet, addr.address);
        if (found > 0 && addr.idx > lastUsedIdx) lastUsedIdx = addr.idx;
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
async function scanExistingNavAddrs(wallet, cfg) {
  wallet.emit('utxo_phase', 'receive');

  const all = await wallet.db.GetNavReceivingAddresses(true);
  let scanned = 0;

  await mapConcurrent(all, cfg.concurrency, async (addr) => {
    await scanAndHydrateAddr(wallet, addr.address);
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === all.length) {
      wallet.emit('scripthash_progress', scanned, all.length);
    }
  });
}

// Scan one address: history → listunspent → GetTx + AddOutput inline.
// wallet.GetTx fetches the merkle proof so tx.height is set in the db,
// which is required for GetBalance to return a confirmed (vs pending)
// balance. Returns the number of UTXOs added.
async function scanAndHydrateAddr(wallet, address) {
  const sh = wallet.AddressToScriptHash(address);

  let history;
  try {
    const result = await wallet.client.blockchain_scripthash_getHistory(sh);
    history = result?.history ?? (Array.isArray(result) ? result : []);
  } catch (err) {
    console.error(`[rescue-scan] history failed ${address}: ${err.message}`);
    return 0;
  }
  if (history.length === 0) return 0;

  let list;
  try {
    list = await wallet.client.blockchain_scripthash_listunspent(sh);
  } catch (err) {
    console.error(
      `[rescue-scan] listunspent failed ${address}: ${err.message}`,
    );
    return 0;
  }
  if (list.length === 0) return 0;

  let added = 0;
  for (const u of list) {
    try {
      const tx = await wallet.GetTx(u.tx_hash, undefined, u.height, false);
      if (!tx?.hex) continue;
      const decoded = BitcoreTransaction(tx.hex);
      const out = decoded.outputs[u.tx_pos];
      if (!out) continue;
      await wallet.AddOutput(`${u.tx_hash}:${u.tx_pos}`, out, u.height);
      wallet.emit('balance_changed');
      added++;
    } catch (err) {
      console.error(
        `[rescue-scan] hydrate failed for ${u.tx_hash}:${u.tx_pos}: ${err.message}`,
      );
    }
  }
  return added;
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
async function discoverStakingPartners(wallet, cfg) {
  if (wallet.requestedStakingKeys) return;

  const addrs = await wallet.db.GetNavAddresses();
  if (addrs.length === 0) {
    wallet.requestedStakingKeys = true;
    return;
  }

  wallet.emit('utxo_phase', 'stake-discover');
  wallet.emit('scripthash_progress', 0, addrs.length);

  let scanned = 0;
  await mapConcurrent(addrs, cfg.concurrency, async (addr) => {
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
    }
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === addrs.length) {
      wallet.emit('scripthash_progress', scanned, addrs.length);
    }
  });

  wallet.requestedStakingKeys = true;
}

async function scanStaking(wallet, cfg) {
  await discoverStakingPartners(wallet, cfg);

  wallet.emit('utxo_phase', 'stake');

  const stakingAddrs = await wallet.GetStakingAddresses();
  const items = [];
  for (const stakingAddr of stakingAddrs) {
    const shs = await wallet.GetScriptHashes(stakingAddr);
    for (const sh of shs) items.push(sh);
  }

  let scanned = 0;

  await mapConcurrent(items, cfg.concurrency, async (sh) => {
    let list;
    try {
      list = await wallet.client.blockchain_scripthash_listunspent(sh);
    } catch (err) {
      console.error(`[rescue-scan] staking listunspent failed: ${err.message}`);
      list = [];
    }
    for (const u of list) {
      try {
        const tx = await wallet.GetTx(u.tx_hash, undefined, u.height, false);
        if (!tx?.hex) continue;
        const decoded = BitcoreTransaction(tx.hex);
        const out = decoded.outputs[u.tx_pos];
        if (!out) continue;
        await wallet.AddOutput(`${u.tx_hash}:${u.tx_pos}`, out, u.height);
        wallet.emit('balance_changed');
      } catch (err) {
        console.error(
          `[rescue-scan] staking hydrate failed for ${u.tx_hash}:${u.tx_pos}: ${err.message}`,
        );
      }
    }
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === items.length) {
      wallet.emit('scripthash_progress', scanned, items.length);
    }
  });
}

async function scanXNav(wallet, cfg) {
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
    return;
  }

  const entries = Array.isArray(history) ? history : history?.history || [];
  if (entries.length === 0) return;

  wallet.emit('utxo_phase', 'xnav');
  wallet.emit('scripthash_progress', 0, entries.length);

  // Phase 1: txKeys cache pre-filter. Bootstrap pre-populates this; misses
  // fall back to blockchain_transaction_getKeys (smaller than full tx).
  // Only owned txs get a full tx fetch in phase 2.
  const owned = [];
  let scanned = 0;

  await mapConcurrent(entries, cfg.concurrency, async (entry) => {
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

      try {
        await wallet.AddOutput(`${txid}:${i}`, out, height);
        wallet.emit('balance_changed');
      } catch (err) {
        console.error(
          `[rescue-scan] xnav AddOutput failed ${txid}:${i}: ${err.message}`,
        );
      }
    }
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

async function mapConcurrent(items, concurrency, fn) {
  if (items.length === 0) return;
  const queue = items.slice();
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0) {
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
