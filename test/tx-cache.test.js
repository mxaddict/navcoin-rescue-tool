// The transaction cache navcoin-js keeps in ___tx___, a database every
// wallet in the directory shares, against the real library.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { getNavWallet } from '../src/navcoin-js-adapter.js';
import {
  closeAllWallets,
  getSourceState,
  openSourceWallet,
  resetElectrumNodeSelectionCache,
} from '../src/wallet-manager.js';
import { getProjectRoot, startStubElectrumServer } from './test-helpers.js';

// Cleared when the run starts, not when it ends: the indexeddb shim keeps
// its sqlite files open for the life of the process.
const root = path.join(getProjectRoot(), 'tmp', 'tx-cache');
// Long enough that two lookups of one transaction are both in flight at
// once, as they are against a server across a network.
const STUB_LATENCY_MS = 100;

let navWallet;
let fixture;
let stub;

test.before(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await bootstrapAppData(root);
  navWallet = await getNavWallet(root);
  fixture = JSON.parse(
    await fs.readFile(
      path.join(import.meta.dirname, 'fixtures', 'mainnet-fake.json'),
      'utf8',
    ),
  );
  stub = await startStubElectrumServer(fixture, {
    latencyMs: STUB_LATENCY_MS,
  });
  process.env.NTR_ELECTRUM_NODES = `127.0.0.1:${stub.port}:ws`;
});

test.after(async () => {
  await closeAllWallets();
  await stub.close();
  resetElectrumNodeSelectionCache();
  delete process.env.NTR_ELECTRUM_NODES;
});

// What navcoin-js prints while `body` runs. All three streams: it reports
// a failed cache write on console.error from AddTx but on console.log from
// GetTx, depending on which of them catches it.
async function capturingOutput(body) {
  const lines = [];
  const originals = {};
  for (const stream of ['error', 'log', 'warn']) {
    originals[stream] = console[stream];
    console[stream] = (...args) => {
      lines.push(args.map(String).join(' '));
      originals[stream](...args);
    };
  }
  try {
    await body();
  } finally {
    Object.assign(console, originals);
  }
  return lines;
}

// A first sync looks a transaction up from several places at once: the
// sync navcoin-js runs on connect, the rescue scan, and every derivation
// of a phrase that shares it. Each missed the cache, fetched it, and all
// but the first failed to store it — "AddTx error: SQLITE_CONSTRAINT:
// UNIQUE constraint failed: S_txs.key", once per collision.
test('concurrent lookups of one transaction store it once, without error', async () => {
  const source = {
    id: 'tx-cache-1',
    type: 'mnemonic',
    walletType: 'navcoin-js-v1',
    lastSyncedAt: new Date().toISOString(),
  };
  await openSourceWallet(source, root, navWallet);
  const { wallet } = getSourceState(source.id);
  const [txid] = Object.keys(fixture.transactions);
  const height = fixture.header.height - 100;

  const output = await capturingOutput(async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        wallet.GetTx(txid, undefined, height, false),
      ),
    );
    for (const tx of results) assert.equal(tx.hex, fixture.transactions[txid]);
  });

  assert.deepEqual(
    output.filter((line) => /AddTx|SQLITE_CONSTRAINT/.test(line)),
    [],
  );
  const cached = await wallet.db.GetTx(txid);
  assert.equal(cached.hex, fixture.transactions[txid]);
  assert.ok(cached.height > 0, 'the cached copy kept its height');
});
