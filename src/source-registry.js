import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { getAppDataRoot, getLayout } from './app-data.js';
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

  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) {
    throw new Error('Source label is required.');
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
      label,
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
    label,
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

export async function importSource(input, root = getAppDataRoot()) {
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

  const source = {
    id: sourceId,
    label: validated.label,
    type: validated.type,
    walletType: validated.walletType,
    fingerprint,
    status: 'imported',
    syncStatus: 'not-synced',
    createdAt: new Date().toISOString(),
  };

  state.sources.push(source);
  await writeSources(state, root);
  return source;
}

export async function removeSource(sourceId, root = getAppDataRoot()) {
  const state = await readSources(root);
  const nextSources = state.sources.filter((source) => source.id !== sourceId);

  if (nextSources.length === state.sources.length) {
    throw new Error(`Unknown source id: ${sourceId}`);
  }

  await writeSources({ sources: nextSources }, root);
  return { removedSourceId: sourceId };
}
