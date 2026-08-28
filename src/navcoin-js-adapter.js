import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

import { getAppDataRoot, getLayout } from './app-data.js';
import { STATIC_WALLET_PASSWORD } from './constants.js';

const require = createRequire(import.meta.url);

// Default W3CWebSocket frame/message size limits are 64KB / 1MB. Mainnet
// electrum responses (consensus + dao subscribe state, OP_TRUE anchor
// history, heavily-used scripthash history) routinely exceed 1MB and
// trigger 'Frame size exceeds maximum' (close code 1009). Bump the
// limits to 64MB before navcoin-js loads electrum-client-js, so the
// `const W3CWebSocket = require('websocket').w3cwebsocket` capture in
// socket_client_ws.js picks up the patched constructor.
function patchWebSocketFrameLimits() {
  if (patchWebSocketFrameLimits.applied) return;
  patchWebSocketFrameLimits.applied = true;

  const websocketMod = require('websocket');
  const OriginalW3C = websocketMod.w3cwebsocket;
  if (!OriginalW3C) return;

  const LARGE = 64 * 1024 * 1024;
  websocketMod.w3cwebsocket = function PatchedW3CWebSocket(
    url,
    protocols,
    origin,
    headers,
    requestOptions,
    clientConfig,
  ) {
    return new OriginalW3C(url, protocols, origin, headers, requestOptions, {
      maxReceivedFrameSize: LARGE,
      maxReceivedMessageSize: LARGE,
      ...(clientConfig || {}),
    });
  };
}

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
      patchWebSocketFrameLimits();
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

// Run the wallet worker in a child process and return its reply.
//
// A child every time, for two reasons: wallet.Load can take a minute and
// must not block the daemon's event loop, and the indexeddb shim binds to
// one wallets directory per process with no way to repoint it.
function runWalletWorker(payload, onProgress = null) {
  return new Promise((resolve, reject) => {
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
        resolve(JSON.parse(stdout));
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

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
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
  const result = await runWalletWorker(
    {
      source,
      walletsDir: layout.walletsDir,
      password: STATIC_WALLET_PASSWORD,
    },
    onProgress,
  );

  if (!result.ok) {
    await deleteWalletForSource(source.id, root).catch(() => {});

    const raw = result.error ?? 'unknown error';
    let message;

    if (
      raw.includes("reading 'length'") ||
      raw.includes('Cannot read properties of undefined')
    ) {
      // No "try a different wallet type" here: the user does not pick
      // one any more. Every type the phrase fits is derived, so this is
      // one derivation of several failing and the others may be fine.
      message =
        source.type === 'mnemonic'
          ? `Could not derive a "${source.walletType}" wallet from this mnemonic.`
          : `navcoin-js could not import the private key — check the WIF format.`;
    } else {
      message = `navcoin-js import failed: ${raw}`;
    }

    throw new Error(message);
  }

  return result.storage;
}

// Drop one wallet from the indexeddb registry.
//
// The registry (`__sysdb__.sqlite`) holds a version per database and is
// shared by every wallet in the directory, so it cannot be deleted to
// forget one of them: `deleteDatabase` removes just this database's row
// and object stores. Leaving the row behind is what the wholesale delete
// was working around — a later import reuses the same source id, finds
// the shim already holding a version for it, skips the upgrade that
// creates the object stores, and fails to load.
async function forgetWalletDatabase(walletsDir, databaseName) {
  const result = await runWalletWorker({
    mode: 'forget',
    databaseName,
    walletsDir,
  });

  if (!result.ok) {
    throw new Error(
      `Could not remove ${databaseName}: ${result.error ?? 'unknown error'}`,
    );
  }
}

export async function deleteWalletForSource(sourceId, root = getAppDataRoot()) {
  const storage = getWalletStorageDetails(sourceId, root);
  const layout = getLayout(root);

  // Before the file, so the registry is never left holding a version for
  // a database whose file has gone.
  await forgetWalletDatabase(layout.walletsDir, storage.databaseName);

  // Remove the wallet sqlite file.
  await fs.rm(storage.dataFile, { force: true });

  // Reset the module-level promises so the next initNavcoinJs call
  // re-runs setGlobalVars and rebuilds the shim state from the fresh files.
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
