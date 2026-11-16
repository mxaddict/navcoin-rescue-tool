import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootstrapAppData,
  ensureAuthCookie,
  getAppDataRoot,
  readAuthCookie,
  readStatus,
  writeDaemonState,
  writeJsonFileAtomic,
} from '../src/app-data.js';
import { makeProjectTempDir } from './test-helpers.js';

test('getAppDataRoot uses platform-specific locations', () => {
  assert.equal(
    getAppDataRoot('linux', { XDG_DATA_HOME: '/tmp/data' }),
    path.join('/tmp/data', 'navcoin-rescue-tool'),
  );
  assert.equal(
    getAppDataRoot('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }),
    path.join('C:\\Users\\me\\AppData\\Roaming', 'navcoin-rescue-tool'),
  );
});

test('bootstrapAppData creates initial metadata files', async () => {
  const root = await makeProjectTempDir('app-data');

  try {
    await bootstrapAppData(root);
    const status = await readStatus(root);
    const authCookie = await fs.readFile(
      path.join(root, 'auth.cookie'),
      'utf8',
    );

    assert.equal(status.daemon.status, 'initialized');
    assert.deepEqual(status.sources, { sources: [] });
    assert.match(authCookie, /^[a-f0-9]+\n$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Windows has no such modes; see `keepPrivate`.
test(
  'bootstrapAppData closes the app data to other users',
  { skip: process.platform === 'win32' },
  async () => {
    // Not under the project: a checkout on a filesystem without modes
    // would pass this without checking anything.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntr-private-'));
    const mode = async (...parts) =>
      (await fs.stat(path.join(root, ...parts))).mode & 0o777;

    try {
      // As an earlier version, or the launcher, left them.
      await fs.chmod(root, 0o755);
      await fs.mkdir(path.join(root, 'wallets'), { mode: 0o755 });
      await fs.mkdir(path.join(root, 'logs'), { mode: 0o755 });
      await fs.writeFile(path.join(root, 'logs', 'daemon.log'), 'old', {
        mode: 0o644,
      });
      await fs.chmod(path.join(root, 'logs', 'daemon.log'), 0o644);
      assert.equal(await mode('logs', 'daemon.log'), 0o644);

      await bootstrapAppData(root);

      assert.equal(await mode(), 0o700);
      assert.equal(await mode('wallets'), 0o700);
      assert.equal(await mode('logs'), 0o700);
      assert.equal(await mode('logs', 'daemon.log'), 0o600);
      assert.equal(await mode('sources.json'), 0o600);
      assert.equal(await mode('auth.cookie'), 0o600);
      assert.equal(
        await fs.readFile(path.join(root, 'logs', 'daemon.log'), 'utf8'),
        'old',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

// The daemon writes the source registry from several places that run at
// once — every derivation of a phrase marks itself synced when its scan
// ends. Writes sharing one temp file overlapped there: a shorter one
// landed on top of a longer one, the longer one's tail survived, and the
// rename published that as sources.json — corrupt, and unreadable on the
// next start.
test('concurrent atomic writes leave one whole file, never a mix', async () => {
  const root = await makeProjectTempDir('atomic-write');
  const file = path.join(root, 'state.json');
  const values = Array.from({ length: 20 }, (_, i) => ({
    writer: i,
    padding: 'x'.repeat((i % 5) * 400),
  }));

  try {
    await Promise.all(values.map((value) => writeJsonFileAtomic(file, value)));

    const written = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(written, values[written.writer]);
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
      [],
      'no temp file left behind',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// The daemon answers /status by reading daemon.json, and writes it when it
// starts listening — while `ntr start` is already polling /status. On
// Windows a rename onto a file this process has open for reading fails
// with EPERM, and the daemon died at start on one. Reads and writes of
// these files must not overlap.
test('reading and writing daemon state at once never fails', async () => {
  const root = await makeProjectTempDir('app-data-read-write');

  try {
    await bootstrapAppData(root);
    // /status polls keep arriving for as long as the daemon is writing.
    let writing = true;
    const poll = async () => {
      while (writing) await readStatus(root);
    };
    // Settled rather than awaited one by one, so a poller that fails early
    // is still reported, and a failed write is not hidden behind it.
    const pollers = Promise.allSettled([poll(), poll(), poll()]);
    try {
      for (let round = 0; round < 200; round += 1) {
        await writeDaemonState({ status: 'running', round }, root);
      }
    } finally {
      writing = false;
    }
    for (const result of await pollers) {
      if (result.status === 'rejected') throw result.reason;
    }
    assert.equal((await readStatus(root)).daemon.round, 199);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// The daemon lets a request in when its Authorization header equals the
// cookie. An empty cookie file, as a full disk or a crash during the first
// write leaves, made that the empty string: an empty header passed, and
// the CLI went on working, so nothing looked wrong.
test('a cookie file that does not hold a whole cookie is replaced', async () => {
  const root = await makeProjectTempDir('app-data-cookie');
  const cookieFile = path.join(root, 'auth.cookie');

  try {
    await bootstrapAppData(root);
    const original = await ensureAuthCookie(root);
    assert.match(original, /^[0-9a-f]{48}$/);
    // A good cookie is kept: clients already hold it.
    assert.equal(await ensureAuthCookie(root), original);

    for (const broken of ['', '\n', original.slice(0, 20), 'not a cookie']) {
      await fs.writeFile(cookieFile, broken);
      const replaced = await ensureAuthCookie(root);
      assert.match(replaced, /^[0-9a-f]{48}$/, JSON.stringify(broken));
      assert.notEqual(replaced, original);
      assert.equal(await readAuthCookie(root), replaced);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
