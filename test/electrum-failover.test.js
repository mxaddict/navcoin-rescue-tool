// Electrum failover against the real navcoin-js and electrum client, with
// stub servers standing in for the nodes. The fakes elsewhere cannot
// cover this: the failures were in how those libraries react to a dead
// socket — reconnecting to the same host forever, requests that never
// settle — so only the real ones can show they are handled.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { getNavWallet } from '../src/navcoin-js-adapter.js';
import { readSources, writeSources } from '../src/source-registry.js';
import {
  closeAllWallets,
  getSourceState,
  openSourceWallet,
  rescanAllSources,
  resetElectrumNodeSelectionCache,
} from '../src/wallet-manager.js';
import { getProjectRoot, startStubElectrumServer } from './test-helpers.js';

// Comfortably past the manager's failover delay and one connect attempt
// against a refusing node, which fails at once.
const FAILOVER_WITHIN_MS = 5_000;
// Comfortably past the manager's wait before retrying an all-dead list.
const RECOVERY_WITHIN_MS = 20_000;
// A full first scan of a fresh wallet: derivation plus a stub round trip
// per address.
const SCAN_WITHIN_MS = 120_000;

const POLL_MS = 100;
// How long navcoin-js gets to finish setting up a fresh connection.
const SETTLE_WITHIN_MS = 10_000;

// One fixed directory, cleared when the run starts rather than when it
// ends: the indexeddb shim keeps its sqlite files open for the life of the
// process, so this process can never delete them. At most one copy is ever
// left behind, in the gitignored tmp/.
const root = path.join(getProjectRoot(), 'tmp', 'electrum-failover');

let navWallet;
let sourceCounter = 0;
const stubs = [];
const opened = [];

test.before(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await bootstrapAppData(root);
  navWallet = await getNavWallet(root);
});

test.afterEach(async () => {
  for (const state of opened.splice(0)) {
    if (state.connected) await waitForConnectionSetUp(state);
  }
  await closeAllWallets();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  resetElectrumNodeSelectionCache();
  delete process.env.NTR_ELECTRUM_NODES;
});

async function startStub(options) {
  const stub = await startStubElectrumServer(null, options);
  stubs.push(stub);
  return stub;
}

async function stopStub(stub) {
  stubs.splice(stubs.indexOf(stub), 1);
  await stub.close();
}

function useNodes(...stubList) {
  process.env.NTR_ELECTRUM_NODES = stubList
    .map((stub) => `127.0.0.1:${stub.port}:ws`)
    .join(',');
}

function address(stub) {
  return `127.0.0.1:${stub.port}`;
}

// lastSyncedAt skips the first scan, for tests about the connection alone.
// The source is registered so the registry shows when it is marked synced.
async function openWallet({ scanned = true } = {}) {
  sourceCounter += 1;
  const source = {
    id: `failover-${sourceCounter}`,
    type: 'mnemonic',
    walletType: 'navcoin-js-v1',
    ...(scanned ? { lastSyncedAt: new Date().toISOString() } : {}),
  };
  const registry = await readSources(root);
  registry.sources.push(source);
  await writeSources(registry, root);

  await openSourceWallet(source, root, navWallet);
  const state = getSourceState(source.id);
  opened.push(state);
  return state;
}

// navcoin-js keeps setting a connection up after reporting it connected,
// and reads wallet.client between awaits without checking it is still
// there; closing the wallet inside that window makes it throw. Its last
// step is subscribing to scripthash updates, so wait for that listener.
function waitForConnectionSetUp(state) {
  return waitFor(
    'navcoin-js to finish setting up the connection',
    () =>
      state.wallet?.client?.subscribe.listenerCount(
        'blockchain.scripthash.subscribe',
      ) > 0,
    SETTLE_WITHIN_MS,
  );
}

async function registeredLastSyncedAt(sourceId) {
  const registry = await readSources(root);
  return registry.sources.find((entry) => entry.id === sourceId).lastSyncedAt;
}

async function waitFor(what, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a wallet whose server dies moves to the next one', async () => {
  const a = await startStub();
  const b = await startStub();
  useNodes(a, b);

  const state = await openWallet();
  assert.equal(state.server, address(a));
  assert.equal(state.syncStatus, 'synced');

  await stopStub(a);

  await waitFor(
    `failover to ${address(b)}`,
    () => state.server === address(b),
    FAILOVER_WITHIN_MS,
  );
  assert.equal(state.connected, true);
  assert.equal(state.syncStatus, 'synced', 'a reconnect restores the status');
});

// The client's own reconnect loop used to keep hammering the dead host
// for as long as the daemon ran, and pull the wallet back to it the
// moment it answered again.
test('the dead server is not retried behind the new connection', async () => {
  const a = await startStub();
  const b = await startStub();
  useNodes(a, b);

  const state = await openWallet();
  const deadPort = a.port;
  await stopStub(a);
  await waitFor(
    'failover',
    () => state.server === address(b),
    FAILOVER_WITHIN_MS,
  );

  const revived = await startStub({ port: deadPort });
  await sleep(3_000);

  assert.equal(revived.connections(), 0, 'nothing reconnected to the old node');
  assert.equal(state.server, address(b));
});

test('a server down at open is skipped', async () => {
  const dead = await startStub();
  const b = await startStub();
  useNodes(dead, b);
  await stopStub(dead);

  const state = await openWallet();

  assert.equal(state.connected, true);
  assert.equal(state.server, address(b));
});

test('with every server down the wallet opens and waits for one', async () => {
  const a = await startStub();
  const b = await startStub();
  useNodes(a, b);
  const bPort = b.port;
  await stopStub(a);
  await stopStub(b);

  const state = await openWallet();
  assert.equal(state.connected, false);
  assert.equal(state.syncStatus, 'no-servers');

  const revived = await startStub({ port: bPort });
  await waitFor(
    'a connection once a server is back',
    () => state.connected,
    RECOVERY_WITHIN_MS,
  );
  assert.equal(state.server, address(revived));
  assert.equal(state.syncStatus, 'synced', 'the status it opened with');
});

// A stalled server leaves the scan waiting on a reply that never comes.
// Losing that server must abandon the scan and run it again elsewhere,
// not leave it waiting forever or call the wallet synced.
test('a scan stuck on a server that dies is run again on the next', async () => {
  const a = await startStub({
    unanswered: ['blockchain.scripthash.get_history'],
  });
  const b = await startStub();
  useNodes(a, b);

  const state = await openWallet({ scanned: false });
  assert.equal(state.server, address(a));
  await waitFor(
    'the scan to be waiting on the stalled server',
    () => a.requests('blockchain.scripthash.get_history') > 0,
    SCAN_WITHIN_MS,
  );
  // navcoin-js runs a short sync of its own on connect and reports it
  // finished; that must not pass for this scan finishing.
  await waitForConnectionSetUp(state);
  assert.notEqual(state.syncStatus, 'synced', 'stuck on the stalled server');
  assert.equal(
    await registeredLastSyncedAt(state.sourceId),
    undefined,
    'not recorded as synced while the scan is stuck',
  );

  await stopStub(a);

  await waitFor(
    'the rerun scan to finish on the next server',
    () => state.syncStatus === 'synced' && !state.rescanInFlight,
    SCAN_WITHIN_MS,
  );
  assert.equal(state.server, address(b));
  assert.equal(state.error, null);
  assert.ok(
    await registeredLastSyncedAt(state.sourceId),
    'recorded as synced once the rerun finished',
  );
});

// navcoin-js blanks wallet.spendingPassword when the sync it runs on every
// connect finishes, and deriving with a blank password silently derives
// nothing — so a scan run after any connect, a rerun after failover
// included, walked only the addresses it already had.
test('a scan run after connecting still derives new addresses', async () => {
  const a = await startStub();
  useNodes(a);

  const state = await openWallet();
  await waitForConnectionSetUp(state);
  const receiving = async () =>
    (await state.wallet.db.GetNavReceivingAddresses(true)).length;
  const before = await receiving();

  const { started } = await rescanAllSources();
  assert.deepEqual(started, [state.sourceId]);
  await waitFor(
    'the rescan to finish',
    () => state.syncStatus === 'synced' && !state.rescanInFlight,
    SCAN_WITHIN_MS,
  );

  assert.ok(
    (await receiving()) > before,
    `the rescan derived past the ${before} addresses it started with`,
  );
});
