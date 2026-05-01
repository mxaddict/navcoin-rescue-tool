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
} from '../src/wallet-manager.js';
import { makeProjectTempDir } from './test-helpers.js';

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

  Disconnect() {}
  CloseDb() {}
}

function makeMockNavWallet() {
  return { WalletFile: MockWalletFile };
}

test('wallet manager tracks sync state and exposes addresses/balance', async () => {
  const root = await makeProjectTempDir('wallet-mgr');

  try {
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
    await fs.rm(root, { recursive: true, force: true });
  }
});
