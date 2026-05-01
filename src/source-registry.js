import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { getAppDataRoot, getLayout } from './app-data.js';
import {
  createImportedWallet,
  deleteWalletForSource,
} from './navcoin-js-adapter.js';
import {
  SUPPORTED_MNEMONIC_WALLET_TYPES,
  SUPPORTED_SOURCE_TYPES,
} from './constants.js';

function normalizeMnemonic(phrase) {
  return phrase.trim().split(/\s+/).filter(Boolean).join('\n');
}

function normalizePrivateKeys(keys) {
  return keys
    .flatMap((key) => key.split(/[\s,]+/))
    .map((key) => key.trim())
    .filter(Boolean)
    .sort();
}

function buildFingerprint(parts) {
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function validateImportInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Import payload is required.');
  }

  if (!SUPPORTED_SOURCE_TYPES.includes(input.type)) {
    throw new Error(`Unsupported source type: ${input.type}`);
  }

  if (input.type === 'mnemonic') {
    if (!SUPPORTED_MNEMONIC_WALLET_TYPES.includes(input.walletType)) {
      throw new Error(`Unsupported wallet type: ${input.walletType}`);
    }

    const normalizedMnemonic = normalizeMnemonic(input.phrase || '');
    if (!normalizedMnemonic) {
      throw new Error('Mnemonic phrase is required.');
    }

    const wordCount = normalizedMnemonic.split('\n').length;
    if (wordCount < 12) {
      throw new Error('Mnemonic phrase must contain at least 12 words.');
    }

    return {
      type: 'mnemonic',
      walletType: input.walletType,
      normalizedDetails: normalizedMnemonic,
    };
  }

  const normalizedKeys = normalizePrivateKeys(input.keys || []);
  if (normalizedKeys.length === 0) {
    throw new Error('At least one private key is required.');
  }

  return {
    type: 'private-key',
    walletType: null,
    normalizedDetails: normalizedKeys.join('\n'),
  };
}

export async function readSources(root = getAppDataRoot()) {
  const layout = getLayout(root);
  return JSON.parse(await fs.readFile(layout.sourcesFile, 'utf8'));
}

export async function writeSources(sourcesState, root = getAppDataRoot()) {
  const layout = getLayout(root);
  await fs.writeFile(
    layout.sourcesFile,
    `${JSON.stringify(sourcesState, null, 2)}\n`,
  );
  return sourcesState;
}

export async function importSource(
  input,
  root = getAppDataRoot(),
  walletAdapter = {
    createImportedWallet,
    deleteWalletForSource,
  },
) {
  const validated = validateImportInput(input);
  const fingerprint = buildFingerprint([
    validated.type,
    validated.walletType || 'private-key',
    validated.normalizedDetails,
  ]);
  const sourceId = fingerprint.slice(0, 16);
  const state = await readSources(root);

  if (state.sources.some((source) => source.fingerprint === fingerprint)) {
    throw new Error(`Duplicate source: ${sourceId}`);
  }

  const preparedSource = {
    id: sourceId,
    type: validated.type,
    walletType: validated.walletType,
    fingerprint,
    normalizedDetails: validated.normalizedDetails,
  };

  const source = {
    id: sourceId,
    type: validated.type,
    walletType: validated.walletType,
    fingerprint,
    status: 'ready',
    syncStatus: 'wallet-created',
    createdAt: new Date().toISOString(),
    error: null,
  };

  try {
    source.wallet = await walletAdapter.createImportedWallet(
      preparedSource,
      root,
    );
    state.sources.push(source);
    await writeSources(state, root);
    return source;
  } catch (error) {
    await walletAdapter.deleteWalletForSource(sourceId, root);
    throw error;
  }
}

export async function removeSource(
  sourceId,
  root = getAppDataRoot(),
  walletAdapter = {
    createImportedWallet,
    deleteWalletForSource,
  },
) {
  const state = await readSources(root);
  const source = state.sources.find((entry) => entry.id === sourceId);
  const nextSources = state.sources.filter((source) => source.id !== sourceId);

  if (nextSources.length === state.sources.length) {
    throw new Error(`Unknown source id: ${sourceId}`);
  }

  await walletAdapter.deleteWalletForSource(source.id, root);
  await writeSources({ sources: nextSources }, root);
  return { removedSourceId: sourceId };
}
