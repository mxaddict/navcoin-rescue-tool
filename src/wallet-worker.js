#!/usr/bin/env node

/**
 * Wallet creation worker — runs in a child process so wallet.Load() cannot
 * block the daemon's HTTP server or the main process event loop.
 *
 * Input:  JSON on stdin  { source, walletsDir, password, minPoolSize }
 * Output: JSON on stdout { ok: true, storage } | { ok: false, error }
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const PRIVATE_KEY_CONTAINER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function getWalletMinPoolSize(source, minPoolSize) {
  return source.type === 'private-key' ? 0 : minPoolSize;
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
  // Read stdin.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const { source, walletsDir, password, minPoolSize } = input;

  try {
    global.window = global;
    const { default: setGlobalVars } = await import('indexeddbshim');
    setGlobalVars(null, {
      checkOrigin: false,
      databaseBasePath: walletsDir,
      sysDatabaseBasePath: walletsDir,
    });

    const navcoinJs = await import('navcoin-js');
    const wallet = navcoinJs.wallet ?? navcoinJs.default?.wallet;
    await wallet.Init();

    const dbName = `${source.id}.db`;
    const sqliteFile = path.join(walletsDir, `D_${dbName}.sqlite`);

    const options = {
      file: dbName,
      password,
      spendingPassword: password,
      network: 'mainnet',
      log: false,
    };

    console.error(
      '[wallet-worker] source type:',
      source.type,
      'walletType:',
      source.walletType,
      'mnemonic length:',
      source.normalizedDetails?.length,
    );
    if (source.type === 'mnemonic') {
      options.mnemonic = source.normalizedDetails.replaceAll('\n', ' ');
      options.type = source.walletType;
      console.error(
        '[wallet-worker] creating wallet with type:',
        options.type,
        'mnemonic words:',
        options.mnemonic.split(' ').length,
      );
    } else {
      options.mnemonic = PRIVATE_KEY_CONTAINER_MNEMONIC;
      options.type = 'navcoin-js-v1';
    }

    const w = new wallet.WalletFile(options);

    await w.Load({
      useP2p: false,
      minPoolSize: getWalletMinPoolSize(source, minPoolSize),
    });
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
