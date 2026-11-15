// navcoin-js's own sync must not run: the rescue scan is the only thing
// that reads the chain for a source. Shown against the real navcoin-js on
// the fixture, by what the server is asked.
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
  rescanSource,
  resetElectrumNodeSelectionCache,
} from '../src/wallet-manager.js';
import {
  buildWalletForSource,
  getProjectRoot,
  startStubElectrumServer,
} from './test-helpers.js';

// A first scan of the fixture wallet: derivation plus a stub round trip
// per address.
const SCAN_WITHIN_MS = 120_000;
const POLL_MS = 100;

// One fixed directory, cleared when the run starts: the indexeddb shim
// keeps its sqlite files open for the life of the process, so this
// process can never delete them.
const root = path.join(getProjectRoot(), 'tmp', 'library-sync');

test(
  'a source is scanned without navcoin-js running its own sync',
  { timeout: SCAN_WITHIN_MS + 60_000 },
  async () => {
    const fixture = JSON.parse(
      await fs.readFile(
        path.join(import.meta.dirname, 'fixtures', 'mainnet-fake.json'),
        'utf8',
      ),
    );
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await bootstrapAppData(root);
    const navWallet = await getNavWallet(root);
    const stub = await startStubElectrumServer(fixture);
    process.env.NTR_ELECTRUM_NODES = `127.0.0.1:${stub.port}:ws`;

    try {
      const source = {
        id: 'library-sync',
        type: 'mnemonic',
        walletType: 'navcoin-js-v1',
      };
      await buildWalletForSource(navWallet, source.id);
      await openSourceWallet(source, root, navWallet);
      const state = getSourceState(source.id);

      let queueStarted = false;
      state.wallet.on('sync_started', () => {
        queueStarted = true;
      });

      const deadline = Date.now() + SCAN_WITHIN_MS;
      while (
        state.syncStatus !== 'synced' ||
        state.balance.nav.confirmed !== fixture.expectedNavConfirmed ||
        state.balance.xnav?.confirmed !== fixture.expectedXNavConfirmed
      ) {
        assert.ok(Date.now() < deadline, 'the fixture balance never arrived');
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }

      // The scan ran: it is what asks for unspent outputs.
      assert.ok(stub.requests('blockchain.scripthash.listunspent') > 0);
      // navcoin-js's sync did not: it is what subscribes to every address,
      // and what puts work on the wallet's queue.
      assert.equal(stub.requests('blockchain.scripthash.subscribe'), 0);
      assert.equal(queueStarted, false);
      assert.equal(state.wallet.queue.running, false);

      // What a sweep runs when a batch is rejected: the source scanned
      // again from nothing, waited for, and synced on the same coins.
      const lookups = stub.requests('blockchain.scripthash.listunspent');
      assert.equal(await rescanSource(source.id), true);
      assert.ok(stub.requests('blockchain.scripthash.listunspent') > lookups);
      assert.equal(state.syncStatus, 'synced');
      assert.equal(state.balance.nav.confirmed, fixture.expectedNavConfirmed);
      assert.equal(state.balance.xnav.confirmed, fixture.expectedXNavConfirmed);
      assert.equal(stub.requests('blockchain.scripthash.subscribe'), 0);
      assert.equal(await rescanSource('no-such-source'), false);
    } finally {
      await closeAllWallets();
      await stub.close();
      resetElectrumNodeSelectionCache();
      delete process.env.NTR_ELECTRUM_NODES;
    }
  },
);
