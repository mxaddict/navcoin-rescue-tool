import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { APP_VERSION } from '../src/constants.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readText(...parts) {
  return fs.readFile(path.join(repoRoot, ...parts), 'utf8');
}

// The GUI decides whether the daemon already on the port is its own by
// comparing the version the daemon reports on /status against the one
// compiled into the GUI. That comparison is only meaningful while every
// manifest carries the same number: a Cargo.toml left behind at the
// previous version makes the GUI stop and relaunch a daemon that was
// already the right one, on every launch.
test('version manifests agree', async () => {
  const cargo = await readText('src-tauri', 'Cargo.toml');
  const cargoVersion = cargo.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(cargoVersion, 'src-tauri/Cargo.toml declares a version');

  const tauriConf = JSON.parse(await readText('src-tauri', 'tauri.conf.json'));

  assert.equal(
    cargoVersion,
    APP_VERSION,
    'src-tauri/Cargo.toml matches package.json',
  );
  assert.equal(
    tauriConf.version,
    APP_VERSION,
    'src-tauri/tauri.conf.json matches package.json',
  );
});

// APP_VERSION is what the daemon puts on /status. Reading it from the
// manifest rather than a literal is the reason a bump stays a one-file
// change, so a hardcoded copy drifting back in has to fail here.
test('the reported version comes from package.json', async () => {
  const pkg = JSON.parse(await readText('package.json'));

  assert.equal(APP_VERSION, pkg.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
});
