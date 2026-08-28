import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import {
  openSourceWallet,
  closeSourceWallet,
  closeAllWallets,
  prepareSweep,
  executeSweep,
  getSourceState,
  resetElectrumNodeSelectionCache,
} from '../src/wallet-manager.js';
import { makeProjectTempDir } from './test-helpers.js';

class AlwaysOpenWebSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => {
      this.listeners.get('open')?.forEach((listener) => listener());
    });
  }

  addEventListener(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  close() {}
}

// Minimal mock WalletFile that simulates navcoin-js events.
class MockWalletFile extends EventEmitter {
  constructor(opts) {
    super();
    this._opts = opts;
    this._balance = opts._balance ?? {
      nav: { confirmed: 5_0000_0000, pending: 0 },
      staked: { confirmed: 0, pending: 0 },
    };
    this._syncOnConnect = opts._syncOnConnect ?? true;
    this._txResult = opts._txResult ?? {
      tx: 'deadbeef',
      fee: 10000,
    };
    this._xnavTxResult = opts._xnavTxResult ?? null;
    // Support queue-based send results: if _sendResultQueue is set, pop from
    // the front on each SendTransaction call; otherwise fall back to _sendResult.
    this._sendResultQueue = opts._sendResultQueue ?? null;
    this._sendResult = opts._sendResult ?? { hashes: ['abc123'], error: null };
  }

  async Load() {
    this.emit('db_open');
  }

  async Connect() {
    this.emit('connected', 'mock-server:40004');
    if (this._syncOnConnect) {
      queueMicrotask(() => {
        this.emit('bootstrap_started');
        this.emit('scripthash_progress', 10, 10);
        this.emit('sync_finished');
      });
    }
  }

  async NavReceivingAddresses() {
    return [{ address: 'NTestAddr1', path: "m/44'/130'/0'/0/0", used: 0 }];
  }

  async GetBalance() {
    return this._balance;
  }

  async NavCreateTransaction(destination, amount, memo, password, subtractFee) {
    this._lastTxArgs = { destination, amount, memo, password, subtractFee };
    return this._txResult;
  }

  async xNavCreateTransaction(
    destination,
    amount,
    memo,
    password,
    subtractFee,
  ) {
    this._lastXNavTxArgs = { destination, amount, memo, password, subtractFee };
    return this._xnavTxResult;
  }

  async SendTransaction(tx) {
    this._lastSentTx = tx;
    if (this._sendResultQueue && this._sendResultQueue.length > 0) {
      return this._sendResultQueue.shift();
    }
    return this._sendResult;
  }

  ClearNodeList() {
    this.electrumNodes = [];
  }

  AddNode(host, port, proto) {
    this.electrumNodes.push({ host, port, proto });
  }

  Disconnect() {}
  CloseDb() {}
}

function makeNavWallet(opts = {}) {
  return {
    WalletFile: class extends MockWalletFile {
      constructor(walletOpts) {
        super({ ...walletOpts, ...opts });
      }
    },
  };
}

test('prepareSweep blocks when no sources imported', async () => {
  const root = await makeProjectTempDir('sweep-empty');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);
    assert.throws(() => prepareSweep(), /No imported sources/);
  } finally {
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepareSweep blocks when source not synced', async () => {
  const root = await makeProjectTempDir('sweep-unsynced');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-unsynced', type: 'mnemonic', label: 'Test' };

    // Use a wallet that never fires sync_finished.
    const navWallet = makeNavWallet({
      _syncOnConnect: false,
      _syncUtxos: false,
    });
    await openSourceWallet(source, root, navWallet);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.throws(() => prepareSweep(), /not fully synced/);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepareSweep returns preview when all sources synced', async () => {
  const root = await makeProjectTempDir('sweep-preview');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-synced', type: 'mnemonic', label: 'Test' };
    await openSourceWallet(source, root, makeNavWallet());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const preview = prepareSweep();
    assert.equal(preview.sources.length, 1);
    assert.equal(preview.sources[0].sourceId, source.id);
    assert.equal(preview.sources[0].nav, 5_0000_0000);
    assert.equal(preview.totalNav, 5_0000_0000);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('executeSweep creates and broadcasts transactions per source', async () => {
  const root = await makeProjectTempDir('sweep-exec');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-exec', type: 'mnemonic', label: 'Test' };
    await openSourceWallet(source, root, makeNavWallet());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await executeSweep('NDestinationAddr1');
    assert.equal(result.hashes.length, 1);
    assert.equal(result.hashes[0], 'abc123');
    assert.equal(result.totalFee, 10000);
    assert.equal(result.totalSent, 5_0000_0000 - 10000);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('executeSweep skips zero-balance sources', async () => {
  const root = await makeProjectTempDir('sweep-zero');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    // Source with zero balance.
    const source = { id: 'src-zero', type: 'mnemonic', label: 'Empty' };
    const navWallet = makeNavWallet({
      _balance: {
        nav: { confirmed: 0, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
    });
    await openSourceWallet(source, root, navWallet);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await executeSweep('NDestinationAddr1');
    assert.equal(result.hashes.length, 0);
    assert.equal(result.totalSent, 0);
    assert.equal(result.totalFee, 0);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepareSweep returns zero-total preview for empty synced wallet', async () => {
  const root = await makeProjectTempDir('sweep-zero-preview');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-zero-preview', type: 'mnemonic', label: 'Empty' };
    const navWallet = makeNavWallet({
      _balance: {
        nav: { confirmed: 0, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
    });
    await openSourceWallet(source, root, navWallet);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const preview = prepareSweep();
    assert.equal(preview.sources.length, 1);
    assert.equal(preview.sources[0].sourceId, source.id);
    assert.equal(preview.totalNav, 0);
    assert.equal(preview.totalXNav, 0);
    assert.equal(preview.totalCombined, 0);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('executeSweep throws when SendTransaction returns error', async () => {
  const root = await makeProjectTempDir('sweep-err');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-err', type: 'mnemonic', label: 'Test' };
    const navWallet = makeNavWallet({
      _sendResult: { hashes: [], error: 'network error' },
    });
    await openSourceWallet(source, root, navWallet);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await assert.rejects(
      () => executeSweep('NDestinationAddr1'),
      /broadcast failed/i,
    );
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('executeSweep aggregates legs from multiple sources without double-counting', async () => {
  const root = await makeProjectTempDir('sweep-multi');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const sourceA = { id: 'src-multi-a', type: 'mnemonic', label: 'WalletA' };
    const navWalletA = makeNavWallet({
      _balance: {
        nav: { confirmed: 3_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _txResult: { tx: 'hexA', fee: 5_000 },
      _sendResult: { hashes: ['hashA'], error: null },
    });
    await openSourceWallet(sourceA, root, navWalletA);

    const sourceB = { id: 'src-multi-b', type: 'mnemonic', label: 'WalletB' };
    const navWalletB = makeNavWallet({
      _balance: {
        nav: { confirmed: 7_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _txResult: { tx: 'hexB', fee: 8_000 },
      _sendResult: { hashes: ['hashB'], error: null },
    });
    await openSourceWallet(sourceB, root, navWalletB);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await executeSweep('NDestinationAddr1');

    // 1. Both hashes present, no duplicates.
    assert.equal(result.hashes.length, 2);
    const hashSet = new Set(result.hashes);
    assert.ok(hashSet.has('hashA'), 'hashA missing from result');
    assert.ok(hashSet.has('hashB'), 'hashB missing from result');

    // 2. totalSent is the sum of both legs minus their respective fees.
    assert.equal(result.totalSent, 3_0000_0000 - 5_000 + (7_0000_0000 - 8_000));

    // 3. totalFee is the sum of both fees.
    assert.equal(result.totalFee, 5_000 + 8_000);

    // 4. Each wallet received its own balance — no cross-contamination.
    const argsA = getSourceState(sourceA.id).wallet._lastTxArgs;
    assert.equal(argsA.amount, 3_0000_0000);

    const argsB = getSourceState(sourceB.id).wallet._lastTxArgs;
    assert.equal(argsB.amount, 7_0000_0000);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('staked balance is reported but excluded from sweep totals', async () => {
  const root = await makeProjectTempDir('sweep-staked');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-staked', type: 'mnemonic', label: 'Staked' };
    // nav = 2 NAV spendable, staked = 5 NAV cold-staked (not directly sweepable).
    const navWallet = makeNavWallet({
      _balance: {
        nav: { confirmed: 2_0000_0000, pending: 0 },
        staked: { confirmed: 5_0000_0000, pending: 0 },
      },
      _txResult: { tx: 'stakedtx', fee: 10_000 },
      _sendResult: { hashes: ['stakedhash1'], error: null },
    });
    await openSourceWallet(source, root, navWallet);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const preview = prepareSweep();
    assert.equal(preview.totalNav, 2_0000_0000);
    assert.equal(preview.totalCombined, 2_0000_0000);
    assert.equal(preview.sources[0].nav, 2_0000_0000);

    const result = await executeSweep('NDestinationAddr1');
    assert.equal(result.totalSent, 2_0000_0000 - 10_000);
    assert.equal(
      getSourceState(source.id).wallet._lastTxArgs.amount,
      2_0000_0000,
    );
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('executeSweep passes full confirmed balance with subtractFee=true', async () => {
  const root = await makeProjectTempDir('sweep-subtractfee');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-subtractfee', type: 'mnemonic', label: 'Test' };
    const navWallet = makeNavWallet({
      _balance: {
        nav: { confirmed: 10_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _txResult: { tx: 'fakehex', fee: 25_000 },
      _sendResult: { hashes: ['tx1'], error: null },
    });
    await openSourceWallet(source, root, navWallet);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await executeSweep('NDestinationAddr1');

    // Inspect the args passed to NavCreateTransaction.
    const lastTxArgs = getSourceState(source.id).wallet._lastTxArgs;
    assert.equal(lastTxArgs.destination, 'NDestinationAddr1');
    assert.equal(lastTxArgs.amount, 10_0000_0000);
    assert.equal(lastTxArgs.subtractFee, true);

    // Verify totals: fee subtracted from the full balance, nothing left over.
    assert.equal(result.totalSent, 10_0000_0000 - 25_000);
    assert.equal(result.totalFee, 25_000);
    assert.equal(result.hashes.length, 1);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('executeSweep broadcasts NAV and xNAV legs from same source', async () => {
  const root = await makeProjectTempDir('sweep-xnav');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-xnav', type: 'mnemonic', label: 'xNAV' };
    const navWallet = makeNavWallet({
      _balance: {
        nav: { confirmed: 4_0000_0000, pending: 0 },
        xnav: { confirmed: 6_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _txResult: { tx: 'navhex', fee: 12_000 },
      _xnavTxResult: { tx: 'xnavhex', fee: 25_000 },
      // Queue: first SendTransaction call (NAV leg) returns nav-hash,
      // second call (xNAV leg) returns xnav-hash.
      _sendResultQueue: [
        { hashes: ['nav-hash'], error: null },
        { hashes: ['xnav-hash'], error: null },
      ],
    });
    await openSourceWallet(source, root, navWallet);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await executeSweep('NDestinationAddr1');

    // Both hashes present.
    const hashSet = new Set(result.hashes);
    assert.ok(hashSet.has('nav-hash'), 'nav-hash missing from result');
    assert.ok(hashSet.has('xnav-hash'), 'xnav-hash missing from result');

    // Totals: each leg's balance minus its own fee.
    assert.equal(
      result.totalSent,
      4_0000_0000 - 12_000 + (6_0000_0000 - 25_000),
    );
    assert.equal(result.totalFee, 12_000 + 25_000);

    // NAV leg args.
    const wallet = getSourceState(source.id).wallet;
    assert.equal(wallet._lastTxArgs.amount, 4_0000_0000);
    assert.equal(wallet._lastTxArgs.subtractFee, true);

    // xNAV leg args.
    assert.equal(wallet._lastXNavTxArgs.destination, 'NDestinationAddr1');
    assert.equal(wallet._lastXNavTxArgs.amount, 6_0000_0000);
    assert.equal(wallet._lastXNavTxArgs.subtractFee, true);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a blocked sweep names every blocker and both ways forward', async () => {
  const root = await makeProjectTempDir('sweep-block-message');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    await openSourceWallet(
      { id: 'src-ready', type: 'mnemonic', walletType: 'next', label: 'R' },
      root,
      makeNavWallet(),
    );
    await openSourceWallet(
      { id: 'src-slow', type: 'mnemonic', walletType: 'navpay', label: 'S' },
      root,
      makeNavWallet({ _syncOnConnect: false, _syncUtxos: false }),
    );
    await openSourceWallet(
      { id: 'src-late', type: 'mnemonic', walletType: 'navcash', label: 'L' },
      root,
      makeNavWallet({ _syncOnConnect: false, _syncUtxos: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    let message = null;
    try {
      prepareSweep();
      assert.fail('an unsynced source must block the sweep');
    } catch (err) {
      message = err.message;
    }

    // One phrase opens several derivations, so being sent back to wait once
    // per source is its own failure — every blocker has to be in the message.
    assert.match(message, /src-slow \(navpay\)/);
    assert.match(message, /src-late \(navcash\)/);
    assert.doesNotMatch(
      message,
      /src-ready/,
      'a synced source is not a blocker',
    );
    assert.match(message, /2 of 3 sources/);
    assert.match(message, /1 ready source/);
    assert.match(message, /force the sweep/);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a forced sweep previews and spends only the ready sources', async () => {
  const root = await makeProjectTempDir('sweep-force');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const ready = { id: 'src-f-ready', type: 'mnemonic', walletType: 'next' };
    await openSourceWallet(
      ready,
      root,
      makeNavWallet({
        _balance: {
          nav: { confirmed: 4_0000_0000, pending: 0 },
          staked: { confirmed: 0, pending: 0 },
        },
        _txResult: { tx: 'hexReady', fee: 6_000 },
        _sendResult: { hashes: ['hashReady'], error: null },
      }),
    );

    const slow = { id: 'src-f-slow', type: 'mnemonic', walletType: 'navpay' };
    await openSourceWallet(
      slow,
      root,
      makeNavWallet({
        _syncOnConnect: false,
        _syncUtxos: false,
        _balance: {
          nav: { confirmed: 9_0000_0000, pending: 0 },
          staked: { confirmed: 0, pending: 0 },
        },
        _sendResult: { hashes: ['hashSlow'], error: null },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const preview = prepareSweep({ force: true });
    assert.equal(preview.sources.length, 1);
    assert.equal(preview.sources[0].sourceId, ready.id);
    // The skipped source's coins must not be counted as about to move.
    assert.equal(preview.totalNav, 4_0000_0000);
    assert.deepEqual(preview.skipped, [
      {
        sourceId: slow.id,
        walletType: 'navpay',
        reason: 'not fully synced (status: connected)',
      },
    ]);

    const result = await executeSweep('NDestinationAddr1', { force: true });
    assert.deepEqual(result.hashes, ['hashReady']);
    assert.equal(result.totalSent, 4_0000_0000 - 6_000);
    assert.equal(
      getSourceState(slow.id).wallet._lastSentTx,
      undefined,
      'a skipped source must not broadcast anything',
    );
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('executeSweep refuses to skip sources unless forced', async () => {
  const root = await makeProjectTempDir('sweep-exec-block');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    await openSourceWallet(
      { id: 'src-eb-ready', type: 'mnemonic' },
      root,
      makeNavWallet(),
    );
    await openSourceWallet(
      { id: 'src-eb-slow', type: 'mnemonic' },
      root,
      makeNavWallet({ _syncOnConnect: false, _syncUtxos: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    await assert.rejects(
      () => executeSweep('NDestinationAddr1'),
      /not ready to sweep/,
    );
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('forcing with nothing ready refuses rather than broadcasting nothing', async () => {
  const root = await makeProjectTempDir('sweep-force-empty');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    await openSourceWallet(
      { id: 'src-fe-slow', type: 'mnemonic' },
      root,
      makeNavWallet({ _syncOnConnect: false, _syncUtxos: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.throws(
      () => prepareSweep({ force: true }),
      /would broadcast nothing/,
    );
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
