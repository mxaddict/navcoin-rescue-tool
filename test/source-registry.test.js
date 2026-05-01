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
        label: 'Seed import',
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

  try {
    await bootstrapAppData(root);

    await assert.rejects(
      importSource(
        {
          type: 'mnemonic',
          walletType: 'navcoin-core',
          label: 'Broken seed',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      ),
      /navcoin-js import failed/,
    );

    const stored = await readSources(root);
    assert.deepEqual(stored.sources, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
