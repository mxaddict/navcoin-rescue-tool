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

    await assert.rejects(
      importSource(
        {
          type: 'mnemonic',
          walletType: 'navcoin-core',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      ),
      /navcoin-js import failed|could not derive keys/,
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
