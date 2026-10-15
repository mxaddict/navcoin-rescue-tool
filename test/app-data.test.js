import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootstrapAppData,
  getAppDataRoot,
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
