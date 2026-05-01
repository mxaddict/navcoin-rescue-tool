#!/usr/bin/env node
/**
 * Patches navcoin-js dist to fix the sleep() function in ManageElectrumError.
 *
 * The original sleep() calls msleep() without await, so the delay has no
 * effect and the reconnect loop spins at full speed through dead servers.
 * This patch makes sleep() async and properly awaits msleep(), and also
 * rewrites the compiled dist call sites to await sleep() where upstream fixed
 * the source but the published npm dist has not yet been regenerated.
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

const replacements = [
  [
    'function sleep(n) {\n  msleep(n * 1000);\n}',
    'async function sleep(n) {\n  await msleep(n * 1000);\n}',
  ],
  ['sleep(5);\n        await this.Connect(true);', 'await sleep(5);\n        await this.Connect(true);'],
  ['sleep(1);\n        await this.Connect(false);', 'await sleep(1);\n        await this.Connect(false);'],
  ['if (e === "server busy - request timed out") {\n      sleep(5);', 'if (e === "server busy - request timed out") {\n      await sleep(5);'],
  ['await this.ManageElectrumError(e);\n        sleep(1);', 'await this.ManageElectrumError(e);\n        await sleep(1);'],
  ['await this.ManageElectrumError(e);\n        sleep(3);', 'await this.ManageElectrumError(e);\n        await sleep(3);'],
];

let changed = false;
for (const [broken, fixed] of replacements) {
  if (content.includes(fixed)) continue;
  if (content.includes(broken)) {
    content = content.replace(broken, fixed);
    changed = true;
  }
}

if (!changed) {
  console.log('patch-navcoin-js: already patched or upstream dist already fixed');
  process.exit(0);
}

fs.writeFileSync(target, content, 'utf8');
console.log('patch-navcoin-js: patched sleep() and await call sites');
