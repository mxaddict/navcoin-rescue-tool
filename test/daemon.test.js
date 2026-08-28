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
import {
  killPortHolders,
  makeProjectTempDir,
  spawnDaemon,
  startStubElectrumServer,
  waitForDaemonReady as waitForReady,
  waitForExit,
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

    const status = await getDaemonStatus(root);
    assert.equal(status.daemon.status, 'running');

    await stopDaemon(root);
    await waitForExit(child);

    const finalState = await readStatus(root);
    assert.equal(finalState.daemon.status, 'stopped');
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await fs.rm(root, { recursive: true, force: true });
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
        walletType: 'navcoin-js-v1',
        phrase:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      root,
    );

    assert.equal(imported.source.status, 'ready');
    assert.equal(imported.source.syncStatus, 'wallet-created');
    assert.equal(imported.source.walletType, 'navcoin-js-v1');

    const status = await getDaemonStatus(root);
    assert.equal(status.sourceCount, 1);
    assert.equal(status.sources[0].id, imported.source.id);
    assert.equal(status.sources[0].walletType, 'navcoin-js-v1');

    await assert.rejects(
      importDaemonSource(
        {
          type: 'mnemonic',
          walletType: 'navcoin-js-v1',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      ),
      /Duplicate source/,
    );

    const reloaded = await readStatus(root);
    assert.equal(reloaded.sources.sources.length, 1);

    await removeDaemonSource(imported.source.id, root);
    const finalState = await readStatus(root);
    assert.deepEqual(finalState.sources.sources, []);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('daemon accepts coinomi and dedupes it against navcoin-js-v1', async () => {
  const root = await makeProjectTempDir('daemon');
  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  await bootstrapAppData(root);

  const child = spawnDaemon({ root: root, stubPort });

  try {
    await waitForReady(child);

    const imported = await importDaemonSource(
      { type: 'mnemonic', walletType: 'coinomi', phrase },
      root,
    );

    assert.equal(imported.source.status, 'ready');
    assert.equal(imported.source.walletType, 'coinomi');

    const status = await getDaemonStatus(root);
    assert.equal(status.sourceCount, 1);
    assert.equal(status.sources[0].walletType, 'coinomi');

    // Coinomi derives at the navcoin-js-v1 path, so the same phrase under
    // that type is the same keys and must not become a second source.
    await assert.rejects(
      importDaemonSource(
        { type: 'mnemonic', walletType: 'navcoin-js-v1', phrase },
        root,
      ),
      /Duplicate source/,
    );

    const reloaded = await readStatus(root);
    assert.equal(reloaded.sources.sources.length, 1);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await fs.rm(root, { recursive: true, force: true });
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

    assert.equal(imported.source.status, 'ready');
    assert.equal(imported.source.type, 'private-key');

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await fs.rm(root, { recursive: true, force: true });
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
    assert.equal(imported.source.type, 'private-key');
    const sourceId = imported.source.id;

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
    await fs.rm(root, { recursive: true, force: true });
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
    assert.equal(imported.source.type, 'private-key');

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
    assert.equal(reimported.source.status, 'ready');
    assert.equal(reimported.source.type, 'private-key');

    // 5. Daemon still reachable — no crash.
    const finalStatus = await getDaemonStatus(root);
    assert.equal(finalStatus.sourceCount, 1);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await fs.rm(root, { recursive: true, force: true });
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
    await fs.rm(root, { recursive: true, force: true });
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
          walletType: 'navcoin-js-v1',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      ),
      /Unsupported source type/,
    );
    let state = await readStatus(root);
    assert.equal(state.sources.sources.length, 0);

    // Unsupported wallet type.
    await assert.rejects(
      importDaemonSource(
        {
          type: 'mnemonic',
          walletType: 'navcoin-blah',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      ),
      /Unsupported wallet type/,
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
        walletType: 'navcoin-js-v1',
        phrase:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      root,
    );
    assert.equal(imported.source.status, 'ready');
    const finalState = await readStatus(root);
    assert.equal(finalState.sources.sources.length, 1);

    await stopDaemon(root);
    await waitForExit(child);
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await fs.rm(root, { recursive: true, force: true });
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

    try {
      await waitForReady(child);

      // Import the well-known abandon mnemonic.
      const imported = await importDaemonSource(
        {
          type: 'mnemonic',
          walletType: 'navcoin-js-v1',
          phrase:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        root,
      );

      assert.equal(imported.source.walletType, 'navcoin-js-v1');

      // Poll until syncStatus === 'synced' AND the expected balance is credited.
      // rescue-scan runs concurrently with the wallet's built-in Sync(); the
      // wallet emits sync_finished quickly (before rescue-scan finishes), then
      // rescue-scan emits a second sync_finished when it's done. We must wait
      // for the balance to reflect the rescue-scan results, not just the first
      // sync_finished.
      const SYNC_TIMEOUT_MS = 90_000;
      const POLL_INTERVAL_MS = 500;
      const expectedNav = fixture.expectedNavConfirmed;
      const expectedXNav = fixture.expectedXNavConfirmed;
      const start = Date.now();
      let status;

      while (true) {
        if (Date.now() - start > SYNC_TIMEOUT_MS) {
          throw new Error(
            `Wallet did not reach syncStatus='synced' with expected NAV+xNAV balance within ${SYNC_TIMEOUT_MS}ms. ` +
              `Last status: ${JSON.stringify(status?.sources?.[0])}`,
          );
        }

        status = await getDaemonStatus(root);
        const src = status.sources?.[0];

        if (
          src?.syncStatus === 'synced' &&
          src?.balance?.nav?.confirmed === expectedNav &&
          src?.balance?.xnav?.confirmed === expectedXNav
        )
          break;

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      const src = status.sources[0];
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
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
