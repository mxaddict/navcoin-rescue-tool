// The mnemonic checksum check reaches the user through three front ends.
// All three import through the daemon, so the check itself lives in one
// place — these cover that each front end actually carries the rejection
// and the waiver across its own boundary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { cmdImportMnemonic } from '../src/tui.js';
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

// One wordlist-valid word changed, so every word is real and only the
// checksum catches it — the shape of an actual transcription slip.
const BROKEN_BIP39 =
  'legal winner thank year wave sausage worth useful legal winner thank zoo';

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

// The daemon takes its data directory from NTR_APP_DATA, but the CLI
// resolves its own with getAppDataRoot(). To have both land on the same
// temp directory, point this platform's data home at `base` and derive
// the root the same way getAppDataRoot() does.
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

// Boot a daemon, run `body`, and tear everything down again.
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

function postImport(cookie, payload) {
  return fetch(`${BASE_URL}/import`, {
    method: 'POST',
    headers: { Authorization: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// The GUI's client (gui/src/lib/daemon.js) reads `error`, `code` and
// `waivable` off this body and rebuilds an Error from them, so the wire
// shape is the GUI's half of the check.
test('the daemon rejects a broken phrase with a code the GUI can branch on', async () => {
  await withDaemon('import-validation-wire', async ({ cookie }) => {
    const response = await postImport(cookie, {
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
      phrase: BROKEN_BIP39,
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'mnemonic-checksum');
    assert.ok(!body.waivable, 'navcoin-js-v1 cannot waive the checksum');
    assert.ok(!body.error.includes('sausage'), 'the phrase must not come back');
  });
});

test('the daemon marks a navcoin-core rejection waivable and honours the waiver', async () => {
  await withDaemon('import-validation-waiver', async ({ cookie }) => {
    const refused = await postImport(cookie, {
      type: 'mnemonic',
      walletType: 'navcoin-core',
      phrase: BROKEN_BIP39,
    });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).waivable, true);

    const accepted = await postImport(cookie, {
      type: 'mnemonic',
      walletType: 'navcoin-core',
      phrase: BROKEN_BIP39,
      allowUncheckedMnemonic: true,
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).source.walletType, 'navcoin-core');
  });
});

// The waiver is a navcoin-core affordance. Letting it through for a type
// that builds a bitcore Mnemonic would only move the failure into the
// background worker, which is where the phrase leaked into the log.
test('a waiver does not get a broken phrase past navcoin-js-v1', async () => {
  await withDaemon('import-validation-no-waiver', async ({ cookie }) => {
    const response = await postImport(cookie, {
      type: 'mnemonic',
      walletType: 'navcoin-js-v1',
      phrase: BROKEN_BIP39,
      allowUncheckedMnemonic: true,
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'mnemonic-checksum');
  });
});

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

test('the CLI refuses a broken phrase and names the flag that overrides it', async () => {
  await withDaemon('import-validation-cli', async ({ base }) => {
    const refused = await runCli(base, [
      'import',
      'mnemonic',
      '--wallet-type',
      'navcoin-core',
      '--phrase',
      BROKEN_BIP39,
    ]);

    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /BIP39 checksum/);
    assert.match(refused.stderr, /--allow-unchecked-mnemonic/);
    assert.ok(
      !refused.stderr.includes('sausage'),
      'the CLI must not echo the phrase',
    );

    const accepted = await runCli(base, [
      'import',
      'mnemonic',
      '--wallet-type',
      'navcoin-core',
      '--phrase',
      BROKEN_BIP39,
      '--allow-unchecked-mnemonic',
    ]);

    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /Imported source:/);
  });
});

// A bare boolean flag must not swallow the token after it. Before the flag
// was declared boolean, `--allow-unchecked-mnemonic mnemonic` would have
// eaten the import subtype.
test('the CLI flag does not consume the argument after it', async () => {
  await withDaemon('import-validation-cli-flag', async ({ base }) => {
    const result = await runCli(base, [
      'import',
      'mnemonic',
      '--allow-unchecked-mnemonic',
      '--wallet-type',
      'navcoin-core',
      '--phrase',
      BROKEN_BIP39,
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Wallet type: navcoin-core/);
  });
});

// The TUI takes every collaborator as a parameter, so the whole flow runs
// here: it asks for a type and a phrase, is refused, offers the override,
// and retries with it.
function fakeTui(answers) {
  const asked = [];
  const logged = [];
  const C = new Proxy({}, { get: () => (s) => s });

  return {
    asked,
    logged,
    args: [
      C,
      null,
      (line) => logged.push(line),
      (question) => {
        asked.push(question);
        return Promise.resolve(answers.shift());
      },
      () => null,
      () => {},
    ],
  };
}

test('the TUI offers the override after a waivable rejection and retries with it', async () => {
  await withDaemon('import-validation-tui', async ({ root }) => {
    const tui = fakeTui(['navcoin-core', BROKEN_BIP39, 'yes']);
    tui.args[1] = root;
    await cmdImportMnemonic(...tui.args);

    assert.ok(
      tui.asked.some((q) => /Import it anyway/.test(q)),
      `expected an override prompt, asked: ${JSON.stringify(tui.asked)}`,
    );
    assert.ok(
      tui.logged.some((line) => /Imported:/.test(line)),
      `expected the retry to import, logged: ${JSON.stringify(tui.logged)}`,
    );
  });
});

test('the TUI cancels instead of importing when the override is declined', async () => {
  await withDaemon('import-validation-tui-no', async ({ root }) => {
    const tui = fakeTui(['navcoin-core', BROKEN_BIP39, 'no']);
    tui.args[1] = root;
    await cmdImportMnemonic(...tui.args);

    assert.ok(
      tui.logged.some((line) => /Import cancelled/.test(line)),
      `expected a cancel, logged: ${JSON.stringify(tui.logged)}`,
    );
    assert.ok(
      !tui.logged.some((line) => /Imported:/.test(line)),
      'nothing may be imported after declining',
    );
  });
});

// A type that cannot waive gets no prompt at all — offering one would
// promise something the daemon will refuse.
test('the TUI does not offer an override it cannot use', async () => {
  await withDaemon('import-validation-tui-hard', async ({ root }) => {
    const tui = fakeTui(['navcoin-js-v1', BROKEN_BIP39]);
    tui.args[1] = root;
    await cmdImportMnemonic(...tui.args);

    assert.ok(
      !tui.asked.some((q) => /Import it anyway/.test(q)),
      'navcoin-js-v1 must not be offered the override',
    );
    assert.ok(
      tui.logged.some((line) => /Import failed/.test(line)),
      `expected a failure, logged: ${JSON.stringify(tui.logged)}`,
    );
  });
});
