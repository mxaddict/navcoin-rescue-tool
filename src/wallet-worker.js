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
import { forgetDatabase, shimConfig } from './wallet-database.js';

// Send the one reply the parent reads, then exit once it has been
// written. On Windows a write to a pipe is asynchronous, so exiting
// straight after it can drop the reply: the parent then sees a bare exit
// code and none of the reason, which is how wallet-creation failures
// arrived with no explanation. A stdout that is already gone has nowhere
// to report to, so that exits at once.
let replied = false;
function replyAndExit(reply, code) {
  if (replied) return;
  replied = true;
  try {
    process.stdout.write(JSON.stringify(reply), () => process.exit(code));
  } catch {
    process.exit(code);
  }
}

process.on('uncaughtException', (error) => {
  replyAndExit({ ok: false, error: `uncaught: ${error.message}` }, 1);
});

process.on('unhandledRejection', (error) => {
  replyAndExit(
    { ok: false, error: `unhandled: ${error?.message ?? String(error)}` },
    1,
  );
});

['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => {
    replyAndExit({ ok: false, error: `killed by ${sig}` }, 1);
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

async function main() {
  // Hard timeout — spawn() ignores its timeout option, so enforce internally.
  const WORKER_TIMEOUT_MS = 300_000; // 5 minutes
  const timer = setTimeout(() => {
    replyAndExit({ ok: false, error: 'wallet worker timed out' }, 1);
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
    setGlobalVars(null, shimConfig(walletsDir));

    if (input.mode === 'forget') {
      await forgetDatabase(global.indexedDB, input.databaseName);
      replyAndExit({ ok: true }, 0);
      return;
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

    replyAndExit(
      {
        ok: true,
        storage: {
          backend: 'navcoin-js',
          databaseName: dbName,
          dataFile: sqliteFile,
          passwordMode: 'static',
          network: 'mainnet',
        },
      },
      0,
    );
  } catch (error) {
    replyAndExit({ ok: false, error: error.message ?? String(error) }, 1);
  }
}

await main();
