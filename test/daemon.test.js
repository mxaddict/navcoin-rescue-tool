import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';

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
import { getProjectRoot, makeProjectTempDir } from './test-helpers.js';

const TEST_PORT = 46199;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(
      () => reject(new Error('daemon ready timeout')),
      3000,
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
