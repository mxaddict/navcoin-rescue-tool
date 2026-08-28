#!/usr/bin/env node

/**
 * Wallet worker — runs in a child process so wallet.Load() cannot block
 * the daemon's HTTP server or the main process event loop, and so the
 * indexeddb shim is always initialised against the right directory. The
 * shim keeps its registry handle in a module-level variable that nothing
 * resets, so a process that has already opened one wallets directory
 * cannot be repointed at another.
 *
 * Input:  JSON on stdin  { source, walletsDir, password }
 *                     or { mode: 'forget', databaseName, walletsDir }
 * Output: JSON on stdout { ok: true, storage } | { ok: false, error }
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import { getDerivationWalletType } from './constants.js';

process.on('uncaughtException', (error) => {
  try {
    process.stdout.write(
      JSON.stringify({ ok: false, error: `uncaught: ${error.message}` }),
    );
  } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  try {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: `unhandled: ${error?.message ?? String(error)}`,
      }),
    );
  } catch {}
  process.exit(1);
});

['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    try {
      process.stdout.write(
        JSON.stringify({ ok: false, error: `killed by ${sig}` }),
      );
    } catch {}
    process.exit(1);
  });
});

const require = createRequire(import.meta.url);

const PRIVATE_KEY_CONTAINER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function getWalletInitialPoolSize(source) {
  // Initial creation uses a small pool for speed; rescueScan derives the rest.
  return source.type === 'private-key' ? 0 : 10;
}

async function prunePrivateKeyPool(wallet, source) {
  if (source.type !== 'private-key') return;

  // navcoin-js falls back to a 10-address pool when minPoolSize is falsy.
  // For imported WIF containers, keep only the explicit imported keys.
  await wallet.db.db.keys
    .where('type')
    .equals(1)
    .filter((key) => key.path !== 'imported')
    .delete();
}

// Remove one database from the shim's registry and drop its stores.
//
// The registry is one file shared by every wallet in the directory, so it
// cannot be deleted to forget a single wallet: that takes every sibling's
// version with it and leaves each of them unopenable.
function forgetDatabase(databaseName) {
  return new Promise((resolve, reject) => {
    const request = global.indexedDB.deleteDatabase(databaseName);

    // Fires while another connection still holds the database. Callers
    // close the wallet first, so waiting here would just hang.
    request.onblocked = () =>
      reject(new Error(`${databaseName} is still open elsewhere`));
    request.onerror = () =>
      reject(request.error ?? new Error(`could not remove ${databaseName}`));
    request.onsuccess = () => resolve();
  });
}

async function main() {
  // Hard timeout — spawn() ignores its timeout option, so enforce internally.
  const WORKER_TIMEOUT_MS = 300_000; // 5 minutes
  const timer = setTimeout(() => {
    try {
      process.stdout.write(
        JSON.stringify({ ok: false, error: 'wallet worker timed out' }),
      );
    } catch {}
    process.exit(1);
  }, WORKER_TIMEOUT_MS);
  timer.unref();

  // Read stdin.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const { source, walletsDir, password } = input;

  try {
    global.window = global;
    const { default: setGlobalVars } = await import('indexeddbshim');
    setGlobalVars(null, {
      checkOrigin: false,
      databaseBasePath: walletsDir,
      sysDatabaseBasePath: walletsDir,
    });

    if (input.mode === 'forget') {
      await forgetDatabase(input.databaseName);
      process.stdout.write(JSON.stringify({ ok: true }));
      process.exit(0);
    }

    const navcoinJs = await import('navcoin-js');
    const wallet = navcoinJs.wallet ?? navcoinJs.default?.wallet;
    const xNavBootstrap =
      wallet.xNavBootstrap ?? navcoinJs.default?.wallet?.xNavBootstrap;
    await wallet.Init();
    console.error('[worker] initialized');

    const dbName = `${source.id}.db`;
    const sqliteFile = path.join(walletsDir, `D_${dbName}.sqlite`);

    const options = {
      file: dbName,
      password,
      spendingPassword: password,
      network: 'mainnet',
      log: false,
    };

    if (source.type === 'mnemonic') {
      options.mnemonic = source.normalizedDetails.replaceAll('\n', ' ');
      options.type = getDerivationWalletType(source.walletType);
    } else {
      options.mnemonic = PRIVATE_KEY_CONTAINER_MNEMONIC;
      options.type = 'navcoin-js-v1';
    }

    const w = new wallet.WalletFile(options);

    console.error('[worker] deriving addresses...');
    await w.Load({
      useP2p: false,
      minPoolSize: getWalletInitialPoolSize(source),
      bootstrap: xNavBootstrap,
    });
    console.error('[worker] addresses derived');
    await prunePrivateKeyPool(w, source);

    if (source.type === 'private-key') {
      for (const key of source.normalizedDetails.split('\n')) {
        await w.ImportPrivateKey(key, password);
      }
    }

    try {
      w.Disconnect();
    } catch {}
    try {
      w.CloseDb();
    } catch {}

    process.stdout.write(
      JSON.stringify({
        ok: true,
        storage: {
          backend: 'navcoin-js',
          databaseName: dbName,
          dataFile: sqliteFile,
          passwordMode: 'static',
          network: 'mainnet',
        },
      }),
    );
    process.exit(0);
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: error.message ?? String(error),
      }),
    );
    process.exit(1);
  }
}

await main();
