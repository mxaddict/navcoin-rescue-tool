import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import {
  executeSweep,
  getSweepStatus,
  LEFT_NOT_SPENDABLE,
  LEFT_TOO_SMALL,
  prepareSweep,
  SWEEP_BROADCAST_TIMEOUT_MS,
  SWEEP_BUILD_TIMEOUT_MS,
} from '../src/sweep.js';
import {
  NAV_BATCH_INPUTS,
  NAV_TX_FEE,
  XNAV_BATCH_INPUTS,
  XNAV_FEE_PER_ELEMENT,
} from '../src/sweep-batches.js';
import {
  openSourceWallet,
  closeSourceWallet,
  closeAllWallets,
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
    this._navCalls = [];
    this._xnavCalls = [];
    // Support queue-based send results: if _sendResultQueue is set, pop from
    // the front on each SendTransaction call; otherwise fall back to _sendResult.
    this._sendResultQueue = opts._sendResultQueue ?? null;
    this._sendResult = opts._sendResult ?? { hashes: ['abc123'], error: null };
    // Optional UTXO db, so balance comes from computeBalance instead of
    // the GetBalance fallback.
    if (opts._utxos) {
      this.db = {
        GetUtxos: async () => opts._utxos,
        GetTx: async () => ({ height: 100 }),
      };
    }
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

  // What navcoin-js's GetUtxos returns, as far as the sweep reads it: the
  // UTXO db's outputs of that type when a test set one, and otherwise one
  // output holding the whole balance of that kind.
  async GetUtxos(type) {
    if (this._opts._spendable) return this._opts._spendable(type);
    if (this._opts._utxos) {
      return this._opts._utxos
        .filter((utxo) => utxo.type & type)
        .map((utxo) => ({
          txid: utxo.id.split(':')[0],
          vout: Number(utxo.id.split(':')[1]),
          amount: utxo.amount,
          output: { satoshis: utxo.amount },
        }));
    }
    const xnav = type === 0x4;
    const amount = xnav
      ? (this._balance.xnav?.confirmed ?? 0)
      : this._balance.nav.confirmed;
    return [
      {
        txid: xnav ? 'x'.repeat(64) : 'n'.repeat(64),
        vout: 0,
        amount,
        output: { satoshis: amount },
      },
    ];
  }

  // The sweep builds a NAV batch on an object inheriting from the wallet,
  // so calls are recorded in an array the wallet and that object share.
  get _lastTxArgs() {
    return this._navCalls.at(-1);
  }

  async NavCreateTransaction(
    destination,
    amount,
    memo,
    password,
    subtractFee,
    fee,
    type,
  ) {
    this._navCalls.push({
      destination,
      amount,
      memo,
      password,
      subtractFee,
      fee,
      type,
      inputs: await this.GetUtxos(type),
    });
    return this._txResult;
  }

  get _lastXNavTxArgs() {
    return this._xnavCalls.at(-1);
  }

  async xNavCreateTransaction(
    destination,
    amount,
    memo,
    password,
    subtractFee,
    ...rest
  ) {
    this._xnavCalls.push({
      destination,
      amount,
      memo,
      password,
      subtractFee,
      from: rest[6],
      useFullAmount: rest[7],
    });
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
    // No UTXO db, so the balance is GetBalance as-is: only nav is swept.
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

test('cold-stake outputs are counted and swept with NAV outputs', async () => {
  const root = await makeProjectTempDir('sweep-cold-stake');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-cold-stake', type: 'mnemonic' };
    // 5 NAV cold-staked through a partner (spendable by our spending key)
    // plus 2 NAV in a plain output.
    const navWallet = makeNavWallet({
      _utxos: [
        { id: 'aa:0', type: 0x2, amount: 5_0000_0000, spendingPk: 'pk1' },
        { id: 'bb:0', type: 0x1, amount: 2_0000_0000, spendingPk: 'pk1' },
      ],
      _txResult: { tx: 'coldtx', fee: 10_000 },
      _sendResult: { hashes: ['coldhash1'], error: null },
    });
    await openSourceWallet(source, root, navWallet);

    // The UTXO-db balance lands on the coalesced refresh, not on open.
    const state = getSourceState(source.id);
    for (let i = 0; i < 40 && state.balance.nav.confirmed === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state.balance.nav.confirmed, 7_0000_0000);
    assert.equal(state.balance.staked.confirmed, 5_0000_0000);

    const preview = prepareSweep();
    assert.equal(preview.totalNav, 7_0000_0000);

    const result = await executeSweep('NDestinationAddr1');
    const lastTxArgs = state.wallet._lastTxArgs;
    assert.equal(lastTxArgs.amount, 7_0000_0000);
    // NAV | STAKED, so navcoin-js selects cold-stake outputs and sends
    // change to a plain address.
    assert.equal(lastTxArgs.type, 0x3);
    assert.equal(result.totalSent, 7_0000_0000 - 10_000);
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

// The daemon log is the only record a user can send of what a sweep did,
// and whether a transaction went out is what they need to know before
// retrying. Lines are read back from console.error, which the daemon's
// stderr writes into daemon.log.
function captureSweepLog(t) {
  const lines = [];
  const original = console.error;
  t.mock.method(console, 'error', (...args) => {
    const line = args.join(' ');
    if (line.includes('[sweep]')) lines.push(line);
    else original(...args);
  });
  return lines;
}

test('a sweep logs each leg it builds and broadcasts', async (t) => {
  const root = await makeProjectTempDir('sweep-log');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-log', type: 'mnemonic', label: 'Log' };
    await openSourceWallet(
      source,
      root,
      makeNavWallet({
        _balance: {
          nav: { confirmed: 4_0000_0000, pending: 0 },
          xnav: { confirmed: 6_0000_0000, pending: 0 },
          staked: { confirmed: 0, pending: 0 },
        },
        _txResult: { tx: 'navhex', fee: 12_000 },
        _xnavTxResult: { tx: 'xnavhex', fee: 25_000 },
        _sendResultQueue: [
          { hashes: ['nav-hash'], error: null },
          { hashes: ['xnav-hash'], error: null },
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const lines = captureSweepLog(t);
    await executeSweep('NDestinationAddr1');

    const expected = [
      /^\d{4}-\d\d-\d\dT[\d:.]+Z \[sweep\] start: destination=NDestinationAddr1 ready=1 blocked=0 force=false$/,
      /\[sweep\] src-log: nav=400000000 xnav=600000000$/,
      /\[sweep\] src-log NAV: 1 output\(s\) in 1 transaction batch\(es\)$/,
      /\[sweep\] src-log NAV: building transaction for 400000000$/,
      /\[sweep\] src-log NAV: built in \d+ms, fee=12000; broadcasting via mock-server:40004$/,
      /\[sweep\] src-log NAV: broadcast in \d+ms, hashes=nav-hash$/,
      /\[sweep\] src-log xNAV: 1 output\(s\) in 1 transaction batch\(es\)$/,
      /\[sweep\] src-log xNAV: building transaction for 600000000$/,
      /\[sweep\] src-log xNAV: built in \d+ms, fee=25000; broadcasting via mock-server:40004$/,
      /\[sweep\] src-log xNAV: broadcast in \d+ms, hashes=xnav-hash$/,
      /\[sweep\] finished: 2 transaction\(s\), sent=999963000 fee=37000$/,
    ];
    assert.equal(lines.length, expected.length, lines.join('\n'));
    expected.forEach((pattern, i) => assert.match(lines[i], pattern));

    // The transaction hex is the signed spend; it has no place in a log
    // users are asked to send.
    assert.ok(!lines.some((line) => /navhex|xnavhex/.test(line)));
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failed broadcast is logged with what already went out', async (t) => {
  const root = await makeProjectTempDir('sweep-log-fail');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: 'src-log-fail', type: 'mnemonic', label: 'Log' };
    await openSourceWallet(
      source,
      root,
      makeNavWallet({
        _balance: {
          nav: { confirmed: 4_0000_0000, pending: 0 },
          xnav: { confirmed: 6_0000_0000, pending: 0 },
          staked: { confirmed: 0, pending: 0 },
        },
        _xnavTxResult: { tx: 'xnavhex', fee: 25_000 },
        _sendResultQueue: [
          { hashes: ['nav-hash'], error: null },
          // One transaction of the leg out, the next refused.
          { hashes: ['xnav-hash-1'], error: 'server busy - request timed out' },
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const lines = captureSweepLog(t);
    await assert.rejects(
      () => executeSweep('NDestinationAddr1'),
      /xNAV broadcast failed/,
    );

    const log = lines.join('\n');
    // The NAV leg went out before the xNAV leg failed; the log has to say
    // so, because the error the user sees does not.
    assert.match(log, /src-log-fail NAV: broadcast in \d+ms, hashes=nav-hash/);
    assert.match(
      log,
      /src-log-fail xNAV: broadcast rejected after \d+ms, hashes=xnav-hash-1: server busy - request timed out/,
    );
    assert.match(log, /\[sweep\] failed: Error: xNAV broadcast failed/);
    assert.doesNotMatch(log, /finished:/);
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// One open, synced mock source per test, with the wallet options given.
async function withSweepSource(name, walletOpts, body) {
  const root = await makeProjectTempDir(`sweep-${name}`);
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = { id: `src-${name}`, type: 'mnemonic', label: name };
    await openSourceWallet(source, root, makeNavWallet(walletOpts));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await body(getSourceState(source.id));
  } finally {
    global.WebSocket = OriginalWebSocket;
    await closeAllWallets();
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// A request the server never answers: what navcoin-js's electrum client
// leaves behind when the socket closes under it.
const NEVER = new Promise(() => {});

async function untilLegStatus(status) {
  while (getSweepStatus()?.legs.at(-1)?.status !== status) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// From a user's sweep that ended in "fetch failed": the broadcast was in
// flight when the server reset the connection, the request was never
// answered, and the sweep waited on it for ever.
test('a broadcast caught by a dropped connection ends as outcome unknown', async (t) => {
  captureSweepLog(t);
  await withSweepSource('drop-send', { _sendResult: NEVER }, async (state) => {
    const sweeping = executeSweep('NDestinationAddr1', { id: 'sweep-1' });
    await untilLegStatus('broadcasting');
    state.wallet.emit('disconnected');

    await assert.rejects(sweeping, (error) => {
      assert.equal(error.code, 'SWEEP_OUTCOME_UNKNOWN');
      assert.match(error.message, /unknown outcome/);
      assert.match(error.message, /the server connection dropped/);
      assert.match(error.message, /block explorer before sweeping again/);
      return true;
    });

    const sweep = getSweepStatus();
    assert.equal(sweep.id, 'sweep-1');
    assert.equal(sweep.state, 'failed');
    assert.equal(sweep.legs.length, 1);
    assert.equal(sweep.legs[0].status, 'unknown');
    assert.ok(sweep.finishedAt);
  });
});

test('a build caught by a dropped connection broadcasts nothing', async (t) => {
  captureSweepLog(t);
  await withSweepSource('drop-build', { _txResult: NEVER }, async (state) => {
    const sweeping = executeSweep('NDestinationAddr1');
    await untilLegStatus('building');
    state.wallet.emit('disconnected');

    await assert.rejects(sweeping, (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /was not broadcast/);
      assert.match(error.message, /while the transaction was being built/);
      return true;
    });
    assert.equal(state.wallet._lastSentTx, undefined);
    assert.equal(getSweepStatus().legs[0].status, 'failed');
  });
});

// The last resort, for a server that keeps the connection open and says
// nothing: without it the sweep, and the lock that keeps a second one
// out, would be held until the daemon restarts.
test('a broadcast the server never answers times out as outcome unknown', async (t) => {
  captureSweepLog(t);
  await withSweepSource('silent-send', { _sendResult: NEVER }, async () => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sweeping = executeSweep('NDestinationAddr1');
    await untilLegStatus('broadcasting');

    t.mock.timers.tick(SWEEP_BROADCAST_TIMEOUT_MS - 1);
    assert.equal(getSweepStatus().state, 'running');
    t.mock.timers.tick(1);

    await assert.rejects(sweeping, (error) => {
      assert.equal(error.code, 'SWEEP_OUTCOME_UNKNOWN');
      assert.match(error.message, /did not answer within/);
      return true;
    });
    t.mock.timers.reset();
  });
});

test('a build the server never answers times out without broadcasting', async (t) => {
  captureSweepLog(t);
  await withSweepSource('silent-build', { _txResult: NEVER }, async (state) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sweeping = executeSweep('NDestinationAddr1');
    await untilLegStatus('building');

    t.mock.timers.tick(SWEEP_BUILD_TIMEOUT_MS);

    await assert.rejects(
      sweeping,
      /was not broadcast: the server did not answer/,
    );
    assert.equal(state.wallet._lastSentTx, undefined);
    t.mock.timers.reset();
  });
});

// A user who retries after a failed request must not start a second sweep
// over the same coins while the first is still waiting on its broadcast.
test('a second sweep is refused while one is running, and allowed after', async (t) => {
  captureSweepLog(t);
  await withSweepSource('lock', { _sendResult: NEVER }, async (state) => {
    const first = executeSweep('NDestinationAddr1', { id: 'first' });
    await untilLegStatus('broadcasting');

    await assert.rejects(executeSweep('NDestinationAddr1', { id: 'second' }), {
      code: 'SWEEP_IN_PROGRESS',
    });
    // The refused attempt must not replace the record of the running one.
    assert.equal(getSweepStatus().id, 'first');
    assert.equal(getSweepStatus().state, 'running');

    state.wallet.emit('disconnected');
    await assert.rejects(first, { code: 'SWEEP_OUTCOME_UNKNOWN' });

    // The lock goes with the sweep, even one that failed. The source has
    // just lost its connection, so this attempt fails too, but no longer
    // as a second sweep.
    await assert.rejects(executeSweep('NDestinationAddr1'), (error) => {
      assert.notEqual(error.code, 'SWEEP_IN_PROGRESS');
      return true;
    });
  });
});

// navcoin-js builds from the wallet database and then reports success
// with no transaction id when it has no client: nothing was sent.
test('a source with no connection is not reported as swept', async (t) => {
  captureSweepLog(t);
  await withSweepSource('offline', {}, async (state) => {
    state.connected = false;

    await assert.rejects(
      executeSweep('NDestinationAddr1'),
      /was not broadcast: the wallet has no server connection/,
    );
    assert.equal(state.wallet._lastSentTx, undefined);
  });
});

test('a broadcast answered with no transaction id is not a success', async (t) => {
  captureSweepLog(t);
  await withSweepSource(
    'no-hash',
    { _sendResult: { hashes: [undefined], error: undefined } },
    async () => {
      await assert.rejects(
        executeSweep('NDestinationAddr1'),
        /was not broadcast: the wallet lost its server connection/,
      );
      assert.equal(getSweepStatus().legs[0].status, 'failed');
    },
  );
});

test('a sweep that fails names the legs already broadcast', async (t) => {
  captureSweepLog(t);
  await withSweepSource(
    'partial',
    {
      _balance: {
        nav: { confirmed: 4_0000_0000, pending: 0 },
        xnav: { confirmed: 6_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _xnavTxResult: { tx: 'xnavhex', fee: 25_000 },
      _sendResultQueue: [
        { hashes: ['nav-hash'], error: null },
        { hashes: [], error: 'server busy - request timed out' },
      ],
    },
    async () => {
      await assert.rejects(executeSweep('NDestinationAddr1'), (error) => {
        assert.match(error.message, /xNAV broadcast failed/);
        assert.match(
          error.message,
          /Already broadcast before this, and not undone:\n {2}NAV from src-partial: nav-hash$/,
        );
        return true;
      });

      const sweep = getSweepStatus();
      assert.deepEqual(
        sweep.legs.map((leg) => [leg.label, leg.status, leg.hashes]),
        [
          ['NAV', 'broadcast', ['nav-hash']],
          ['xNAV', 'failed', []],
        ],
      );
      assert.match(sweep.error, /Already broadcast before this/);
    },
  );
});

test('a finished sweep is kept as the daemon status record', async (t) => {
  captureSweepLog(t);
  await withSweepSource('record', {}, async () => {
    const result = await executeSweep('NDestinationAddr1', { id: 'done-1' });

    const sweep = getSweepStatus();
    assert.equal(sweep.id, 'done-1');
    assert.equal(sweep.state, 'finished');
    assert.equal(sweep.destination, 'NDestinationAddr1');
    assert.deepEqual(sweep.result, result);
    assert.deepEqual(sweep.result.hashes, ['abc123']);
    assert.equal(sweep.legs[0].status, 'broadcast');
    assert.equal(sweep.error, null);
  });
});

// A source has no live state until its wallet is built and opened. The
// sweep looked only at live states, so sweeping while a just-imported
// phrase was still being built, or after a wallet failed to build, swept
// the others and reported success with that source nowhere in sight.
test('a registered source with no open wallet blocks the sweep', async (t) => {
  captureSweepLog(t);
  await withSweepSource('registered', {}, async (state) => {
    const registered = [
      { id: state.sourceId },
      { id: 'still-building', walletType: 'navpay' },
      { id: 'never-built', walletType: 'next', error: 'worker timed out' },
    ];

    assert.throws(
      () => prepareSweep({ registered }),
      (error) => {
        assert.match(error.message, /^2 of 3 sources are not ready to sweep:/);
        assert.match(
          error.message,
          /still-building \(navpay\) — wallet not opened yet/,
        );
        assert.match(
          error.message,
          /never-built \(next\) — wallet could not be opened: worker timed out/,
        );
        return true;
      },
    );
    await assert.rejects(
      executeSweep('NDestinationAddr1', { registered }),
      /2 source\(s\) are not ready to sweep/,
    );
    assert.equal(state.wallet._lastSentTx, undefined);

    // Forced, it sweeps what is ready and names what it left out.
    const preview = prepareSweep({ force: true, registered });
    assert.deepEqual(
      preview.sources.map((source) => source.sourceId),
      [state.sourceId],
    );
    assert.deepEqual(
      preview.skipped.map((source) => [source.sourceId, source.walletType]),
      [
        ['still-building', 'navpay'],
        ['never-built', 'next'],
      ],
    );
    const result = await executeSweep('NDestinationAddr1', {
      force: true,
      registered,
    });
    assert.deepEqual(result.hashes, ['abc123']);
  });
});

test('registered sources with no wallet open at all are not "no sources"', async () => {
  const registered = [{ id: 'still-building', walletType: 'navpay' }];

  assert.throws(
    () => prepareSweep({ registered }),
    /Error: 1 of 1 sources are not ready to sweep:/,
  );
  assert.throws(
    () => prepareSweep({ force: true, registered }),
    /No source is ready to sweep/,
  );
  assert.throws(() => prepareSweep(), /No imported sources/);
});

// Spendable outputs for the fake wallet: `nav` and `xnav` are lists of
// amounts, each becoming one output.
function spendableOutputs({ nav = [], xnav = [] }) {
  const build = (amounts, prefix) =>
    amounts.map((amount, index) => ({
      txid: `${prefix}${index}`,
      vout: 0,
      amount,
      output: { satoshis: amount },
    }));
  const navOutputs = build(nav, 'nav');
  const xnavOutputs = build(xnav, 'xnav');
  return (type) => (type === 0x4 ? xnavOutputs : navOutputs);
}

const outpointsOf = (outputs) => outputs.map((o) => `${o.txid}:${o.vout}`);

test('a NAV leg with more outputs than one batch goes out in several', async (t) => {
  captureSweepLog(t);
  const amounts = Array.from(
    { length: NAV_BATCH_INPUTS * 2 + 1 },
    (_, index) => 1_0000_0000 + index,
  );
  const total = amounts.reduce((sum, amount) => sum + amount, 0);

  await withSweepSource(
    'nav-batches',
    {
      _balance: {
        nav: { confirmed: total, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _spendable: spendableOutputs({ nav: amounts }),
      _txResult: { tx: 'navhex', fee: NAV_TX_FEE },
      _sendResultQueue: [
        { hashes: ['nav-1'], error: null },
        { hashes: ['nav-2'], error: null },
        { hashes: ['nav-3'], error: null },
      ],
    },
    async (state) => {
      const result = await executeSweep('NDestinationAddr1');

      const calls = state.wallet._navCalls;
      assert.equal(calls.length, 3);
      for (const call of calls) {
        assert.ok(call.inputs.length <= NAV_BATCH_INPUTS);
        assert.equal(call.fee, NAV_TX_FEE);
        assert.equal(call.subtractFee, true);
        // Each transaction is asked to send exactly what its inputs hold.
        assert.equal(
          call.amount,
          call.inputs.reduce((sum, o) => sum + o.amount, 0),
        );
      }
      // Every output is spent, and none twice.
      const spent = calls.flatMap((call) => outpointsOf(call.inputs));
      assert.equal(spent.length, amounts.length);
      assert.equal(new Set(spent).size, amounts.length);

      assert.deepEqual(result.hashes, ['nav-1', 'nav-2', 'nav-3']);
      assert.equal(result.totalFee, 3 * NAV_TX_FEE);
      assert.equal(result.totalSent, total - 3 * NAV_TX_FEE);
      assert.deepEqual(result.leftBehind, []);
      assert.deepEqual(
        getSweepStatus().legs.map((leg) => [leg.label, leg.status]),
        [
          ['NAV 1/3', 'broadcast'],
          ['NAV 2/3', 'broadcast'],
          ['NAV 3/3', 'broadcast'],
        ],
      );
    },
  );
});

test('an xNAV leg is batched by outpoint and leaves dust behind', async (t) => {
  const lines = captureSweepLog(t);
  const dust = [XNAV_FEE_PER_ELEMENT, 1];
  const worth = Array.from(
    { length: XNAV_BATCH_INPUTS + 1 },
    (_, index) => 1_0000_0000 + index,
  );
  const sum = (list) => list.reduce((total, amount) => total + amount, 0);

  await withSweepSource(
    'xnav-batches',
    {
      _balance: {
        nav: { confirmed: 0, pending: 0 },
        xnav: { confirmed: sum(worth) + sum(dust), pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _spendable: spendableOutputs({ xnav: [...dust, ...worth] }),
      _xnavTxResult: { tx: 'xnavhex', fee: 1_000_000 },
      _sendResultQueue: [
        { hashes: ['xnav-1'], error: null },
        { hashes: ['xnav-2'], error: null },
      ],
    },
    async (state) => {
      const result = await executeSweep('NDestinationAddr1');

      const calls = state.wallet._xnavCalls;
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.ok(call.from.length <= XNAV_BATCH_INPUTS);
        assert.equal(call.useFullAmount, true);
      }
      const spent = calls.flatMap((call) => call.from);
      assert.equal(spent.length, worth.length);
      assert.equal(new Set(spent).size, worth.length);
      // xnav0 and xnav1 are the dust outputs.
      assert.ok(!spent.includes('xnav0:0') && !spent.includes('xnav1:0'));
      assert.equal(sum(calls.map((call) => call.amount)), sum(worth));

      assert.deepEqual(result.leftBehind, [
        {
          sourceId: 'src-xnav-batches',
          walletType: null,
          coin: 'xNAV',
          reason: LEFT_TOO_SMALL,
          amount: sum(dust),
        },
      ]);
      assert.ok(
        lines.some((line) =>
          line.includes(
            `xNAV: ${sum(dust)} left behind, ${dust.length} output(s) too small`,
          ),
        ),
      );
    },
  );
});

test('a batch that fails stops the leg and names the batches before it', async (t) => {
  captureSweepLog(t);
  const amounts = Array.from(
    { length: NAV_BATCH_INPUTS * 2 + 1 },
    () => 1_0000_0000,
  );

  await withSweepSource(
    'batch-fails',
    {
      _balance: {
        nav: { confirmed: amounts.length * 1_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _spendable: spendableOutputs({ nav: amounts }),
      _sendResultQueue: [
        { hashes: ['nav-1'], error: null },
        { hashes: [], error: 'server busy - request timed out' },
      ],
    },
    async (state) => {
      await assert.rejects(executeSweep('NDestinationAddr1'), (error) => {
        assert.match(error.message, /NAV 2\/3 broadcast failed/);
        assert.match(
          error.message,
          /not undone:\n {2}NAV 1\/3 from src-batch-fails: nav-1$/,
        );
        return true;
      });
      // The third batch is never built.
      assert.equal(state.wallet._navCalls.length, 2);
    },
  );
});

test('a balance the wallet cannot spend yet is reported, not dropped', async (t) => {
  const lines = captureSweepLog(t);
  await withSweepSource(
    'immature',
    {
      _balance: {
        nav: { confirmed: 7_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      // navcoin-js lists 5 of the 7 as spendable.
      _spendable: spendableOutputs({ nav: [5_0000_0000] }),
      _txResult: { tx: 'navhex', fee: NAV_TX_FEE },
    },
    async (state) => {
      const result = await executeSweep('NDestinationAddr1');

      assert.equal(state.wallet._lastTxArgs.amount, 5_0000_0000);
      assert.equal(result.totalSent, 5_0000_0000 - NAV_TX_FEE);
      assert.deepEqual(result.leftBehind, [
        {
          sourceId: 'src-immature',
          walletType: null,
          coin: 'NAV',
          reason: LEFT_NOT_SPENDABLE,
          amount: 2_0000_0000,
        },
      ]);
      assert.ok(
        lines.some((line) =>
          line.includes('NAV: 200000000 left behind, not spendable yet'),
        ),
      );
    },
  );
});

test('a source with nothing spendable broadcasts nothing and says so', async (t) => {
  captureSweepLog(t);
  await withSweepSource(
    'all-immature',
    {
      _balance: {
        nav: { confirmed: 3_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      },
      _spendable: spendableOutputs({}),
    },
    async (state) => {
      const result = await executeSweep('NDestinationAddr1');

      assert.equal(state.wallet._navCalls.length, 0);
      assert.deepEqual(result.hashes, []);
      assert.equal(result.leftBehind[0].amount, 3_0000_0000);
      assert.equal(result.leftBehind[0].reason, LEFT_NOT_SPENDABLE);
    },
  );
});
