// The force sweep reaches the user through three front ends, all of them
// driving the same two daemon endpoints. These cover each front end's own
// boundary: that `force` crosses it, and that the retry is offered only
// when forcing could actually help.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { cmdSweep } from '../src/tui.js';
import {
  getProjectRoot,
  killPortHolders,
  makeProjectTempDir,
  spawnDaemon,
  startStubElectrumServer,
  TEST_DAEMON_PORT,
  waitForDaemonReady,
  waitForExit,
} from './test-helpers.js';

const BASE_URL = `http://127.0.0.1:${TEST_DAEMON_PORT}`;

let stubPort = 0;
let stubClose = null;

before(async () => {
  killPortHolders();
  const stub = await startStubElectrumServer();
  stubPort = stub.port;
  stubClose = stub.close;
});

after(async () => {
  if (stubClose) await stubClose();
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

async function withDaemon(name, body) {
  const base = await makeProjectTempDir(name);
  const root = appDataRoot(base);
  await fs.mkdir(root, { recursive: true });
  await bootstrapAppData(root);
  const child = spawnDaemon({ root, stubPort });

  try {
    await waitForDaemonReady(child);
    const cookie = await fs.readFile(path.join(root, 'auth.cookie'), 'utf8');
    await body({ base, root, cookie: cookie.trim() });
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await fs.rm(base, { recursive: true, force: true });
  }
}

function runCli(base, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], {
      cwd: getProjectRoot(),
      env: {
        ...process.env,
        ...appDataEnv(base),
        NTR_DAEMON_PORT: String(TEST_DAEMON_PORT),
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

// Both endpoints take `force` in the body. A daemon that ignored it would
// answer a forced request exactly as it answers an unforced one, so the
// wire test is that a bodyless POST and a forced POST both parse and that
// the flag is read from the body rather than the URL.
test('the sweep endpoints accept a force flag in the body', async () => {
  await withDaemon('sweep-force-wire', async ({ cookie }) => {
    const headers = {
      Authorization: cookie,
      'Content-Type': 'application/json',
    };

    const forced = await fetch(`${BASE_URL}/sweep/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ force: true }),
    });
    assert.equal(forced.status, 400);
    // With nothing imported there is nothing to force past, and the
    // daemon has to say that rather than treat force as permission to
    // broadcast an empty sweep.
    assert.match((await forced.json()).error, /No imported sources/);

    // The GUI's client posts a body; the CLI's posts one too. A daemon
    // that required one would still have to survive an empty POST, which
    // is what an older client sends.
    const bodyless = await fetch(`${BASE_URL}/sweep/prepare`, {
      method: 'POST',
      headers: { Authorization: cookie },
    });
    assert.equal(bodyless.status, 400);
    assert.match((await bodyless.json()).error, /No imported sources/);
  });
});

test('the CLI reads --force without eating the destination', async () => {
  await withDaemon('sweep-force-cli', async ({ base }) => {
    const forced = await runCli(base, ['sweep', 'NDestAddr1', '--force']);

    assert.equal(forced.code, 1);
    assert.match(forced.stderr, /No imported sources/);
    assert.doesNotMatch(
      forced.stderr,
      /Usage:/,
      '--force must not be read as the destination',
    );

    // The hint names the flag, so it must not appear on a failure the
    // flag cannot fix — nor when the user already passed it.
    assert.doesNotMatch(forced.stderr, /--force\n/);

    const unforced = await runCli(base, ['sweep', 'NDestAddr1']);
    assert.equal(unforced.code, 1);
    assert.doesNotMatch(
      unforced.stderr,
      /sweep anyway/i,
      'no sources at all is not something forcing gets past',
    );
  });
});

test('the CLI still refuses a sweep with no destination', async () => {
  await withDaemon('sweep-force-cli-usage', async ({ base }) => {
    const result = await runCli(base, ['sweep', '--force']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /--force/);
  });
});

// cmdSweep takes its collaborators as parameters, so the whole flow runs
// here.
function fakeTui() {
  const asked = [];
  const logged = [];
  const C = new Proxy({}, { get: () => (s) => s });

  return {
    asked,
    logged,
    args: [
      C,
      (line) => logged.push(line),
      (question) => {
        asked.push(question);
        return Promise.resolve('');
      },
    ],
  };
}

test('the TUI does not offer to force past a failure forcing cannot fix', async () => {
  await withDaemon('sweep-force-tui', async ({ root }) => {
    const tui = fakeTui();
    const [C, log, ask] = tui.args;

    await cmdSweep(C, root, log, ask);

    assert.ok(
      tui.logged.some((line) => /No imported sources/.test(line)),
      `the block must be reported: ${JSON.stringify(tui.logged)}`,
    );
    assert.deepEqual(tui.asked, [], 'nothing to force past, so nothing to ask');
  });
});
