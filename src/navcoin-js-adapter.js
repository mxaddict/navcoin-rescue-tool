import fs from 'node:fs/promises';
import path from 'node:path';

import { getAppDataRoot, getLayout } from './app-data.js';
import { STATIC_WALLET_PASSWORD } from './constants.js';

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

// A fixed anchor mnemonic used only as the HD wallet container for private-key
// imports. The actual imported keys are added on top; this mnemonic itself
// never derives usable recovery material for the user.
const PRIVATE_KEY_CONTAINER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function buildWalletOptions(sourceId, source) {
  const options = {
    file: getWalletDatabaseName(sourceId),
    password: STATIC_WALLET_PASSWORD,
    spendingPassword: STATIC_WALLET_PASSWORD,
    network: 'mainnet',
    log: false,
  };

  if (source.type === 'mnemonic') {
    options.mnemonic = source.normalizedDetails.replaceAll('\n', ' ');
    options.type = source.walletType;
  } else {
    // Private-key wallets need a valid mnemonic to initialise the DB schema.
    options.mnemonic = PRIVATE_KEY_CONTAINER_MNEMONIC;
    options.type = 'navcoin-js-v1';
  }

  return options;
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

export async function createImportedWallet(source, root = getAppDataRoot()) {
  const layout = getLayout(root);
  await fs.mkdir(layout.walletsDir, { recursive: true });

  const navWallet = await initNavcoinJs(layout.walletsDir);
  const wallet = new navWallet.WalletFile(
    buildWalletOptions(source.id, source),
  );

  try {
    await wallet.Load({ useP2p: false });

    if (source.type === 'private-key') {
      for (const key of source.normalizedDetails.split('\n')) {
        await wallet.ImportPrivateKey(key, STATIC_WALLET_PASSWORD);
      }
    }

    return getWalletStorageDetails(source.id, root);
  } catch (error) {
    await deleteWalletForSource(source.id, root);
    throw new Error(`navcoin-js import failed: ${error.message}`);
  } finally {
    if (typeof wallet.Disconnect === 'function') {
      wallet.Disconnect();
    }

    if (typeof wallet.CloseDb === 'function') {
      wallet.CloseDb();
    }
  }
}

export async function deleteWalletForSource(sourceId, root = getAppDataRoot()) {
  const storage = getWalletStorageDetails(sourceId, root);
  await fs.rm(storage.dataFile, { force: true });
  return storage;
}
