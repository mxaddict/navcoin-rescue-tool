import bitcoreLib from '@aguycalled/bitcore-lib';

const blsct = bitcoreLib.Transaction.Blsct;
const Script = bitcoreLib.Script;
const sha256 = bitcoreLib.crypto.Hash.sha256;
const BitcoreTransaction = bitcoreLib.Transaction;

const RECEIVE_BRANCH = 0;
const CHANGE_BRANCH = 1;

const DEFAULT_OPTS = {
  maxReceive: 5000,
  maxChange: 10000,
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

  try {
    if (cfg.skipDerive !== true) {
      await derivePool(wallet, password, cfg);
    }

    const navUtxos = await scanNavBranches(wallet, cfg);
    const stakingUtxos = await scanStaking(wallet, cfg);

    await hydrateAndStore(wallet, navUtxos.concat(stakingUtxos), cfg);

    if (cfg.skipXNav !== true) {
      await scanXNav(wallet, cfg);
    }

    wallet.emit('bootstrap_finished');
    wallet.emit('sync_finished');
  } finally {
    wallet.spendingPassword = '';
  }
}

async function derivePool(wallet, password, cfg) {
  const wasFilled = wallet.poolFilled;
  wallet.poolFilled = false;
  try {
    let receiveIdx = (await wallet.db.GetCounter('Nav')) ?? 0;
    while (receiveIdx < cfg.maxReceive) {
      await wallet.NavCreateAddress(password, RECEIVE_BRANCH);
      receiveIdx++;
      if (receiveIdx % 200 === 0) await yieldEventLoop();
    }

    let changeIdx = (await wallet.db.GetCounter('NavChange')) ?? 0;
    while (changeIdx < cfg.maxChange) {
      await wallet.NavCreateAddress(password, CHANGE_BRANCH);
      changeIdx++;
      if (changeIdx % 200 === 0) await yieldEventLoop();
    }

    if (cfg.xNavPoolSize > 0) {
      await wallet.xNavFillKeyPool(password, cfg.xNavPoolSize);
    }
  } finally {
    wallet.poolFilled = wasFilled;
  }
}

async function scanNavBranches(wallet, cfg) {
  const all = await wallet.db.GetNavReceivingAddresses(true);
  const receive = all.filter((a) => !a.change);
  const change = all.filter((a) => a.change);
  const total = receive.length + change.length;

  wallet.emit('utxo_phase', 'receive');
  const r1 = await scanScriptHashes(wallet, receive, cfg, 0, total);

  wallet.emit('utxo_phase', 'change');
  const r2 = await scanScriptHashes(wallet, change, cfg, receive.length, total);

  return r1.concat(r2);
}

async function scanScriptHashes(wallet, addrs, cfg, baseIdx, total) {
  const utxos = [];
  let scanned = 0;

  await mapConcurrent(addrs, cfg.concurrency, async (addr) => {
    const sh = wallet.AddressToScriptHash(addr.address);
    try {
      const list = await wallet.client.blockchain_scripthash_listunspent(sh);
      for (const u of list) {
        utxos.push({ ...u, address: addr.address, scriptHash: sh });
      }
    } catch (err) {
      console.error(
        `[rescue-scan] listunspent failed for ${addr.address}: ${err.message}`,
      );
    }
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === addrs.length) {
      wallet.emit('scripthash_progress', baseIdx + scanned, total);
    }
  });

  return utxos;
}

async function scanStaking(wallet, cfg) {
  wallet.emit('utxo_phase', 'stake');

  const stakingAddrs = await wallet.GetStakingAddresses();
  const items = [];
  for (const stakingAddr of stakingAddrs) {
    const shs = await wallet.GetScriptHashes(stakingAddr);
    for (const sh of shs) items.push(sh);
  }

  const utxos = [];
  let scanned = 0;

  await mapConcurrent(items, cfg.concurrency, async (sh) => {
    try {
      const list = await wallet.client.blockchain_scripthash_listunspent(sh);
      for (const u of list) {
        utxos.push({ ...u, scriptHash: sh });
      }
    } catch (err) {
      console.error(`[rescue-scan] staking listunspent failed: ${err.message}`);
    }
    scanned++;
    if (scanned % cfg.progressInterval === 0 || scanned === items.length) {
      wallet.emit('scripthash_progress', scanned, items.length);
    }
  });

  return utxos;
}

async function hydrateAndStore(wallet, utxos, cfg) {
  if (utxos.length === 0) return;

  const txids = [...new Set(utxos.map((u) => u.tx_hash))];
  const txCache = new Map();

  await mapConcurrent(txids, cfg.concurrency, async (txid) => {
    const cached = await wallet.db.GetTx(txid);
    if (cached) {
      txCache.set(txid, cached.hex);
      return;
    }
    try {
      const hex = await wallet.client.blockchain_transaction_get(txid, false);
      txCache.set(txid, hex);
      await wallet.db.AddTx({ txid, hex });
    } catch (err) {
      console.error(
        `[rescue-scan] transaction_get failed for ${txid}: ${err.message}`,
      );
    }
  });

  for (const u of utxos) {
    const hex = txCache.get(u.tx_hash);
    if (!hex) continue;
    let decoded;
    try {
      decoded = BitcoreTransaction(hex);
    } catch {
      continue;
    }
    const out = decoded.outputs[u.tx_pos];
    if (!out) continue;
    try {
      await wallet.AddOutput(`${u.tx_hash}:${u.tx_pos}`, out, u.height);
    } catch (err) {
      console.error(
        `[rescue-scan] AddOutput failed for ${u.tx_hash}:${u.tx_pos}: ${err.message}`,
      );
    }
  }
}

async function scanXNav(wallet, cfg) {
  if (!wallet.mvk) return;

  wallet.emit('utxo_phase', 'xnav');

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

  const txCache = new Map();
  let fetched = 0;

  await mapConcurrent(entries, cfg.concurrency, async (entry) => {
    const txid = entry.tx_hash;
    const cached = await wallet.db.GetTx(txid);
    if (cached) {
      txCache.set(txid, { hex: cached.hex, height: entry.height });
    } else {
      try {
        const hex = await wallet.client.blockchain_transaction_get(txid, false);
        txCache.set(txid, { hex, height: entry.height });
        await wallet.db.AddTx({ txid, hex });
      } catch (err) {
        console.error(
          `[rescue-scan] xnav tx fetch failed ${txid}: ${err.message}`,
        );
      }
    }
    fetched++;
    if (fetched % cfg.progressInterval === 0 || fetched === entries.length) {
      wallet.emit('scripthash_progress', fetched, entries.length);
    }
  });

  for (const [txid, { hex, height }] of txCache) {
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
      } catch (err) {
        console.error(
          `[rescue-scan] xnav AddOutput failed ${txid}:${i}: ${err.message}`,
        );
      }
    }
  }
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
