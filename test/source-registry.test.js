import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { importSource, readSources } from '../src/source-registry.js';
import { makeProjectTempDir } from './test-helpers.js';

test('importSource stores wallet-backed source metadata', async () => {
  const root = await makeProjectTempDir('source');

  try {
    await bootstrapAppData(root);

    const source = await importSource(
      {
        type: 'mnemonic',
        walletType: 'navcoin-js-v1',
        phrase:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      root,
    );

    assert.equal(source.status, 'ready');
    assert.equal(source.syncStatus, 'wallet-created');
    assert.equal(source.wallet.backend, 'navcoin-js');

    const stored = await readSources(root);
    assert.equal(stored.sources.length, 1);
    assert.equal(stored.sources[0].wallet.databaseName, `${source.id}.db`);
    await fs.access(stored.sources[0].wallet.dataFile);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('importSource does not persist failed wallet creation', async () => {
  const root = await makeProjectTempDir('source');

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
    await bootstrapAppData(root);

    // A malformed WIF gets through validateImportInput — which only
    // requires a non-empty key — and fails inside navcoin-js while the
    // wallet is being built. That is the failure this test is about: the
    // mnemonic cases it used to use are now refused at the input, which
    // never reaches wallet creation at all.
    await assert.rejects(
      importSource(
        {
          type: 'private-key',
          keys: ['not-a-valid-wif-key'],
        },
        root,
      ),
      /navcoin-js/,
    );

    const stored = await readSources(root);
    assert.deepEqual(stored.sources, []);
  } finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('coinomi imports as an alias of the navcoin-js-v1 derivation', async () => {
  const root = await makeProjectTempDir('source');
  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  try {
    await bootstrapAppData(root);

    const source = await importSource(
      { type: 'mnemonic', walletType: 'coinomi', phrase },
      root,
    );

    // The label the user picked is what gets stored and shown.
    assert.equal(source.walletType, 'coinomi');
    assert.equal(source.status, 'ready');
    await fs.access(source.wallet.dataFile);

    // Same phrase under the type it aliases derives the same keys, so it
    // must be rejected as the same source rather than double-counted.
    await assert.rejects(
      importSource(
        { type: 'mnemonic', walletType: 'navcoin-js-v1', phrase },
        root,
      ),
      /Duplicate source/,
    );

    const stored = await readSources(root);
    assert.equal(stored.sources.length, 1);
    assert.equal(stored.sources[0].walletType, 'coinomi');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
