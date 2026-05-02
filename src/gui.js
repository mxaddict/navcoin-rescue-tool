#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// During MVP development, `ntr-gui` shells out to `tauri dev`, which
// builds the Rust shell, starts the Svelte frontend dev server, and
// opens the GUI window. Released archives will replace this with a
// direct exec of the bundled binary.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const proc = spawn('npx', ['tauri', 'dev'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

proc.on('exit', (code) => process.exit(code ?? 0));
proc.on('error', (err) => {
  process.stderr.write(`ntr-gui: failed to launch tauri dev: ${err.message}\n`);
  process.exit(1);
});
