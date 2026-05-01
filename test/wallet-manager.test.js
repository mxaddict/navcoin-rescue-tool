import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import {
  openSourceWallet,
  closeSourceWallet,
  getAllSourceStates,
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
    this._loaded = false;
  }

  async Load() {
    this._loaded = true;
    this.emit('db_open');
  }

  async Connect() {
    this.emit('connected', 'mock-server:40004');
    this.emit('sync_started');
    this.emit('sync_status', 50, 5, 10);
    this.emit('sync_status', 100, 0, 10);
    this.emit('sync_finished');
  }

  async NavReceivingAddresses() {
    return [
      { address: 'NTestAddr1', path: "m/44'/130'/0'/0/0", used: 0 },
      { address: 'NTestAddr2', path: "m/44'/130'/0'/0/1", used: 1 },
    ];
  }

  async GetBalance() {
    return {
      nav: { confirmed: 5_0000_0000, pending: 0 },
      xnav: { confirmed: 0, pending: 0 },
      staked: { confirmed: 1_0000_0000, pending: 0 },
    };
  }

  ClearNodeList() {
    this.electrumNodes = [];
  }

  AddNode(host, port, proto) {
    this.electrumNodes.push({ host, port, proto });
  }

  Disconnect() {}
  CloseDb() {}
  SyncUtxos() {
    return Promise.resolve();
  }
}

function makeMockNavWallet() {
  return { WalletFile: MockWalletFile };
}

test('wallet manager tracks sync state and exposes addresses/balance', async () => {
  const root = await makeProjectTempDir('wallet-mgr');
  const OriginalWebSocket = global.WebSocket;

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = {
      id: 'test-source-01',
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
      label: 'Test',
    };

    await openSourceWallet(source, root, makeMockNavWallet());

    // Allow async wallet events to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = getSourceState(source.id);
    assert.ok(state, 'state should exist');
    assert.equal(state.syncStatus, 'synced');
    assert.equal(state.syncProgress, 100);
    assert.equal(state.connected, true);
    assert.equal(state.server, 'mock-server:40004');
    assert.equal(state.addresses.length, 2);
    assert.equal(state.addresses[0].address, 'NTestAddr1');
    assert.equal(state.addresses[1].used, true);
    assert.equal(state.balance.nav.confirmed, 5_0000_0000);
    assert.equal(state.balance.staked.confirmed, 1_0000_0000);

    const all = getAllSourceStates();
    assert.equal(all.length, 1);
    assert.equal(all[0].sourceId, source.id);

    await closeSourceWallet(source.id);
    assert.equal(getSourceState(source.id), null);
  } finally {
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('wallet manager rotates electrum node on reconnect attempts', async () => {
  const root = await makeProjectTempDir('wallet-mgr-reconnect');
  const OriginalWebSocket = global.WebSocket;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  class ReconnectWalletFile extends EventEmitter {
    constructor() {
      super();
      this.electrumNodes = [];
      this.electrumNodeIndex = 0;
      this.connectIndices = [];
    }

    async Load() {}

    async Connect() {
      this.connectIndices.push(this.electrumNodeIndex);
      this.emit(
        'connected',
        `${this.electrumNodes[this.electrumNodeIndex].host}:40004`,
      );
    }

    async NavReceivingAddresses() {
      return [];
    }

    async GetBalance() {
      return {
        nav: { confirmed: 0, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      };
    }

    ClearNodeList() {
      this.electrumNodes = [];
    }

    AddNode(host, port, proto) {
      this.electrumNodes.push({ host, port, proto });
    }

    Disconnect() {}
    CloseDb() {}
    SyncUtxos() {
      return Promise.resolve();
    }
  }

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    global.setTimeout = (fn) => {
      queueMicrotask(fn);
      return 1;
    };
    global.clearTimeout = () => {};
    resetElectrumNodeSelectionCache();

    await bootstrapAppData(root);

    const source = {
      id: 'test-source-rotate',
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
    };

    await openSourceWallet(source, root, { WalletFile: ReconnectWalletFile });

    const state = getSourceState(source.id);
    state.wallet.emit('disconnected');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(state.wallet.connectIndices, [0, 1]);

    await closeSourceWallet(source.id);
  } finally {
    global.WebSocket = OriginalWebSocket;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('wallet manager prefers healthy electrum nodes before connect', async () => {
  const root = await makeProjectTempDir('wallet-mgr-electrum-select');
  const OriginalWebSocket = global.WebSocket;

  class ProbeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      queueMicrotask(() => {
        const event = this.url.includes('electrum3.nav.community')
          ? 'open'
          : 'error';
        this.listeners.get(event)?.forEach((listener) => listener());
      });
    }

    addEventListener(event, listener) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    close() {}
  }

  class NodeListWalletFile extends EventEmitter {
    constructor() {
      super();
      this.electrumNodes = [{ host: 'default', port: 1, proto: 'wss' }];
      this.electrumNodeIndex = 0;
      this.connectedTo = null;
    }

    async Load() {}

    ClearNodeList() {
      this.electrumNodes = [];
    }

    AddNode(host, port, proto) {
      this.electrumNodes.push({ host, port, proto });
    }

    async Connect() {
      this.connectedTo = this.electrumNodes[this.electrumNodeIndex].host;
      this.emit('connected', `${this.connectedTo}:40004`);
      this.emit('sync_finished');
    }

    async NavReceivingAddresses() {
      return [];
    }

    async GetBalance() {
      return {
        nav: { confirmed: 0, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      };
    }

    Disconnect() {}
    CloseDb() {}
    SyncUtxos() {
      return Promise.resolve();
    }
  }

  try {
    global.WebSocket = ProbeWebSocket;
    resetElectrumNodeSelectionCache();

    await bootstrapAppData(root);

    const source = {
      id: 'test-source-electrum-select',
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
    };

    await openSourceWallet(source, root, { WalletFile: NodeListWalletFile });

    const state = getSourceState(source.id);
    assert.equal(state.wallet.connectedTo, 'electrum3.nav.community');
    assert.equal(state.wallet.electrumNodes[0].host, 'electrum3.nav.community');

    await closeSourceWallet(source.id);
  } finally {
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('wallet manager hides dummy pool addresses for private-key sources', async () => {
  const root = await makeProjectTempDir('wallet-mgr-private-key');
  const OriginalWebSocket = global.WebSocket;

  class PrivateKeyWalletFile extends EventEmitter {
    constructor() {
      super();
      this.electrumNodes = [];
      this.electrumNodeIndex = 0;
      this.keys = [];
      this.db = {
        db: {
          keys: {
            where: (field) => {
              assert.equal(field, 'type');
              return {
                equals: (value) => {
                  assert.equal(value, 1);
                  return {
                    filter: (predicate) => ({
                      delete: async () => {
                        this.keys = this.keys.filter((key) => !predicate(key));
                      },
                    }),
                  };
                },
              };
            },
          },
        },
      };
    }

    async Load() {
      this.keys = [
        ...Array.from({ length: 10 }, (_, i) => ({
          type: 1,
          address: `dummy-${i}`,
          path: `m/44'/130'/0'/0/${i}`,
          used: 0,
        })),
        {
          type: 1,
          address: 'imported-addr',
          path: 'imported',
          used: 0,
        },
      ];
    }

    ClearNodeList() {
      this.electrumNodes = [];
    }

    AddNode(host, port, proto) {
      this.electrumNodes.push({ host, port, proto });
    }

    async Connect() {
      this.emit('connected', 'mock-server:40004');
      this.emit('sync_finished');
    }

    async NavReceivingAddresses() {
      return this.keys;
    }

    async GetBalance() {
      return {
        nav: { confirmed: 0, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      };
    }

    Disconnect() {}
    CloseDb() {}
    SyncUtxos() {
      return Promise.resolve();
    }
  }

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = {
      id: 'test-source-private-key',
      type: 'private-key',
      walletType: null,
    };

    await openSourceWallet(source, root, { WalletFile: PrivateKeyWalletFile });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = getSourceState(source.id);
    assert.equal(state.addresses.length, 1);
    assert.equal(state.addresses[0].path, 'imported');

    await closeSourceWallet(source.id);
  } finally {
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
