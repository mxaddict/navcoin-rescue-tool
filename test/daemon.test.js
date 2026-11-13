import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  bootstrapAppData,
  readAuthCookie,
  readStatus,
} from '../src/app-data.js';
import {
  getDaemonStatus,
  importDaemonSource,
  removeDaemonSource,
  purgeDaemon,
  stopDaemon,
} from '../src/daemon-client.js';
import { APP_VERSION } from '../src/constants.js';
import { getWalletStorageDetails } from '../src/navcoin-js-adapter.js';
import { importSources } from '../src/source-registry.js';
import {
  killPortHolders,
  makeProjectTempDir,
  spawnDaemon,
  startStubElectrumServer,
  waitForDaemonReady as waitForReady,
  waitForExit,
  removeDaemonDataDir,
} from './test-helpers.js';

const TEST_PORT = 46199;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let stubPort = 0;
let stubClose = null;

// Kill anything still holding the test daemon port from a previous run
// (interrupted test, leaked process, stale local worker). lsof isn't
// available on Windows and isn't needed on a fresh CI worker — skip
// silently when it's missing.  Then start the stub electrum server
// once for the whole file.
before(async () => {
  killPortHolders(TEST_PORT);

  const stub = await startStubElectrumServer();
  stubPort = stub.port;
  stubClose = stub.close;
});

after(async () => {
  if (stubClose) await stubClose();
});

test('daemon status requires auth cookie and supports stop', async () => {
  const root = await makeProjectTempDir('daemon');
  await bootstrapAppData(root);

  const child = spawnDaemon({ root: root, stubPort });

  try {
    await waitForReady(child);

    const authCookie = await readAuthCookie(root);
    const unauthorized = await fetch(`${BASE_URL}/status`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${BASE_URL}/status`, {
      headers: { Authorization: authCookie },
    });
    assert.equal(authorized.status, 200);

    // The GUI reads this field off the wire to decide whether the daemon
    // holding the port came from the same build it ships with, so it has
    // to sit at the top level of the reply and carry the real version.
    const reply = await authorized.json();
    assert.equal(reply.version, APP_VERSION);
    // Present and null before any sweep, so a client following a sweep
    // can tell "none yet" from a daemon too old to report one.
    assert.equal(reply.sweep, null);

    const status = await getDaemonStatus(root);
    assert.equal(status.daemon.status, 'running');

    await stopDaemon(root);
    await waitForExit(child);

    const finalState = await readStatus(root);
    assert.equal(finalState.daemon.status, 'stopped');
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test('daemon import persists sources and rejects duplicates', async () => {
  const root = await makeProjectTempDir('daemon');
  await bootstrapAppData(root);

  const child = spawnDaemon({ root: root, stubPort });

  try {
    await waitForReady(child);

    const imported = await importDaemonSource(
      {
        type: 'mnemonic',
        phrase:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      root,
    );

    // One phrase, one import id, a source per derivation it can belong to.
    assert.deepEqual(
      imported.sources.map((source) => source.walletType),
      ['next', 'navpay', 'navcoin-js-v1'],
    );
    for (const source of imported.sources) {
      assert.equal(source.status, 'ready');
      assert.equal(source.syncStatus, 'wallet-created');
      assert.equal(source.importId, imported.importId);
    }

    const status = await getDaemonStatus(root);
    assert.equal(status.sourceCount, 3);
    assert.deepEqual(
      status.sources.map((source) => source.id).sort(),
      imported.sources.map((source) => source.id).sort(),
    );

    await assert.rejects(
      importDaemonSource(
        {
          type: 'mnemonic',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      ),
      /Duplicate source/,
    );

    const reloaded = await readStatus(root);
    assert.equal(reloaded.sources.sources.length, 3);

    // Removal is still per source: the group is an import, not a unit the
    // rest of the daemon has to know about.
    for (const source of imported.sources) {
      await removeDaemonSource(source.id, root);
    }
    const finalState = await readStatus(root);
    assert.deepEqual(finalState.sources.sources, []);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test('daemon derives coinomi only once, as navcoin-js-v1', async () => {
  const root = await makeProjectTempDir('daemon');
  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  await bootstrapAppData(root);

  const child = spawnDaemon({ root: root, stubPort });

  try {
    await waitForReady(child);

    const imported = await importDaemonSource(
      { type: 'mnemonic', phrase },
      root,
    );

    // Coinomi derives at the navcoin-js-v1 path, so deriving both would
    // scan the same keys twice and double-count every UTXO.
    const types = imported.sources.map((source) => source.walletType);
    assert.ok(!types.includes('coinomi'), types.join(', '));
    assert.ok(types.includes('navcoin-js-v1'));
    assert.equal(new Set(types).size, types.length);

    const status = await getDaemonStatus(root);
    assert.equal(status.sourceCount, types.length);

    const reloaded = await readStatus(root);
    assert.equal(reloaded.sources.sources.length, types.length);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test('daemon private-key import works', async () => {
  const root = await makeProjectTempDir('daemon');
  await bootstrapAppData(root);

  const child = spawnDaemon({ root: root, stubPort });

  try {
    await waitForReady(child);

    const imported = await importDaemonSource(
      {
        type: 'private-key',
        keys: ['PCbhgKMp6ym9MgtMQ3XYxqnMrG3yFwAuQgTmZznbLxWExwxXH2pM'],
      },
      root,
    );

    assert.equal(imported.sources.length, 1);
    assert.equal(imported.sources[0].status, 'ready');
    assert.equal(imported.sources[0].type, 'private-key');

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test('daemon restart restores imported sources from disk', async () => {
  const root = await makeProjectTempDir('daemon-restart-persist');
  await bootstrapAppData(root);

  let child = spawnDaemon({ root: root, stubPort });

  try {
    // 1. Import a private-key source.
    await waitForReady(child);
    const imported = await importDaemonSource(
      {
        type: 'private-key',
        keys: ['PCbhgKMp6ym9MgtMQ3XYxqnMrG3yFwAuQgTmZznbLxWExwxXH2pM'],
      },
      root,
    );
    assert.equal(imported.sources[0].type, 'private-key');
    const sourceId = imported.sources[0].id;

    // 2. Stop the daemon cleanly.
    await stopDaemon(root);
    await waitForExit(child);

    // 3. Verify sources.json persisted the source on disk.
    const rawJson = await fs.readFile(`${root}/sources.json`, 'utf8');
    const sourcesOnDisk = JSON.parse(rawJson);
    assert.equal(sourcesOnDisk.sources.length, 1);
    assert.equal(sourcesOnDisk.sources[0].id, sourceId);

    // 4. Respawn daemon on the same root.
    child = spawnDaemon({ root: root, stubPort });
    await waitForReady(child);

    // 5. Assert state restored from disk.
    const status = await getDaemonStatus(root);
    assert.equal(status.sourceCount, 1);
    assert.equal(status.sources[0].id, sourceId);
    assert.equal(status.sources[0].type, 'private-key');

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test('daemon survives purge then re-import of same private key', async () => {
  const root = await makeProjectTempDir('daemon-purge-reimport');
  await bootstrapAppData(root);

  let child = spawnDaemon({ root: root, stubPort });

  try {
    // 1. Import a private key.
    await waitForReady(child);
    const imported = await importDaemonSource(
      {
        type: 'private-key',
        keys: ['PCbhgKMp6ym9MgtMQ3XYxqnMrG3yFwAuQgTmZznbLxWExwxXH2pM'],
      },
      root,
    );
    assert.equal(imported.sources[0].type, 'private-key');

    // 2. Purge all wallet data.
    await purgeDaemon(root);
    await waitForExit(child);

    const persisted = await readStatus(root);
    assert.equal(persisted.sources.sources.length, 0);

    // 3. Restart — purge now stops the daemon after deleting data.

    child = spawnDaemon({ root: root, stubPort });
    await waitForReady(child);

    // 4. Re-import the same private key — this was crashing with ConstraintError.
    const reimported = await importDaemonSource(
      {
        type: 'private-key',
        keys: ['PCbhgKMp6ym9MgtMQ3XYxqnMrG3yFwAuQgTmZznbLxWExwxXH2pM'],
      },
      root,
    );
    assert.equal(reimported.sources[0].status, 'ready');
    assert.equal(reimported.sources[0].type, 'private-key');

    // 5. Daemon still reachable — no crash.
    const finalStatus = await getDaemonStatus(root);
    assert.equal(finalStatus.sourceCount, 1);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test('daemon status is idempotent across repeated reads', async () => {
  const root = await makeProjectTempDir('daemon-idempotent-status');
  await bootstrapAppData(root);

  const child = spawnDaemon({ root: root, stubPort });

  try {
    await waitForReady(child);

    await importDaemonSource(
      {
        type: 'private-key',
        keys: ['PCbhgKMp6ym9MgtMQ3XYxqnMrG3yFwAuQgTmZznbLxWExwxXH2pM'],
      },
      root,
    );

    const s1 = await getDaemonStatus(root);
    const s2 = await getDaemonStatus(root);
    const s3 = await getDaemonStatus(root);

    // Source-level state must be stable across consecutive reads.
    assert.deepEqual(s1.sources, s2.sources);
    assert.deepEqual(s2.sources, s3.sources);

    // On-disk state must not have been mutated by the reads (no duplication).
    const diskState = await readStatus(root);
    assert.equal(diskState.sources.sources.length, 1);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test('daemon rejects invalid imports without persisting broken state', async () => {
  const root = await makeProjectTempDir('daemon-invalid-import');
  await bootstrapAppData(root);

  const child = spawnDaemon({ root: root, stubPort });

  try {
    await waitForReady(child);

    // Unsupported source type.
    await assert.rejects(
      importDaemonSource(
        {
          type: 'wallet-dat',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      ),
      /Unsupported source type/,
    );
    let state = await readStatus(root);
    assert.equal(state.sources.sources.length, 0);

    // A phrase no derivation accepts: the group would be empty, which is
    // a rejection rather than an import of nothing.
    await assert.rejects(
      importDaemonSource(
        {
          type: 'mnemonic',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zoo',
        },
        root,
      ),
      /checksum/i,
    );
    state = await readStatus(root);
    assert.equal(state.sources.sources.length, 0);

    // Empty private key list.
    await assert.rejects(
      importDaemonSource(
        {
          type: 'private-key',
          keys: [],
        },
        root,
      ),
      /At least one private key is required/,
    );
    state = await readStatus(root);
    assert.equal(state.sources.sources.length, 0);

    // Recovery: a valid import must still work after all failures.
    const imported = await importDaemonSource(
      {
        type: 'mnemonic',
        phrase:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      root,
    );
    assert.ok(imported.sources.every((source) => source.status === 'ready'));
    const finalState = await readStatus(root);
    assert.equal(finalState.sources.sources.length, imported.sources.length);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

test(
  'daemon imports known mnemonic and discovers NAV+xNAV balance from stub',
  { timeout: 180_000 },
  async () => {
    // Load the pre-built fixture so we know exact expected values.
    const fixturePath = path.join(
      import.meta.dirname,
      'fixtures',
      'mainnet-fake.json',
    );
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

    // Start a fixture-backed stub electrum server (separate from the
    // shared generic one used by other tests).
    const fixtureStub = await startStubElectrumServer(fixture);

    const root = await makeProjectTempDir('daemon-nav-balance');

    await bootstrapAppData(root);

    const child = spawnDaemon({ root, stubPort: fixtureStub.port });
    // Kept for the timeout message below: this test stalled once in a full
    // run with nothing to show why, the daemon's log being the only place
    // a dropped connection or a scan being run again is recorded.
    let daemonLog = '';
    child.stderr.on('data', (chunk) => {
      daemonLog += chunk.toString();
    });

    try {
      await waitForReady(child);

      // Import the well-known abandon mnemonic.
      const imported = await importDaemonSource(
        {
          type: 'mnemonic',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      );

      // The fixture's UTXOs sit on the navcoin-js-v1 derivation. The other
      // derivations of the same phrase are imported too and scan empty,
      // which is the point: the balance identifies which one is real.
      const fundedSource = imported.sources.find(
        (source) => source.walletType === 'navcoin-js-v1',
      );
      assert.ok(fundedSource, 'navcoin-js-v1 is one of the derivations');

      // Poll until syncStatus === 'synced' AND the expected balance is credited.
      // rescue-scan runs concurrently with the wallet's built-in Sync(); the
      // wallet emits sync_finished quickly (before rescue-scan finishes), then
      // rescue-scan emits a second sync_finished when it's done. We must wait
      // for the balance to reflect the rescue-scan results, not just the first
      // sync_finished.
      const SYNC_TIMEOUT_MS = 90_000;
      const POLL_INTERVAL_MS = 500;
      const DAEMON_LOG_TAIL_LINES = 60;
      const expectedNav = fixture.expectedNavConfirmed;
      const expectedXNav = fixture.expectedXNavConfirmed;
      const start = Date.now();
      let status;

      while (true) {
        if (Date.now() - start > SYNC_TIMEOUT_MS) {
          throw new Error(
            `Wallet did not reach syncStatus='synced' with expected NAV+xNAV balance within ${SYNC_TIMEOUT_MS}ms. ` +
              `Last status: ${JSON.stringify(
                status?.sources?.find(
                  (source) => source.id === fundedSource.id,
                ),
              )}\nDaemon log, last lines:\n` +
              daemonLog.split('\n').slice(-DAEMON_LOG_TAIL_LINES).join('\n'),
          );
        }

        status = await getDaemonStatus(root);
        const src = status.sources?.find(
          (source) => source.id === fundedSource.id,
        );

        if (
          src?.syncStatus === 'synced' &&
          src?.balance?.nav?.confirmed === expectedNav &&
          src?.balance?.xnav?.confirmed === expectedXNav
        )
          break;

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      const src = status.sources.find(
        (source) => source.id === fundedSource.id,
      );
      assert.equal(src.syncStatus, 'synced');

      // Assert the NAV confirmed balance matches fixture expectation.
      assert.equal(
        src.balance.nav.confirmed,
        expectedNav,
        `Expected nav.confirmed=${expectedNav} but got ${src.balance.nav.confirmed}`,
      );

      // Assert the xNAV confirmed balance matches fixture expectation.
      assert.equal(
        src.balance.xnav.confirmed,
        expectedXNav,
        `Expected xnav.confirmed=${expectedXNav} but got ${src.balance.xnav.confirmed}`,
      );

      // At least one address should carry a non-zero balance.
      const fundedAddrs = src.addresses.filter((a) => a.balance > 0);
      assert.ok(
        fundedAddrs.length > 0,
        'Expected at least one address with non-zero balance',
      );

      await stopDaemon(root);
      await waitForExit(child);
    } finally {
      child.kill('SIGTERM');
      await waitForExit(child);
      await fixtureStub.close();
      await removeDaemonDataDir(root);
    }
  },
);

// From a user's log: ElectrumX answered a request with "server busy -
// request timed out", navcoin-js left the rejection unhandled, and node
// ended the daemon. The stub answers the request navcoin-js makes on
// every connect with that error, so the rejection is certain to happen.
test(
  'daemon survives an electrum server answering busy',
  { timeout: 120_000 },
  async () => {
    const busyStub = await startStubElectrumServer(null, {
      failing: {
        'blockchain.headers.subscribe': 'server busy - request timed out',
      },
    });
    const root = await makeProjectTempDir('daemon-server-busy');
    await bootstrapAppData(root);

    const child = spawnDaemon({ root, stubPort: busyStub.port });

    try {
      await waitForReady(child);

      let stderr = '';
      const rejectionLogged = new Promise((resolve, reject) => {
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
          if (stderr.includes('unhandled rejection: server busy')) resolve();
        });
        child.once('exit', (code) =>
          reject(
            new Error(`daemon exited (${code}):
${stderr}`),
          ),
        );
      });

      await importDaemonSource(
        {
          type: 'mnemonic',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      );

      // Proves the busy reply reached the daemon and was rejected, so the
      // checks below are not passing against a daemon that never saw it.
      await rejectionLogged;
      assert.ok(busyStub.requests('blockchain.headers.subscribe') > 0);

      // Node ends the process on the tick after an unhandled rejection;
      // a status round trip afterwards shows it outlived that.
      const status = await getDaemonStatus(root);
      assert.equal(status.daemon.status, 'running');
      assert.equal(child.exitCode, null);

      await stopDaemon(root);
      await waitForExit(child);
    } finally {
      child.kill('SIGTERM');
      await waitForExit(child);
      await busyStub.close();
      await removeDaemonDataDir(root);
    }
  },
);

// fetch reports every network failure as a bare "fetch failed", which is
// what a user saw when a sweep's request to the daemon broke. The reason
// rides on `cause` and has to reach the message they read.
test('a request to a daemon that is not running names the reason', async () => {
  const root = await makeProjectTempDir('daemon-unreachable');
  await bootstrapAppData(root);

  try {
    await assert.rejects(getDaemonStatus(root), (error) => {
      assert.match(error.message, /^fetch failed \(ECONNREFUSED/);
      assert.equal(error.cause?.cause?.code, 'ECONNREFUSED');
      return true;
    });
  } finally {
    await removeDaemonDataDir(root);
  }
});

// A throw outside any promise still ends the daemon, but it must leave a
// timestamped line in the log to match against the sweep and electrum
// lines around it. The preload throws from a timer once the daemon has
// written "ready", after daemon.js has installed its handlers.
test('the daemon logs an uncaught exception before exiting', async () => {
  const root = await makeProjectTempDir('daemon-uncaught');
  await bootstrapAppData(root);

  const preload =
    'const write = process.stdout.write.bind(process.stdout);' +
    'process.stdout.write = (chunk, ...rest) => {' +
    '  if (String(chunk).includes("ready")) {' +
    '    setTimeout(() => { throw new Error("boom from test"); }, 0);' +
    '  }' +
    '  return write(chunk, ...rest);' +
    '};';
  const child = spawnDaemon({
    root,
    stubPort,
    nodeArgs: [`--import=data:text/javascript,${encodeURIComponent(preload)}`],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  try {
    const code = await exited;
    assert.equal(code, 1);
    assert.match(
      stderr,
      /^\d{4}-\d\d-\d\dT[\d:.]+Z \[daemon\] uncaught exception, exiting: Error: boom from test$/m,
    );
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await removeDaemonDataDir(root);
  }
});

// The registry is written before any wallet is built, so a daemon or
// worker that dies during an import leaves sources with no database.
// navcoin-js, asked to open one, makes a new wallet with a random phrase:
// the source then scanned, read "synced" with nothing in it, and
// re-importing the phrase was refused as a duplicate.
test(
  'a source whose wallet was never built reports that, on every start',
  { timeout: 180_000 },
  async () => {
    const root = await makeProjectTempDir('daemon-wallet-missing');
    await bootstrapAppData(root);

    // Registered the way the daemon's /import does it, with the wallets
    // left unbuilt.
    const { sources } = await importSources(
      {
        type: 'mnemonic',
        phrase:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      root,
      { createImportedWallet: async () => ({}) },
    );
    assert.ok(sources.length > 0);

    const untilEverySourceFailed = async () => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const status = await getDaemonStatus(root);
        if (
          status.sources.length === sources.length &&
          status.sources.every((source) => source.liveError)
        ) {
          return status;
        }
        // Never synced on the way, however briefly.
        for (const source of status.sources) {
          assert.notEqual(source.syncStatus, 'synced', source.id);
        }
        assert.ok(Date.now() < deadline, 'sources never reported an error');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };

    const assertFailed = (status) => {
      for (const source of status.sources) {
        assert.equal(source.syncStatus, 'error', source.id);
        assert.match(
          source.liveError,
          /wallet database .* missing or incomplete/,
        );
        assert.match(source.liveError, /Remove the source and import it again/);
      }
    };

    let child = spawnDaemon({ root, stubPort });
    try {
      await waitForReady(child);
      assertFailed(await untilEverySourceFailed());
      await stopDaemon(root);
      await waitForExit(child);

      // The random wallet navcoin-js made in each one's place is gone: a
      // later open would find a database with a master key and take it
      // for the user's.
      for (const source of sources) {
        const { dataFile } = getWalletStorageDetails(source.id, root);
        await assert.rejects(fs.access(dataFile), { code: 'ENOENT' });
      }

      child = spawnDaemon({ root, stubPort });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      await waitForReady(child);
      const deadline = Date.now() + 30_000;
      while (
        (output.match(/not opening source/g) ?? []).length < sources.length
      ) {
        assert.ok(Date.now() < deadline, `sources were opened:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assertFailed(await getDaemonStatus(root));

      await stopDaemon(root);
      await waitForExit(child);
    } finally {
      child.kill('SIGTERM');
      await waitForExit(child);
      await removeDaemonDataDir(root);
    }
  },
);

// Removing the derivations you do not want straight after an import is
// the natural thing to do, and their wallets are still being built then.
// The removal deleted the database under the worker writing it; the
// worker finished anyway, and the daemon opened a wallet for an id no
// longer in the registry.
test(
  'removing a source while its wallet is being built removes all of it',
  { timeout: 120_000 },
  async () => {
    const root = await makeProjectTempDir('daemon-remove-building');
    await bootstrapAppData(root);

    const child = spawnDaemon({ root, stubPort });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));

    try {
      await waitForReady(child);

      const imported = await importDaemonSource(
        {
          type: 'mnemonic',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      );
      const [removed, ...kept] = imported.sources;
      // Straight away: the import returns before any wallet is built.
      await removeDaemonSource(removed.id, root);

      // Every other derivation finishes building and opens.
      const deadline = Date.now() + 90_000;
      for (;;) {
        const status = await getDaemonStatus(root);
        assert.deepEqual(
          status.sources.map((source) => source.id).sort(),
          kept.map((source) => source.id).sort(),
        );
        if (status.sources.every((source) => source.connected)) break;
        assert.ok(Date.now() < deadline, `not all opened: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      // The removed one left nothing behind: no database a later worker or
      // open would find.
      const { dataFile } = getWalletStorageDetails(removed.id, root);
      await assert.rejects(fs.access(dataFile), { code: 'ENOENT' });
      // And its wallet really was being built when the removal came in,
      // or this test would pass without the case it is about.
      assert.ok(
        output.includes(`wallet created for ${removed.id}`),
        `its wallet was not being built: ${output}`,
      );

      await stopDaemon(root);
      await waitForExit(child);
    } finally {
      child.kill('SIGTERM');
      await waitForExit(child);
      await removeDaemonDataDir(root);
    }
  },
);
