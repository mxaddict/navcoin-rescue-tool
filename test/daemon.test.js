import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import {
  getProjectRoot,
  makeProjectTempDir,
  startStubElectrumServer,
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
  const result = spawnSync('lsof', ['-ti', `tcp:${TEST_PORT}`], {
    encoding: 'utf8',
  });
  if (!result.error) {
    const pids = result.stdout.trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  const stub = await startStubElectrumServer();
  stubPort = stub.port;
  stubClose = stub.close;
});

after(async () => {
  if (stubClose) await stubClose();
});

// Generous: booting the daemon pulls in navcoin-js and its native deps,
// which takes seconds on a cold CI runner (3s flaked on Windows). The
// test still fails if 'ready' never arrives — this only bounds the wait.
const READY_TIMEOUT_MS = 30_000;

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(
      () => reject(new Error('daemon ready timeout')),
      READY_TIMEOUT_MS,
    );

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`daemon exited early: ${code}`));
    });
  });
}

function waitForExit(child) {
  // If already exited, resolve immediately.
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', resolve));
}

function spawnDaemon(projectRoot, root) {
  return spawn(process.execPath, ['src/daemon.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NTR_APP_DATA: root,
      NTR_DAEMON_PORT: String(TEST_PORT),
      NTR_ELECTRUM_NODES: `127.0.0.1:${stubPort}:ws`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('daemon status requires auth cookie and supports stop', async () => {
  const root = await makeProjectTempDir('daemon');
  const projectRoot = getProjectRoot();

  await bootstrapAppData(root);

  const child = spawnDaemon(projectRoot, root);

  try {
    await waitForReady(child);

    const authCookie = await readAuthCookie(root);
    const unauthorized = await fetch(`${BASE_URL}/status`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${BASE_URL}/status`, {
      headers: { Authorization: authCookie },
    });
    assert.equal(authorized.status, 200);

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
  const projectRoot = getProjectRoot();

  await bootstrapAppData(root);

  const child = spawnDaemon(projectRoot, root);

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

test('daemon private-key import works', async () => {
  const root = await makeProjectTempDir('daemon');
  const projectRoot = getProjectRoot();

  await bootstrapAppData(root);

  const child = spawnDaemon(projectRoot, root);

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
  const projectRoot = getProjectRoot();

  await bootstrapAppData(root);

  let child = spawnDaemon(projectRoot, root);

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
    child = spawnDaemon(projectRoot, root);
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
  const projectRoot = getProjectRoot();

  await bootstrapAppData(root);

  let child = spawnDaemon(projectRoot, root);

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

    child = spawnDaemon(projectRoot, root);
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
  const projectRoot = getProjectRoot();

  await bootstrapAppData(root);

  const child = spawnDaemon(projectRoot, root);

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
  const projectRoot = getProjectRoot();

  await bootstrapAppData(root);

  const child = spawnDaemon(projectRoot, root);

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
    const pRoot = getProjectRoot();

    await bootstrapAppData(root);

    const child = spawn(process.execPath, ['src/daemon.js'], {
      cwd: pRoot,
      env: {
        ...process.env,
        NTR_APP_DATA: root,
        NTR_DAEMON_PORT: String(TEST_PORT),
        NTR_ELECTRUM_NODES: `127.0.0.1:${fixtureStub.port}:ws`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
