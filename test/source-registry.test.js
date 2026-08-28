import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { MNEMONIC_DERIVATION_TYPES } from '../src/constants.js';
import {
  importSources,
  readSources,
  validateImportInput,
} from '../src/source-registry.js';
import { makeProjectTempDir } from './test-helpers.js';

// A valid BIP39 phrase that fails no checksum, so every derivation except
// navcoin-core (which needs 24 words) accepts it.
const VALID_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// 24 words whose checksum is wrong: only navcoin-core can derive from it,
// and only when the caller waives the check.
const BROKEN_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth zoo';

/// Counts what it was asked to do, so a test can assert on wallet creation
/// without paying for it. The real adapter is exercised separately.
function fakeAdapter({ failOn = null } = {}) {
  const calls = { created: [], deleted: [] };
  return {
    calls,
    createImportedWallet: async (source) => {
      calls.created.push(source.walletType ?? source.type);
      if (failOn && (source.walletType ?? source.type) === failOn) {
        throw new Error(`navcoin-js refused ${failOn}`);
      }
      return { backend: 'fake', databaseName: `${source.id}.db` };
    },
    deleteWalletForSource: async (sourceId) => {
      calls.deleted.push(sourceId);
    },
  };
}

async function withRoot(body) {
  const root = await makeProjectTempDir('source');
  try {
    await bootstrapAppData(root);
    await body(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('a mnemonic yields one source per derivation it can belong to', async () => {
  await withRoot(async (root) => {
    const adapter = fakeAdapter();
    const { importId, sources } = await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
      adapter,
    );

    // 12 words cannot be a navcoin-core seed (it uses the raw 32-byte
    // entropy as the master key), and navcash phrases are Electrum, not
    // BIP39 — so this phrase is exactly the BIP39 derivations.
    assert.deepEqual(
      sources.map((source) => source.walletType),
      ['next', 'navpay', 'navcoin-js-v1'],
    );
    assert.equal(adapter.calls.created.length, 3);

    // One import, several derivations of it.
    assert.ok(importId);
    for (const source of sources) {
      assert.equal(source.importId, importId);
      assert.equal(source.type, 'mnemonic');
      assert.equal(source.status, 'ready');
      assert.equal(source.syncStatus, 'wallet-created');
    }

    // Distinct keys per derivation, or the sweep would double-count.
    assert.equal(new Set(sources.map((s) => s.id)).size, sources.length);
    assert.equal(
      new Set(sources.map((s) => s.fingerprint)).size,
      sources.length,
    );

    const stored = await readSources(root);
    assert.equal(stored.sources.length, 3);
  });
});

test('the group is derived from the phrase, not from the caller', async () => {
  await withRoot(async (root) => {
    // A wallet type in the payload is not a way to narrow the group: the
    // whole point is that the user no longer picks one.
    const { sources } = await importSources(
      { type: 'mnemonic', phrase: VALID_12, walletType: 'navcoin-core' },
      root,
      fakeAdapter(),
    );

    assert.deepEqual(
      sources.map((source) => source.walletType),
      ['next', 'navpay', 'navcoin-js-v1'],
    );
  });
});

test('coinomi collapses into the derivation it aliases', async () => {
  // coinomi derives NavCoin exactly as navcoin-js-v1 does, so importing
  // both would scan the same keys twice and double-count every UTXO.
  assert.ok(!MNEMONIC_DERIVATION_TYPES.includes('coinomi'));

  await withRoot(async (root) => {
    const { sources } = await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
      fakeAdapter(),
    );

    const types = sources.map((source) => source.walletType);
    assert.ok(!types.includes('coinomi'));
    assert.ok(types.includes('navcoin-js-v1'));
  });
});

test('a waived checksum failure collapses the group to navcoin-core', async () => {
  await withRoot(async (root) => {
    // Unwaived, no derivation accepts it at all.
    await assert.rejects(
      importSources(
        { type: 'mnemonic', phrase: BROKEN_24 },
        root,
        fakeAdapter(),
      ),
      /checksum/i,
    );

    const { sources } = await importSources(
      {
        type: 'mnemonic',
        phrase: BROKEN_24,
        allowUncheckedMnemonic: true,
      },
      root,
      fakeAdapter(),
    );

    // navcoin-core never compares the checksum, so it is the only scheme
    // that can derive from this phrase — the waiver does not widen it.
    assert.deepEqual(
      sources.map((source) => source.walletType),
      ['navcoin-core'],
    );
  });
});

test('a private key still imports as a single source', async () => {
  await withRoot(async (root) => {
    const { importId, sources } = await importSources(
      { type: 'private-key', keys: ['aaa', 'bbb'] },
      root,
      fakeAdapter(),
    );

    assert.equal(sources.length, 1);
    assert.equal(sources[0].walletType, null);
    assert.equal(sources[0].importId, importId);
  });
});

test('re-importing the same phrase is refused as a duplicate', async () => {
  await withRoot(async (root) => {
    await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
      fakeAdapter(),
    );

    // Whitespace and case are normalised away, so a retyped phrase is the
    // same import rather than a second copy of every derivation.
    const adapter = fakeAdapter();
    await assert.rejects(
      importSources(
        { type: 'mnemonic', phrase: `  ${VALID_12.replace(/ /g, '   ')} ` },
        root,
        adapter,
      ),
      /Duplicate source/,
    );
    assert.deepEqual(adapter.calls.created, []);

    const stored = await readSources(root);
    assert.equal(stored.sources.length, 3);
  });
});

test('one failed derivation rolls the whole group back', async () => {
  await withRoot(async (root) => {
    // The second of three fails, so the first has a wallet on disk and the
    // third was never started. Leaving either behind would half-import the
    // phrase, and a half-imported group reports a partial balance.
    const adapter = fakeAdapter({ failOn: 'navpay' });

    await assert.rejects(
      importSources({ type: 'mnemonic', phrase: VALID_12 }, root, adapter),
      /navcoin-js refused navpay/,
    );

    assert.deepEqual(adapter.calls.created, ['next', 'navpay']);
    assert.equal(
      adapter.calls.deleted.length,
      2,
      'the failed derivation is cleaned up too, not just the ones that finished',
    );

    const stored = await readSources(root);
    assert.deepEqual(stored.sources, []);
  });
});

test('validateImportInput reports the derivations without touching disk', () => {
  assert.deepEqual(
    validateImportInput({ type: 'mnemonic', phrase: VALID_12 }).walletTypes,
    ['next', 'navpay', 'navcoin-js-v1'],
  );

  // A private key has no derivation to choose, and the single null keeps
  // the caller's loop the same shape for both source types.
  assert.deepEqual(
    validateImportInput({ type: 'private-key', keys: ['abc'] }).walletTypes,
    [null],
  );

  assert.throws(
    () => validateImportInput({ type: 'mnemonic', phrase: 'too few words' }),
    /at least 12 words/,
  );
});

test('the real adapter builds a wallet for every derivation', async () => {
  await withRoot(async (root) => {
    // The fake adapter above proves the grouping; this proves navcoin-js
    // actually accepts each derivation the grouping produces, which is the
    // half a stub can never tell us.
    const { sources } = await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
    );

    assert.deepEqual(
      sources.map((source) => source.walletType),
      ['next', 'navpay', 'navcoin-js-v1'],
    );
    for (const source of sources) {
      assert.equal(source.wallet.backend, 'navcoin-js');
      assert.equal(source.wallet.databaseName, `${source.id}.db`);
      await fs.access(source.wallet.dataFile);
    }
  });
});

test('a failed wallet creation is not persisted', async () => {
  // navcoin-js and Dexie log internal errors to console unconditionally when
  // a wallet fails to open. Silence all console output for this test since
  // the failure is intentional and already asserted via rejects().
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    await withRoot(async (root) => {
      // A malformed WIF gets through validateImportInput — which only
      // requires a non-empty key — and fails inside navcoin-js while the
      // wallet is being built. That is the failure this test is about: the
      // mnemonic cases it used to use are now refused at the input, which
      // never reaches wallet creation at all.
      await assert.rejects(
        importSources(
          { type: 'private-key', keys: ['not-a-valid-wif-key'] },
          root,
        ),
        /navcoin-js/,
      );

      const stored = await readSources(root);
      assert.deepEqual(stored.sources, []);
    });
  } finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  }
});
