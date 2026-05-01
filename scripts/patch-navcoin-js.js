#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const copies = [
  {
    source: path.join(
      repoRoot,
      'scripts',
      'navcoin-js-dist',
      'lib',
      'wallet.js',
    ),
    target: path.join(
      repoRoot,
      'node_modules',
      'navcoin-js',
      'dist',
      'lib',
      'wallet.js',
    ),
  },
  {
    source: path.join(
      repoRoot,
      'scripts',
      'navcoin-js-dist',
      'lib',
      'db',
      'dexie.js',
    ),
    target: path.join(
      repoRoot,
      'node_modules',
      'navcoin-js',
      'dist',
      'lib',
      'db',
      'dexie.js',
    ),
  },
];

const missing = copies.filter(
  ({ source, target }) => !fs.existsSync(source) || !fs.existsSync(target),
);

if (missing.length > 0) {
  console.log('patch-navcoin-js: source or target file missing, skipping');
  process.exit(0);
}

for (const { source, target } of copies) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

console.log('patch-navcoin-js: copied patched navcoin-js dist files');
