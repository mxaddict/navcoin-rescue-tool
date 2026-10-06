// Node choice and failover timing, with a scripted wallet in place of
// navcoin-js. electrum-failover.test.js shows the same behaviour against
// the real library; these pin the parts that need exact timing or many
// wallets, which the stub servers cannot give cheaply.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test, { mock } from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { CONNECT_ATTEMPT_TIMEOUT_MS } from '../src/electrum-connection.js';
import {
  closeAllWallets,
  FAILOVER_DELAY_MS,
  getSourceState,
  openSourceWallet,
  resetElectrumNodeSelectionCache,
} from '../src/wallet-manager.js';
import { makeProjectTempDir } from './test-helpers.js';

const NODES = ['node-a', 'node-b', 'node-c'];

// Answers per host the way navcoin-js does: 'connected' once the server
// is up, 'connection_failed' for a refused socket, nothing at all for a
// server that accepts the socket and never replies.
class ScriptedWalletFile extends EventEmitter {
  static behaviour = new Map();

  constructor() {
    super();
    this.electrumNodes = [];
    this.electrumNodeIndex = 0;
    this.attempts = [];
    this.db = {
      GetUtxos: async () => {
        throw new Error('scripted: no UTXO db');
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
    const { host } = this.electrumNodes[this.electrumNodeIndex];
    this.attempts.push(host);
    const behaviour = ScriptedWalletFile.behaviour.get(host) ?? 'up';
    queueMicrotask(() => {
      if (behaviour === 'up') this.emit('connected', `${host}:40004`);
      if (behaviour === 'refuses') {
        this.emit('disconnected');
        this.emit('connection_failed');
      }
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

let root;
let sourceCounter = 0;

test.beforeEach(async () => {
  root = await makeProjectTempDir('electrum-connection');
  await bootstrapAppData(root);
  resetElectrumNodeSelectionCache();
  ScriptedWalletFile.behaviour.clear();
  process.env.NTR_ELECTRUM_NODES = NODES.map((h) => `${h}:40004:wss`).join(',');
});

test.afterEach(async () => {
  mock.timers.reset();
  await closeAllWallets();
  resetElectrumNodeSelectionCache();
  delete process.env.NTR_ELECTRUM_NODES;
  await fs.rm(root, { recursive: true, force: true });
});

function openWallet() {
  sourceCounter += 1;
  const source = {
    id: `scripted-${sourceCounter}`,
    type: 'mnemonic',
    lastSyncedAt: new Date().toISOString(),
  };
  const opening = openSourceWallet(source, root, {
    WalletFile: ScriptedWalletFile,
  });
  return { id: source.id, opening };
}

// Timers are mocked; the promise chains between them still need turns.
async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('disconnect events during an outage do not postpone failover', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });

  const { id, opening } = openWallet();
  await settle();
  const state = await opening;
  assert.equal(state.server, 'node-a:40004');

  // The drop, then the errors the dying client keeps producing for as long
  // as it is attached — right up to the moment failover replaces it. Had
  // any of them pushed the failover back, it would not have run yet.
  ScriptedWalletFile.behaviour.set('node-a', 'refuses');
  state.wallet.emit('disconnected');
  const step = FAILOVER_DELAY_MS / 10;
  for (let elapsed = step; elapsed < FAILOVER_DELAY_MS; elapsed += step) {
    mock.timers.tick(step);
    state.wallet.emit('disconnected');
    state.wallet.emit('connection_failed');
    await settle();
  }
  assert.deepEqual(state.wallet.attempts, ['node-a'], 'not before the delay');

  mock.timers.tick(step);
  await settle();

  assert.equal(getSourceState(id).server, 'node-b:40004');
  assert.deepEqual(state.wallet.attempts, ['node-a', 'node-b']);
});

test('a node that never answers is given up after the attempt timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  ScriptedWalletFile.behaviour.set('node-a', 'silent');

  const { opening } = openWallet();
  await settle();
  const state = getSourceState(`scripted-${sourceCounter}`);

  mock.timers.tick(CONNECT_ATTEMPT_TIMEOUT_MS - 1);
  await settle();
  assert.equal(state.connected, false, 'still waiting on the first node');
  assert.deepEqual(state.wallet.attempts, ['node-a']);

  mock.timers.tick(1);
  await settle();
  await opening;

  assert.equal(state.server, 'node-b:40004');
  assert.deepEqual(state.wallet.attempts, ['node-a', 'node-b']);
});

test('a refused node is skipped at once, without waiting out the timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  ScriptedWalletFile.behaviour.set('node-a', 'refuses');
  ScriptedWalletFile.behaviour.set('node-b', 'refuses');

  const { opening } = openWallet();
  await settle();
  const state = await opening;

  assert.equal(state.server, 'node-c:40004');
  assert.deepEqual(state.wallet.attempts, ['node-a', 'node-b', 'node-c']);
});

// Wallets are spread across nodes so one phrase's derivations do not all
// hammer one server, but a node the probe found dead is no place to start.
test('wallets are not started on a node the probe found dead', async () => {
  delete process.env.NTR_ELECTRUM_NODES;
  const OriginalWebSocket = global.WebSocket;
  const deadHost = 'electrum2.nav.community';

  class ProbeWebSocket {
    constructor(url) {
      this.listeners = new Map();
      queueMicrotask(() => {
        const event = url.includes(deadHost) ? 'error' : 'open';
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

  try {
    global.WebSocket = ProbeWebSocket;

    const started = [];
    let nodeCount = 0;
    for (let i = 0; i < 8; i += 1) {
      const { opening } = openWallet();
      const state = await opening;
      nodeCount = state.wallet.electrumNodes.length;
      started.push(state.wallet.attempts[0]);
    }

    assert.ok(
      !started.includes(deadHost),
      `no wallet starts on the dead node, got ${JSON.stringify(started)}`,
    );
    assert.equal(
      new Set(started).size,
      nodeCount - 1,
      'every healthy node is used',
    );
  } finally {
    global.WebSocket = OriginalWebSocket;
  }
});
