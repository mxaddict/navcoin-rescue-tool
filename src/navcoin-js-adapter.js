import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getAppDataRoot, getLayout } from './app-data.js';
import { STATIC_WALLET_PASSWORD, RECOVERY_MIN_POOL_SIZE } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let navcoinJsPromise;
let navcoinInitPromise;

function getWalletDatabaseName(sourceId) {
  return `${sourceId}.db`;
}

function getWalletDataFilePath(root, sourceId) {
  const layout = getLayout(root);
  return path.join(
    layout.walletsDir,
    `D_${getWalletDatabaseName(sourceId)}.sqlite`,
  );
}

async function loadNavcoinJs() {
  if (!navcoinJsPromise) {
    navcoinJsPromise = (async () => {
      global.window = global;
      const { default: setGlobalVars } = await import('indexeddbshim');
      const navcoinJs = await import('navcoin-js');
      return { navcoinJs, setGlobalVars };
    })();
  }

  return navcoinJsPromise;
}

async function initNavcoinJs(walletsDir) {
  const { navcoinJs, setGlobalVars } = await loadNavcoinJs();
  setGlobalVars(null, {
    checkOrigin: false,
    databaseBasePath: walletsDir,
    sysDatabaseBasePath: walletsDir,
  });

  const wallet = navcoinJs.wallet ?? navcoinJs.default?.wallet;

  if (!navcoinInitPromise) {
    navcoinInitPromise = wallet.Init();
  }

  await navcoinInitPromise;
  return wallet;
}

export async function getNavWallet(root = getAppDataRoot()) {
  const layout = getLayout(root);
  return initNavcoinJs(layout.walletsDir);
}

export function getWalletStorageDetails(sourceId, root = getAppDataRoot()) {
  return {
    backend: 'navcoin-js',
    databaseName: getWalletDatabaseName(sourceId),
    dataFile: getWalletDataFilePath(root, sourceId),
    passwordMode: 'static',
    network: 'mainnet',
  };
}

export async function createImportedWallet(
  source,
  root = getAppDataRoot(),
  onProgress = null,
) {
  const storage = getWalletStorageDetails(source.id, root);
  const dataFileExists = await fs
    .access(storage.dataFile)
    .then(() => true)
    .catch(() => false);

  if (dataFileExists) {
    return { ok: true, storage };
  }

  const layout = getLayout(root);
  await fs.mkdir(layout.walletsDir, { recursive: true });

  // Run wallet creation in a child process so the daemon event loop stays
  // responsive during the (potentially long) address pool derivation.
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'wallet-worker.js')],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      stderr += msg + '\n';
      if (msg.startsWith('[worker]') && onProgress) {
        onProgress(msg.replace('[worker] ', ''));
      }
    });

    child.on('close', (code, signal) => {
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch {
        const reason = signal ? `killed by ${signal}` : `exit code ${code}`;
        const detail = stderr.trim();
        reject(
          new Error(
            `Wallet worker ${reason}${detail ? `: ${detail}` : ' and no parseable output'}`,
          ),
        );
      }
    });

    child.on('error', reject);

    child.stdin.write(
      JSON.stringify({
        source,
        walletsDir: layout.walletsDir,
        password: STATIC_WALLET_PASSWORD,
        minPoolSize: RECOVERY_MIN_POOL_SIZE,
      }),
    );
    child.stdin.end();
  });

  if (!result.ok) {
    await deleteWalletForSource(source.id, root).catch(() => {});

    const raw = result.error ?? 'unknown error';
    let message;

    if (
      raw.includes("reading 'length'") ||
      raw.includes('Cannot read properties of undefined')
    ) {
      message =
        source.type === 'mnemonic'
          ? `Wallet type "${source.walletType}" could not derive keys from this mnemonic. ` +
            `Try a different wallet type. For a standard navcoin-js mnemonic use navcoin-js-v1.`
          : `navcoin-js could not import the private key — check the WIF format.`;
    } else {
      message = `navcoin-js import failed: ${raw}`;
    }

    throw new Error(message);
  }

  return result.storage;
}

export async function deleteWalletForSource(sourceId, root = getAppDataRoot()) {
  const storage = getWalletStorageDetails(sourceId, root);
  const layout = getLayout(root);

  // Remove the wallet sqlite file.
  await fs.rm(storage.dataFile, { force: true });

  // Remove the indexeddb system registry — it tracks known DBs and causes
  // "DB did not load" if it still references a deleted wallet file.
  // Also reset the module-level promises so the next initNavcoinJs call
  // re-runs setGlobalVars and rebuilds the shim state from the fresh files.
  await fs.rm(path.join(layout.walletsDir, '__sysdb__.sqlite'), {
    force: true,
  });

  resetNavcoinJs();

  return storage;
}

/**
 * Reset the navcoin-js and indexeddb shim state so the next wallet operation
 * reinitialises from scratch. Call after deleting wallet files.
 */
export function resetNavcoinJs() {
  navcoinInitPromise = null;
  navcoinJsPromise = null; // force re-import and re-init of shim on next use
}
