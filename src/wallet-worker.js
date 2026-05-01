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

    if (source.type === 'mnemonic') {
      options.mnemonic = source.normalizedDetails.replaceAll('\n', ' ');
      options.type = source.walletType;
    } else {
      options.mnemonic = PRIVATE_KEY_CONTAINER_MNEMONIC;
      options.type = 'navcoin-js-v1';
    }

    const w = new wallet.WalletFile(options);

    await w.Load({ useP2p: false, minPoolSize });

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
