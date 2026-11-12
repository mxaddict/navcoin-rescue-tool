import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { bootstrapAppData, getLayout } from '../src/app-data.js';
import { APP_VERSION } from '../src/constants.js';
import { getDaemonStatus, stopDaemon } from '../src/daemon-client.js';
import { ensureDaemonRunning } from '../src/tui.js';
import {
  getProjectRoot,
  killPortHolders,
  makeProjectTempDir,
  startStubElectrumServer,
  TEST_DAEMON_PORT,
} from './test-helpers.js';

// The daemon is detached and outlives the client that started it. A user
// who upgraded kept driving the old daemon from the new TUI, so the fix
// they installed never ran. These tests put a fake daemon on the port that
// reports some version and check what `ntr start` and the TUI do with it.

let stub = null;

before(async () => {
  killPortHolders(TEST_DAEMON_PORT);
  stub = await startStubElectrumServer();
});

after(async () => {
  if (stub) await stub.close();
});

function appDataEnv(base) {
  if (process.platform === 'win32') return { APPDATA: base };
  if (process.platform === 'darwin') return { HOME: base };
  return { XDG_DATA_HOME: base };
}

function appDataRoot(base) {
  return process.platform === 'darwin'
    ? path.join(base, 'Library', 'Application Support', 'navcoin-rescue-tool')
    : path.join(base, 'navcoin-rescue-tool');
}

// Answers /status with the given version and, like the real one, replies
// to /daemon/stop and then lets go of the port.
function startFakeDaemon(version) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/daemon/stop') {
      response.end(JSON.stringify({ ok: true }), () => {
        server.close();
        server.closeAllConnections();
      });
      return;
    }
    response.end(JSON.stringify({ version, daemon: { pid: 4739 } }));
  });
  const closed = new Promise((resolve) => server.once('close', resolve));
  return new Promise((resolve) => {
    server.listen(TEST_DAEMON_PORT, '127.0.0.1', () =>
      resolve({
        requests,
        closed,
        close: () => {
          server.close();
          server.closeAllConnections();
          return closed;
        },
      }),
    );
  });
}

function runCli(base, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], {
      cwd: getProjectRoot(),
      env: {
        ...process.env,
        ...appDataEnv(base),
        NTR_DAEMON_PORT: String(TEST_DAEMON_PORT),
        NTR_ELECTRUM_NODES: `127.0.0.1:${stub.port}:ws`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withAppData(name, body) {
  const base = await makeProjectTempDir(name);
  const root = appDataRoot(base);
  await fs.mkdir(root, { recursive: true });
  await bootstrapAppData(root);
  try {
    await body({ base, root });
  } finally {
    // Whatever daemon a test left on the port is stopped through the API,
    // so the next file finds the port free.
    await stopDaemon(root).catch(() => {});
    killPortHolders(TEST_DAEMON_PORT);
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('ntr start replaces a daemon left running by another version', async () => {
  await withAppData('stale-cli', async ({ base, root }) => {
    const fake = await startFakeDaemon('0.2.8');

    const result = await runCli(base, ['start']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Stopped daemon 0\.2\.8 left running from an earlier version\./,
    );
    assert.ok(fake.requests.includes('POST /daemon/stop'));
    await fake.closed;

    const status = await getDaemonStatus(root);
    assert.equal(status.version, APP_VERSION);
  });
});

test('ntr start leaves a daemon of the same version running', async () => {
  await withAppData('current-cli', async ({ base }) => {
    const fake = await startFakeDaemon(APP_VERSION);
    try {
      const result = await runCli(base, ['start']);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Daemon already running with pid 4739\./);
      assert.ok(!fake.requests.includes('POST /daemon/stop'));
    } finally {
      await fake.close();
    }
  });
});

test('the TUI replaces a daemon left running by another version', async () => {
  await withAppData('stale-tui', async ({ root }) => {
    const fake = await startFakeDaemon('0.2.8');
    const lines = [];
    const previousNodes = process.env.NTR_ELECTRUM_NODES;
    process.env.NTR_ELECTRUM_NODES = `127.0.0.1:${stub.port}:ws`;
    try {
      const running = await ensureDaemonRunning(root, getLayout(root), (l) =>
        lines.push(l),
      );
      assert.equal(running, true, lines.join('\n'));
    } finally {
      if (previousNodes === undefined) delete process.env.NTR_ELECTRUM_NODES;
      else process.env.NTR_ELECTRUM_NODES = previousNodes;
    }

    assert.ok(fake.requests.includes('POST /daemon/stop'));
    assert.ok(
      lines.some((l) =>
        l.includes(
          'Stopped daemon 0.2.8 left running from an earlier version.',
        ),
      ),
      lines.join('\n'),
    );
    const status = await getDaemonStatus(root);
    assert.equal(status.version, APP_VERSION);
  });
});
