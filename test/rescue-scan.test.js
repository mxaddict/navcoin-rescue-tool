import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { rescueScan } from '../src/rescue-scan.js';

const ADDRESSES = [
  { address: 'addr-one', path: "m/44'/130'/0'/0/0", change: false },
  { address: 'addr-two', path: "m/44'/130'/0'/0/1", change: false },
];

// A wallet with one address holding a live UTXO and one address whose
// lookup can be made to fail, plus a second UTXO in the db that the
// chain no longer reports as unspent.
class FakeWallet extends EventEmitter {
  constructor({ failing = null } = {}) {
    super();
    this.spendingPassword = 'password';
    this.mvk = null; // no xNAV keys — skips the xNAV pass
    this.spent = [];

    const utxos = [
      { id: 'live-tx:0', spentIn: null },
      { id: 'gone-tx:0', spentIn: null },
    ];

    this.client = {
      blockchain_scripthash_getHistory: async (sh) => {
        if (sh === failing) throw new Error('electrum connection reset');
        return [{ tx_hash: 'live-tx', height: 10 }];
      },
      blockchain_scripthash_listunspent: async (sh) => {
        if (sh === failing) throw new Error('electrum connection reset');
        return sh === 'sh:addr-one'
          ? [{ tx_hash: 'live-tx', tx_pos: 0, height: 10 }]
          : [];
      },
      blockchain_staking_getKeys: async () => [],
    };

    this.db = {
      GetNavReceivingAddresses: async () => ADDRESSES,
      GetNavAddresses: async () => [],
      GetUtxos: async () => utxos,
      SpendUtxo: async (id, reason) => {
        this.spent.push({ id, reason });
        const utxo = utxos.find((u) => u.id === id);
        if (utxo) utxo.spentIn = reason;
      },
    };
  }

  AddressToScriptHash(address) {
    return `sh:${address}`;
  }

  async GetStakingAddresses() {
    return [];
  }

  async GetTx() {
    // Hydration is not what these tests are about; skipping the decode
    // path leaves the outpoint recorded as seen, which is what matters.
    return null;
  }
}

test('a clean scan reaps UTXOs the chain no longer reports as unspent', async () => {
  const wallet = new FakeWallet();

  await rescueScan(wallet, { skipDerive: true });

  assert.deepEqual(
    wallet.spent.map((s) => s.id),
    ['gone-tx:0'],
  );
});

test('a scan with a failed lookup reaps nothing', async () => {
  // 'addr-two' errors out, so this scan cannot tell "spent" from
  // "not looked up" — marking UTXOs spent here would hide live coins
  // from the sweep, and the db keeps them marked spent afterwards.
  const wallet = new FakeWallet({ failing: 'sh:addr-two' });

  await rescueScan(wallet, { skipDerive: true });

  assert.deepEqual(wallet.spent, []);
});
