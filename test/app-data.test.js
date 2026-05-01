import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bootstrapAppData,
  getAppDataRoot,
  readStatus,
} from '../src/app-data.js';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntr-'));

  await bootstrapAppData(root);
  const status = await readStatus(root);
  const authCookie = await fs.readFile(path.join(root, 'auth.cookie'), 'utf8');

  assert.equal(status.daemon.status, 'initialized');
  assert.deepEqual(status.sources, { sources: [] });
  assert.match(authCookie, /^[a-f0-9]+\n$/);
});
