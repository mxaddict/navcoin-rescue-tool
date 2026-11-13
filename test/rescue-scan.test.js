import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  rescueScan,
  SCAN_CHECKPOINT_MAX_AGE_MS,
  ScanIncompleteError,
} from '../src/rescue-scan.js';

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

test('a scan with a failed lookup ends incomplete and reaps nothing', async () => {
  // 'addr-two' errors out, so this scan cannot tell "spent" from
  // "not looked up" — marking UTXOs spent here would hide live coins
  // from the sweep, and the db keeps them marked spent afterwards. Nor
  // can it be called finished: whatever is on 'addr-two' is unknown.
  const wallet = new FakeWallet({ failing: 'sh:addr-two' });
  let finished = false;
  wallet.on('sync_finished', () => (finished = true));

  await assert.rejects(rescueScan(wallet, { skipDerive: true }), (error) => {
    assert.ok(error instanceof ScanIncompleteError);
    // Both lookups for the address are counted once: the history one
    // failed, so the unspent one was never made.
    assert.equal(error.failures, 1);
    return true;
  });

  assert.deepEqual(wallet.spent, []);
  assert.equal(finished, false);
});

// The server listed the coin but would not give its transaction, so it is
// not in the balance. A scan that finished on that would be swept without
// the coin.
test('a coin whose transaction cannot be fetched makes the scan incomplete', async () => {
  const wallet = new FakeWallet();
  wallet.GetTx = async () => {
    throw new Error('server busy - request timed out');
  };

  await assert.rejects(
    rescueScan(wallet, { skipDerive: true }),
    ScanIncompleteError,
  );
  assert.deepEqual(wallet.spent, []);
});

// A wallet the branch walk can run against: it derives addresses on
// demand, counts the history lookups made per address, and lets a test
// script what one lookup does.
class WalkWallet extends EventEmitter {
  constructor() {
    super();
    this.mvk = null; // no xNAV keys — skips the xNAV pass
    this.addresses = [];
    this.lookups = new Map();
    this.stakingLookups = 0;
    this.spent = [];
    // sh -> () => history, to make one lookup fail, hang or abort.
    this.onHistory = new Map();
    this.onStakingKeys = null;
    this.navAddresses = [];

    this.client = {
      blockchain_scripthash_getHistory: async (sh) => {
        this.lookups.set(sh, (this.lookups.get(sh) ?? 0) + 1);
        return this.onHistory.get(sh)?.() ?? [];
      },
      blockchain_scripthash_listunspent: async () => [],
      blockchain_staking_getKeys: async (hash) => {
        this.stakingLookups += 1;
        return this.onStakingKeys?.(hash) ?? [];
      },
    };

    this.db = {
      GetCounter: async (name) =>
        this.addresses.filter((a) => a.change === (name === 'NavChange'))
          .length,
      GetNavReceivingAddresses: async () => this.addresses,
      GetNavAddresses: async () => this.navAddresses,
      GetUtxos: async () => [{ id: 'gone-tx:0', spentIn: null }],
      SpendUtxo: async (id) => this.spent.push(id),
    };
  }

  async NavCreateAddress(password, branch) {
    const change = branch === 1;
    const idx = this.addresses.filter((a) => a.change === change).length;
    this.addresses.push({
      address: `${change ? 'c' : 'r'}-${idx}`,
      path: `m/44'/130'/0'/${branch}/${idx}`,
      change,
    });
  }

  AddressToScriptHash(address) {
    return `sh:${address}`;
  }

  async GetStakingAddresses() {
    return [];
  }

  lookupsOf(address) {
    return this.lookups.get(`sh:${address}`) ?? 0;
  }
}

// Small enough to reason about by hand: one batch is ten addresses, the
// walk stops after ten unused in a row, and progress is saved every five.
const WALK = {
  password: 'password',
  gapLimit: 10,
  walkBatchSize: 10,
  xNavPoolSize: 0,
  concurrency: 1,
  progressInterval: 5,
};

function memoryCheckpoint(initial = null) {
  const store = {
    value: initial,
    saves: [],
    load: async () => store.value,
    save: async (checkpoint) => {
      store.value = checkpoint;
      store.saves.push(checkpoint);
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

// Runs a scan the way wallet-manager does: a scan cut off by a drop can be
// stuck on a lookup that is never answered, so it is not waited for.
function scanUntilAborted(wallet, opts) {
  const controller = new AbortController();
  const aborted = new Promise((resolve) =>
    controller.signal.addEventListener('abort', () => resolve('aborted')),
  );
  const scanning = rescueScan(wallet, { ...opts, signal: controller.signal });
  scanning.catch(() => {});
  return { controller, outcome: Promise.race([scanning, aborted]) };
}

// The connection drops while this address is being looked up: the lookup
// is never answered, as the electrum client leaves it.
function dropAt(wallet, address, controller) {
  wallet.onHistory.set(`sh:${address}`, () => {
    controller.abort();
    return new Promise(() => {});
  });
}

test('a scan cut off by a drop resumes without repeating finished lookups', async () => {
  const wallet = new WalkWallet();
  const checkpoint = memoryCheckpoint();

  const first = scanUntilAborted(wallet, { ...WALK, checkpoint });
  dropAt(wallet, 'r-7', first.controller);
  assert.equal(await first.outcome, 'aborted');

  // Saved every five addresses, so r-0..r-4 are recorded; r-5 and r-6
  // were looked up after the last save and are not.
  assert.deepEqual(checkpoint.value.walks.receive.finished, [0, 1, 2, 3, 4]);

  wallet.onHistory.clear();
  assert.equal(await rescueScan(wallet, { ...WALK, checkpoint }), true);

  for (const address of ['r-0', 'r-1', 'r-2', 'r-3', 'r-4']) {
    assert.equal(wallet.lookupsOf(address), 1, `${address} looked up again`);
  }
  for (const address of ['r-5', 'r-6', 'r-7', 'r-8', 'r-9', 'c-0', 'c-9']) {
    assert.ok(wallet.lookupsOf(address) >= 1, `${address} never looked up`);
  }
  assert.equal(wallet.lookupsOf('r-7'), 2);

  // A resumed scan did not see the outpoints of the addresses it skipped,
  // so it must not mark anything spent.
  assert.deepEqual(wallet.spent, []);
  // Finished: the next scan starts from the first address again.
  assert.equal(checkpoint.value, null);
});

test('an address whose lookup failed is looked up again on resume', async () => {
  const wallet = new WalkWallet();
  const checkpoint = memoryCheckpoint();

  const first = scanUntilAborted(wallet, { ...WALK, checkpoint });
  wallet.onHistory.set('sh:r-2', () => {
    throw new Error('server busy - request timed out');
  });
  dropAt(wallet, 'r-7', first.controller);
  assert.equal(await first.outcome, 'aborted');
  assert.deepEqual(checkpoint.value.walks.receive.finished, [0, 1, 3, 4]);

  wallet.onHistory.clear();
  assert.equal(await rescueScan(wallet, { ...WALK, checkpoint }), true);

  assert.equal(wallet.lookupsOf('r-2'), 2);
  assert.equal(wallet.lookupsOf('r-0'), 1);
});

// An abandoned scan is replaced by a new one that saves to the same
// place. A lookup of the old scan that is answered after the abort reaches
// a save point, and must not write over what the replacement saved.
test('an aborted scan saves nothing after it was aborted', async () => {
  const wallet = new WalkWallet();
  const checkpoint = memoryCheckpoint();

  // Two lookups in flight at once, with a save after every address: r-0
  // is sent first and answered last, after r-1 has dropped the connection.
  let answerLate;
  wallet.onHistory.set(
    'sh:r-0',
    () => new Promise((resolve) => (answerLate = () => resolve([]))),
  );
  const first = scanUntilAborted(wallet, {
    ...WALK,
    concurrency: 2,
    progressInterval: 1,
    checkpoint,
  });
  dropAt(wallet, 'r-1', first.controller);
  assert.equal(await first.outcome, 'aborted');
  assert.equal(wallet.lookupsOf('r-0'), 1, 'r-0 was not in flight');

  answerLate();
  for (let turn = 0; turn < 10; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(checkpoint.saves, []);
});

test('a scan that finishes clean still reaps, and leaves no checkpoint', async () => {
  const wallet = new WalkWallet();
  const checkpoint = memoryCheckpoint();

  assert.equal(await rescueScan(wallet, { ...WALK, checkpoint }), true);
  assert.deepEqual(wallet.spent, ['gone-tx:0']);
  assert.ok(checkpoint.saves.length > 0, 'progress was never saved');
  assert.equal(checkpoint.value, null);

  await rescueScan(wallet, { ...WALK, checkpoint });
  assert.equal(wallet.lookupsOf('r-0'), 2);
});

test('a checkpoint that is too old or of another version is not resumed', async () => {
  const walks = {
    receive: { finished: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], lastUsedIdx: -1 },
  };
  const tooOld = new Date(
    Date.now() - SCAN_CHECKPOINT_MAX_AGE_MS - 1_000,
  ).toISOString();
  const fresh = new Date().toISOString();

  for (const saved of [
    { version: 1, startedAt: tooOld, walks, stakingDiscovered: false },
    { version: 0, startedAt: fresh, walks, stakingDiscovered: false },
  ]) {
    const wallet = new WalkWallet();
    await rescueScan(wallet, {
      ...WALK,
      checkpoint: memoryCheckpoint(structuredClone(saved)),
    });
    assert.equal(wallet.lookupsOf('r-0'), 1, JSON.stringify(saved));
    // Not resumed, so it reaps like any clean scan.
    assert.deepEqual(wallet.spent, ['gone-tx:0']);
  }

  // The same checkpoint, recent and current, is resumed.
  const wallet = new WalkWallet();
  await rescueScan(wallet, {
    ...WALK,
    checkpoint: memoryCheckpoint({
      version: 1,
      startedAt: fresh,
      walks: structuredClone(walks),
      stakingDiscovered: false,
    }),
  });
  assert.equal(wallet.lookupsOf('r-0'), 0);
});

// The gap is counted from the last used address. A resumed walk that
// forgot it would stop at the first batch and never reach the coins the
// earlier attempt had shown lie further on.
test('a resumed walk keeps the last used address it had found', async () => {
  const wallet = new WalkWallet();
  await rescueScan(wallet, {
    ...WALK,
    checkpoint: memoryCheckpoint({
      version: 1,
      startedAt: new Date().toISOString(),
      walks: {
        receive: { finished: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], lastUsedIdx: 8 },
      },
      stakingDiscovered: false,
    }),
  });

  assert.equal(wallet.lookupsOf('r-9'), 0);
  assert.equal(wallet.lookupsOf('r-10'), 1);
  assert.equal(wallet.lookupsOf('r-18'), 1);
  assert.equal(wallet.lookupsOf('r-20'), 0);
});

test('staking discovery is skipped on resume only if it fully succeeded', async () => {
  const discovered = async (onStakingKeys) => {
    const wallet = new WalkWallet();
    wallet.navAddresses = [
      { address: 'r-0', hash: '00' },
      { address: 'r-1', hash: '01' },
    ];
    wallet.onStakingKeys = onStakingKeys;
    const checkpoint = memoryCheckpoint();
    const outcome = await rescueScan(wallet, { ...WALK, checkpoint }).catch(
      (error) => error,
    );
    assert.equal(wallet.stakingLookups, 2);
    return {
      outcome,
      recorded: checkpoint.saves.some((saved) => saved.stakingDiscovered),
    };
  };

  assert.deepEqual(await discovered(null), { outcome: true, recorded: true });

  // A partner the server would not name is a cold-staking address never
  // scanned: the scan is incomplete, and the pass is not recorded as done.
  const failed = await discovered((hash) => {
    if (hash === '01') throw new Error('server busy - request timed out');
    return [];
  });
  assert.ok(failed.outcome instanceof ScanIncompleteError);
  assert.equal(failed.recorded, false);

  // And a checkpoint that says it was discovered skips the pass.
  const wallet = new WalkWallet();
  wallet.navAddresses = [{ address: 'r-0', hash: '00' }];
  await rescueScan(wallet, {
    ...WALK,
    checkpoint: memoryCheckpoint({
      version: 1,
      startedAt: new Date().toISOString(),
      walks: {},
      stakingDiscovered: true,
    }),
  });
  assert.equal(wallet.stakingLookups, 0);
});

// A change branch after many payments is a long run of addresses that
// were used and emptied, with the current coins beyond them. Counting the
// gap from the last address still holding coins stopped the walk inside
// that run.
test('an address that was used and emptied still extends the walk', async () => {
  const wallet = new WalkWallet();
  // History, and nothing unspent: the fake's listunspent is always empty.
  wallet.onHistory.set('sh:r-5', () => [{ tx_hash: 'old-tx', height: 10 }]);

  await rescueScan(wallet, WALK);

  // The gap is counted from r-5, so the walk goes a second batch.
  assert.equal(wallet.lookupsOf('r-9'), 1);
  assert.equal(wallet.lookupsOf('r-10'), 1);
  assert.equal(wallet.lookupsOf('r-19'), 1);
  assert.equal(wallet.lookupsOf('r-20'), 0);
  // The change branch saw no history and stops after one.
  assert.equal(wallet.lookupsOf('c-9'), 1);
  assert.equal(wallet.lookupsOf('c-10'), 0);
});

// The rerun after an incomplete scan must not redo the whole walk: it
// keeps the checkpoint, so only the address that failed is looked up again.
test('an incomplete scan keeps its checkpoint for the rerun', async () => {
  const wallet = new WalkWallet();
  const checkpoint = memoryCheckpoint();
  wallet.onHistory.set('sh:r-2', () => {
    throw new Error('server busy - request timed out');
  });

  await assert.rejects(
    rescueScan(wallet, { ...WALK, checkpoint }),
    ScanIncompleteError,
  );
  assert.deepEqual(
    checkpoint.value.walks.receive.finished,
    [0, 1, 3, 4, 5, 6, 7, 8, 9],
  );

  wallet.onHistory.clear();
  assert.equal(await rescueScan(wallet, { ...WALK, checkpoint }), true);
  assert.equal(wallet.lookupsOf('r-2'), 2);
  assert.equal(wallet.lookupsOf('r-0'), 1);
  assert.equal(wallet.lookupsOf('c-0'), 1);
  assert.equal(checkpoint.value, null);
});
