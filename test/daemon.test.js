import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  stopDaemon,
} from '../src/daemon-client.js';

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(
      () => reject(new Error('daemon ready timeout')),
      3000
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

async function portInUse() {
  try {
    await fetch('http://127.0.0.1:46117/status');
    return true;
  } catch {
    return false;
  }
}

test('daemon status requires auth cookie and supports stop', async (t) => {
  if (await portInUse()) {
    t.skip('port 46117 already in use');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntr-daemon-'));
  const projectRoot = path.join(import.meta.dirname, '..');

  await bootstrapAppData(root);

  const child = spawn(process.execPath, ['src/daemon.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NTR_APP_DATA: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForReady(child);

    const authCookie = await readAuthCookie(root);
    const unauthorized = await fetch('http://127.0.0.1:46117/status');
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch('http://127.0.0.1:46117/status', {
      headers: { Authorization: authCookie },
    });
    assert.equal(authorized.status, 200);

    const status = await getDaemonStatus(root);
    assert.equal(status.daemon.status, 'running');

    await stopDaemon(root);
    await new Promise((resolve) => child.on('exit', resolve));

    const finalState = await readStatus(root);
    assert.equal(finalState.daemon.status, 'stopped');
  } finally {
    child.kill('SIGTERM');
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('daemon import persists sources and rejects duplicates', async (t) => {
  if (await portInUse()) {
    t.skip('port 46117 already in use');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntr-daemon-'));
  const projectRoot = path.join(import.meta.dirname, '..');

  await bootstrapAppData(root);

  const child = spawn(process.execPath, ['src/daemon.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NTR_APP_DATA: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForReady(child);

    const imported = await importDaemonSource(
      {
        type: 'mnemonic',
        walletType: 'navcoin-core',
        label: 'Main wallet',
        phrase:
          'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
      },
      root
    );

    assert.equal(imported.source.label, 'Main wallet');
    assert.equal(imported.source.status, 'imported');

    const status = await getDaemonStatus(root);
    assert.equal(status.sourceCount, 1);
    assert.equal(status.sources[0].id, imported.source.id);

    await assert.rejects(
      importDaemonSource(
        {
          type: 'mnemonic',
          walletType: 'navcoin-core',
          label: 'Duplicate wallet',
          phrase:
            'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
        },
        root
      ),
      /Duplicate source/
    );

    const reloaded = await readStatus(root);
    assert.equal(reloaded.sources.sources.length, 1);

    await removeDaemonSource(imported.source.id, root);
    const finalState = await readStatus(root);
    assert.deepEqual(finalState.sources.sources, []);

    await stopDaemon(root);
    await new Promise((resolve) => child.on('exit', resolve));
  } finally {
    child.kill('SIGTERM');
    await fs.rm(root, { recursive: true, force: true });
  }
});
