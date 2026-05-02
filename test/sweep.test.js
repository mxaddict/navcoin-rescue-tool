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

  async SendTransaction(tx) {
    this._lastSentTx = tx;
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
