#!/usr/bin/env node
/**
 * Patches navcoin-js dist to fix the sleep() function in ManageElectrumError.
 *
 * The original sleep() calls msleep() without await, so the delay has no
 * effect and the reconnect loop spins at full speed through dead servers.
 * This patch makes sleep() async and properly awaits msleep().
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'navcoin-js',
  'dist',
  'lib',
  'wallet.js',
);

if (!fs.existsSync(target)) {
  console.log('patch-navcoin-js: target not found, skipping');
  process.exit(0);
}

let content = fs.readFileSync(target, 'utf8');

const broken = 'function sleep(n) {\n  msleep(n * 1000);\n}';
const fixed = 'async function sleep(n) {\n  await msleep(n * 1000);\n}';

if (content.includes(fixed)) {
  console.log('patch-navcoin-js: already patched');
  process.exit(0);
}

if (!content.includes(broken)) {
  console.log(
    'patch-navcoin-js: pattern not found, may already be fixed upstream',
  );
  process.exit(0);
}

content = content.replace(broken, fixed);
fs.writeFileSync(target, content, 'utf8');
console.log('patch-navcoin-js: patched sleep() to async/await');
