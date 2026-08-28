import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import {
  MNEMONIC_DERIVATION_TYPES,
  STATIC_WALLET_PASSWORD,
} from '../src/constants.js';
import {
  importSources,
  markSourceFailed,
  readSources,
  removeSource,
  validateImportInput,
} from '../src/source-registry.js';
import { getProjectRoot, makeProjectTempDir } from './test-helpers.js';

const ADAPTER_URL = pathToFileURL(
  path.join(getProjectRoot(), 'src', 'navcoin-js-adapter.js'),
).href;

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

// Opens the wallet the way the daemon does on startup and reports what
// went wrong, or null.
//
// In a child process on purpose. The registry damage this guards against
// only shows on a fresh open, and that is what the daemon does: surviving
// wallets stay open in memory after a removal and are re-opened on the
// next start. The indexeddb shim also cannot be re-initialised inside one
// process — `resetNavcoinJs` clears the module promises but the shim's own
// state persists, and a second open in-process hangs retrying.
function tryOpenWallet(sourceId, root) {
  const script = `
    const { getNavWallet } = await import(${JSON.stringify(ADAPTER_URL)});
    const navWallet = await getNavWallet(${JSON.stringify(root)});
    const wallet = new navWallet.WalletFile({
      file: ${JSON.stringify(`${sourceId}.db`)},
      password: ${JSON.stringify(STATIC_WALLET_PASSWORD)},
      spendingPassword: ${JSON.stringify(STATIC_WALLET_PASSWORD)},
      network: 'mainnet',
      log: false,
    });
    let loadError = null;
    wallet.on('db_load_error', (error) => (loadError = String(error)));
    try {
      await wallet.Load({
        useP2p: false,
        minPoolSize: 5,
        skipInitialHistorySync: true,
      });
    } catch (error) {
      loadError = loadError ?? error.message;
    }
    process.stdout.write('RESULT:' + (loadError ?? '') + '\\n');
    process.exit(0);
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: getProjectRoot(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', () => {});

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Opening ${sourceId} did not finish`));
    }, 120_000);

    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT:'));
      if (line === undefined) {
        reject(new Error(`Opening ${sourceId} produced no result`));
        return;
      }
      resolve(line.slice('RESULT:'.length) || null);
    });
  });
}

test('removing one source leaves the rest of the group openable', async () => {
  await withRoot(async (root) => {
    // The indexeddb registry holds a version per wallet and is shared by
    // the whole directory. Deleting the file to forget one wallet took
    // every sibling's version with it, and each then failed to open with
    // "Object store keys already exists" — losing the recovered wallet on
    // a tool whose whole job is recovering it. With a group import this
    // is the ordinary flow: import a phrase, drop the empty derivations.
    const { sources } = await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
    );
    assert.equal(sources.length, 3);

    await removeSource(sources[0].id, root);

    for (const survivor of sources.slice(1)) {
      assert.equal(
        await tryOpenWallet(survivor.id, root),
        null,
        `${survivor.walletType} must still open after a sibling was removed`,
      );
    }
  });
});

test('a removed source can be imported again', async () => {
  await withRoot(async (root) => {
    // The other half of the same registry problem: a source id is derived
    // from the phrase, so re-importing reuses it. Leaving the old version
    // behind would make the shim skip the upgrade that creates the object
    // stores, and the new wallet would never load.
    const first = await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
    );
    await removeSource(first.sources[0].id, root);

    const second = await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
    );

    assert.deepEqual(
      second.sources.map((source) => source.walletType),
      [first.sources[0].walletType],
      'only the removed derivation is missing, so only it is recreated',
    );
    assert.equal(await tryOpenWallet(second.sources[0].id, root), null);
  });
});

test('a derivation whose wallet never built is recorded as failed', async () => {
  await withRoot(async (root) => {
    // Wallet creation finishes after the import has been answered, so a
    // failure has nowhere to go. Left unrecorded the source stays
    // `ready`/`wallet-created` at a zero balance for good — the "empty
    // wallet or no wallet?" ambiguity the group import exists to remove.
    const { sources } = await importSources(
      { type: 'mnemonic', phrase: VALID_12 },
      root,
      fakeAdapter(),
    );

    await markSourceFailed(sources[1].id, 'navcoin-js refused it', root);

    const stored = await readSources(root);
    const failed = stored.sources.find((s) => s.id === sources[1].id);
    assert.equal(failed.status, 'error');
    assert.equal(failed.syncStatus, 'error');
    assert.equal(failed.error, 'navcoin-js refused it');

    // Its siblings are untouched.
    for (const id of [sources[0].id, sources[2].id]) {
      const sibling = stored.sources.find((s) => s.id === id);
      assert.equal(sibling.syncStatus, 'wallet-created');
      assert.equal(sibling.error, null);
    }
  });
});
