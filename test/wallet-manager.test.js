import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import {
  openSourceWallet,
  closeSourceWallet,
  closeAllWallets,
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
    this.loadOptions = null;
    this.db = {
      GetUtxos: async () => {
        throw new Error('mock: no UTXO db');
      },
    };
  }

  async Load(options) {
    this._loaded = true;
    this.loadOptions = options;
    this.emit('db_open');
  }

  async Connect() {
    this.emit('connected', 'mock-server:40004');
    queueMicrotask(() => {
      this.emit('bootstrap_started');
      this.emit('scripthash_progress', 10, 10);
      this.emit('sync_finished');
    });
  }

  async NavReceivingAddresses() {
    return [
      { address: 'NTestAddr1', path: "m/44'/130'/0'/0/0", used: 0 },
      { address: 'NTestAddr2', path: "m/44'/130'/0'/0/1", used: 1 },
    ];
  }

  async xNavReceivingAddresses() {
    return [];
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
    assert.equal(state.wallet.loadOptions.minPoolSize, 10);
    assert.equal(state.balance.nav.confirmed, 5_0000_0000);
    assert.equal(state.balance.staked.confirmed, 1_0000_0000);

    const all = getAllSourceStates();
    assert.equal(all.length, 1);
    assert.equal(all[0].sourceId, source.id);

    await closeSourceWallet(source.id);
    assert.equal(getSourceState(source.id), null);
  } finally {
    await closeAllWallets();
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
      this.db = {
        GetUtxos: async () => {
          throw new Error('mock: no UTXO db');
        },
      };
    }

    async Load() {}

    async Connect() {
      this.connectIndices.push(this.electrumNodeIndex);
      this.emit(
        'connected',
        `${this.electrumNodes[this.electrumNodeIndex].host}:40004`,
      );
      queueMicrotask(() => {
        this.emit('bootstrap_started');
        this.emit('sync_finished');
      });
    }

    async NavReceivingAddresses() {
      return [];
    }

    async xNavReceivingAddresses() {
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
    await closeAllWallets();
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
      this.db = {
        GetUtxos: async () => {
          throw new Error('mock: no UTXO db');
        },
      };
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
      queueMicrotask(() => {
        this.emit('bootstrap_started');
        this.emit('sync_finished');
      });
    }

    async NavReceivingAddresses() {
      return [];
    }

    async xNavReceivingAddresses() {
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
    await closeAllWallets();
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('wallet manager transitions through connecting then syncing then synced', async () => {
  const root = await makeProjectTempDir('wallet-mgr-sync-states');
  const OriginalWebSocket = global.WebSocket;

  class StagedWalletFile extends EventEmitter {
    constructor() {
      super();
      this.electrumNodes = [];
      this.electrumNodeIndex = 0;
      this.db = {
        GetUtxos: async () => {
          throw new Error('mock');
        },
      };
    }

    async Load() {
      this.emit('db_open');
    }

    async Connect() {
      this.emit('connected', 'mock-server:40004');
    }

    async NavReceivingAddresses() {
      return [];
    }

    async xNavReceivingAddresses() {
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
  }

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = {
      id: 'test-source-sync-states',
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
      label: 'Sync States Test',
    };

    await openSourceWallet(source, root, { WalletFile: StagedWalletFile });
    const state = getSourceState(source.id);

    // Connect emits 'connected' synchronously; flush microtasks.
    await new Promise((r) => setImmediate(r));
    const s1 = state.syncStatus;

    // scripthash_progress drives the 'syncing' transition.
    state.wallet.emit('scripthash_progress', 5, 10);
    await new Promise((r) => setImmediate(r));
    const s2 = state.syncStatus;

    state.wallet.emit('sync_finished');
    await new Promise((r) => setImmediate(r));
    const s3 = state.syncStatus;

    assert.equal(s1, 'connected');
    assert.equal(s2, 'syncing');
    assert.equal(s3, 'synced');

    await closeSourceWallet(source.id);
  } finally {
    await closeAllWallets();
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('wallet manager lists every address with correct per-address balance', async () => {
  const root = await makeProjectTempDir('wallet-mgr-addr-balance');
  const OriginalWebSocket = global.WebSocket;

  const OUT_XNAV = 0x4;

  class AddressBalanceWalletFile extends EventEmitter {
    constructor() {
      super();
      this.electrumNodes = [];
      this.electrumNodeIndex = 0;
      this.db = {
        GetUtxos: async () => [
          { spendingPk: 'pk1', amount: 1_0000_0000, type: 0, spentIn: null },
          { spendingPk: 'pk2', amount: 2_5000_0000, type: 0, spentIn: null },
          {
            spendingPk: 'pk2',
            amount: 9_0000_0000,
            type: 0,
            spentIn: 'some-tx',
          },
          { hashId: 'xh1', amount: 5_0000_0000, type: OUT_XNAV, spentIn: null },
        ],
      };
    }

    async Load() {}

    ClearNodeList() {
      this.electrumNodes = [];
    }

    AddNode(host, port, proto) {
      this.electrumNodes.push({ host, port, proto });
    }

    async Connect() {
      this.emit('connected', 'mock-server:40004');
      queueMicrotask(() => {
        this.emit('bootstrap_started');
        this.emit('sync_finished');
      });
    }

    async NavReceivingAddresses() {
      return [
        { address: 'addr1', hash: 'pk1', path: "m/44'/130'/0'/0/0", used: 0 },
        { address: 'addr2', hash: 'pk2', path: "m/44'/130'/0'/0/1", used: 1 },
        { address: 'addr3', hash: 'pk3', path: "m/44'/130'/0'/0/2", used: 0 },
      ];
    }

    async xNavReceivingAddresses() {
      return [
        { address: 'xaddr1', hash: 'xh1', path: "m/44'/130'/0'/0/0", used: 0 },
      ];
    }

    async GetBalance() {
      return {
        nav: { confirmed: 3_5000_0000, pending: 0 },
        xnav: { confirmed: 5_0000_0000, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      };
    }

    Disconnect() {}
    CloseDb() {}
  }

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const source = {
      id: 'test-source-addr-balance',
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
      label: 'AddrBalance',
    };

    await openSourceWallet(source, root, {
      WalletFile: AddressBalanceWalletFile,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = getSourceState(source.id);
    assert.ok(state, 'state should exist');

    assert.equal(state.addresses.length, 4);

    const addrSet = new Set(state.addresses.map((a) => a.address));
    assert.ok(addrSet.has('addr1'));
    assert.ok(addrSet.has('addr2'));
    assert.ok(addrSet.has('addr3'));
    assert.ok(addrSet.has('xaddr1'));
    assert.equal(addrSet.size, 4);

    const byAddr = Object.fromEntries(
      state.addresses.map((a) => [a.address, a]),
    );

    assert.equal(byAddr['addr1'].balance, 1_0000_0000);
    assert.equal(byAddr['addr2'].balance, 2_5000_0000);
    assert.equal(byAddr['addr3'].balance, 0);
    assert.equal(byAddr['xaddr1'].balance, 5_0000_0000);

    const total = state.addresses.reduce((acc, a) => acc + a.balance, 0);
    assert.equal(total, 8_5000_0000);

    assert.equal(byAddr['addr1'].isXNav, false);
    assert.equal(byAddr['xaddr1'].isXNav, true);
    assert.equal(byAddr['addr2'].used, true);

    await closeSourceWallet(source.id);
  } finally {
    await closeAllWallets();
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('wallet manager isolates state and address lists per source', async () => {
  const root = await makeProjectTempDir('wallet-mgr-isolation');
  const OriginalWebSocket = global.WebSocket;

  const addrA1 = 'NSourceAAddr1';
  const addrA2 = 'NSourceAAddr2';
  const addrB1 = 'NSourceBAddr1';

  class IsolationWalletFileA extends EventEmitter {
    constructor() {
      super();
      this.db = {
        GetUtxos: async () => {
          throw new Error('mock');
        },
      };
    }

    async Load() {
      this.emit('db_open');
    }

    async Connect() {
      this.emit('connected', 'mock-server-a:40004');
      queueMicrotask(() => {
        this.emit('scripthash_progress', 2, 2);
        this.emit('sync_finished');
      });
    }

    async NavReceivingAddresses() {
      return [
        { address: addrA1, path: "m/44'/130'/0'/0/0", used: 0 },
        { address: addrA2, path: "m/44'/130'/0'/0/1", used: 1 },
      ];
    }

    async xNavReceivingAddresses() {
      return [];
    }

    async GetBalance() {
      return {
        nav: { confirmed: 1_0000_0000, pending: 0 },
        xnav: { confirmed: 0, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      };
    }

    ClearNodeList() {
      this.electrumNodes = [];
    }

    AddNode(host, port, proto) {
      this.electrumNodes = this.electrumNodes ?? [];
      this.electrumNodes.push({ host, port, proto });
    }

    Disconnect() {}
    CloseDb() {}
  }

  class IsolationWalletFileB extends EventEmitter {
    constructor() {
      super();
      this.db = {
        GetUtxos: async () => {
          throw new Error('mock');
        },
      };
    }

    async Load() {
      this.emit('db_open');
    }

    async Connect() {
      this.emit('connected', 'mock-server-b:40004');
      queueMicrotask(() => {
        this.emit('scripthash_progress', 1, 1);
        this.emit('sync_finished');
      });
    }

    async NavReceivingAddresses() {
      return [{ address: addrB1, path: "m/44'/130'/0'/0/0", used: 0 }];
    }

    async xNavReceivingAddresses() {
      return [];
    }

    async GetBalance() {
      return {
        nav: { confirmed: 5_0000_0000, pending: 0 },
        xnav: { confirmed: 0, pending: 0 },
        staked: { confirmed: 0, pending: 0 },
      };
    }

    ClearNodeList() {
      this.electrumNodes = [];
    }

    AddNode(host, port, proto) {
      this.electrumNodes = this.electrumNodes ?? [];
      this.electrumNodes.push({ host, port, proto });
    }

    Disconnect() {}
    CloseDb() {}
  }

  try {
    global.WebSocket = AlwaysOpenWebSocket;
    resetElectrumNodeSelectionCache();
    await bootstrapAppData(root);

    const sourceA = {
      id: 'src-iso-a',
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
    };
    const sourceB = {
      id: 'src-iso-b',
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
    };

    await openSourceWallet(sourceA, root, { WalletFile: IsolationWalletFileA });
    await openSourceWallet(sourceB, root, { WalletFile: IsolationWalletFileB });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(getAllSourceStates().length, 2);

    const stateA = getSourceState('src-iso-a');
    assert.ok(stateA);
    assert.equal(stateA.addresses.length, 2);
    const addrSetA = new Set(stateA.addresses.map((a) => a.address));
    assert.ok(addrSetA.has(addrA1));
    assert.ok(addrSetA.has(addrA2));

    const stateB = getSourceState('src-iso-b');
    assert.ok(stateB);
    assert.equal(stateB.addresses.length, 1);
    const addrSetB = new Set(stateB.addresses.map((a) => a.address));
    assert.ok(addrSetB.has(addrB1));

    assert.equal(stateA.balance.nav.confirmed, 1_0000_0000);
    assert.equal(stateB.balance.nav.confirmed, 5_0000_0000);

    for (const addr of addrSetA) {
      assert.ok(!addrSetB.has(addr));
    }
    for (const addr of addrSetB) {
      assert.ok(!addrSetA.has(addr));
    }

    await closeSourceWallet('src-iso-a');

    assert.equal(getSourceState('src-iso-a'), null);
    assert.ok(getSourceState('src-iso-b') !== null);
    assert.equal(getSourceState('src-iso-b').addresses.length, 1);
  } finally {
    await closeAllWallets();
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
        GetUtxos: async () => {
          throw new Error('mock: no UTXO db');
        },
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
      queueMicrotask(() => {
        this.emit('bootstrap_started');
        this.emit('sync_finished');
      });
    }

    async NavReceivingAddresses() {
      return this.keys;
    }

    async xNavReceivingAddresses() {
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
    await closeAllWallets();
    global.WebSocket = OriginalWebSocket;
    resetElectrumNodeSelectionCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
