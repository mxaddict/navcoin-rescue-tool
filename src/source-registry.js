import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { getAppDataRoot, getLayout, writeJsonFileAtomic } from './app-data.js';
import {
  createImportedWallet,
  deleteWalletForSource,
  resetNavcoinJs,
} from './navcoin-js-adapter.js';
import { SUPPORTED_SOURCE_TYPES } from './constants.js';
import {
  explainNoEligibleWalletType,
  getEligibleWalletTypes,
} from './mnemonic.js';

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
    const normalizedMnemonic = normalizeMnemonic(input.phrase || '');
    if (!normalizedMnemonic) {
      throw new Error('Mnemonic phrase is required.');
    }

    const wordCount = normalizedMnemonic.split('\n').length;
    if (wordCount < 12) {
      throw new Error('Mnemonic phrase must contain at least 12 words.');
    }

    // The caller does not choose a wallet type: nobody reliably remembers
    // which app produced a phrase years ago, and picking wrong reports an
    // empty wallet, which looks exactly like having no coins. Derive every
    // scheme the phrase is valid for instead and let the balances answer.
    //
    // Every client — CLI, TUI and GUI — imports through the daemon, which
    // imports through here, so this is the one place the check has to be
    // for all three to behave the same way.
    const phrase = normalizedMnemonic.replaceAll('\n', ' ');
    const walletTypes = getEligibleWalletTypes(phrase, {
      allowUnchecked: input.allowUncheckedMnemonic === true,
    });

    if (walletTypes.length === 0) {
      throw explainNoEligibleWalletType(phrase);
    }

    return {
      type: 'mnemonic',
      walletTypes,
      normalizedDetails: normalizedMnemonic,
    };
  }

  const normalizedKeys = normalizePrivateKeys(input.keys || []);
  if (normalizedKeys.length === 0) {
    throw new Error('At least one private key is required.');
  }

  return {
    type: 'private-key',
    walletTypes: [null],
    normalizedDetails: normalizedKeys.join('\n'),
  };
}

export async function readSources(root = getAppDataRoot()) {
  const layout = getLayout(root);
  return JSON.parse(await fs.readFile(layout.sourcesFile, 'utf8'));
}

export async function writeSources(sourcesState, root = getAppDataRoot()) {
  const layout = getLayout(root);
  await writeJsonFileAtomic(layout.sourcesFile, sourcesState);
  return sourcesState;
}

// One phrase becomes one source per derivation scheme it is valid for,
// all sharing an import id. Downstream — status, sweep, remove — each is
// an ordinary source and needs to know nothing about the grouping.
export async function importSources(
  input,
  root = getAppDataRoot(),
  walletAdapter = {
    createImportedWallet,
    deleteWalletForSource,
  },
) {
  const validated = validateImportInput(input);

  // Identifies the secret, independent of what is derived from it, so a
  // phrase already imported is recognised however many sources it made.
  const importId = buildFingerprint([
    validated.type,
    validated.normalizedDetails,
  ]).slice(0, 16);

  const state = await readSources(root);

  if (state.sources.some((source) => source.importId === importId)) {
    throw new Error(`Duplicate source: ${importId}`);
  }

  // Fingerprint the derivation scheme rather than the label, so a phrase
  // imported under an alias and again under the type it aliases is one
  // source — two would derive the same keys and double-count every UTXO.
  const prepared = validated.walletTypes.map((walletType) => {
    const fingerprint = buildFingerprint([
      validated.type,
      walletType ?? 'private-key',
      validated.normalizedDetails,
    ]);

    return {
      id: fingerprint.slice(0, 16),
      importId,
      type: validated.type,
      walletType,
      fingerprint,
      normalizedDetails: validated.normalizedDetails,
    };
  });

  // A phrase already imported under one type before the group import
  // existed leaves that fingerprint in place; skipping it keeps the rest
  // of the group importable rather than failing the whole thing.
  const existing = new Set(state.sources.map((source) => source.fingerprint));
  const fresh = prepared.filter((source) => !existing.has(source.fingerprint));

  if (fresh.length === 0) {
    throw new Error(`Duplicate source: ${importId}`);
  }

  const created = [];
  // Tracked separately from `created` so the wallet being built when the
  // failure happens is cleaned up too — it may have left a partial one.
  const started = [];

  try {
    for (const preparedSource of fresh) {
      started.push(preparedSource.id);

      const source = {
        ...preparedSource,
        status: 'ready',
        syncStatus: 'wallet-created',
        createdAt: new Date().toISOString(),
        error: null,
      };

      source.wallet = await walletAdapter.createImportedWallet(
        preparedSource,
        root,
      );
      created.push(source);
    }
  } catch (error) {
    // The group is all-or-nothing: a half-imported phrase would report a
    // balance from some derivations and silently omit others.
    for (const sourceId of started) {
      await walletAdapter.deleteWalletForSource(sourceId, root);
    }
    throw error;
  }

  state.sources.push(...created);
  await writeSources(state, root);
  return { importId, sources: created };
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

export async function markSourceSynced(sourceId, root = getAppDataRoot()) {
  const state = await readSources(root);
  const source = state.sources.find((entry) => entry.id === sourceId);
  if (!source) return;
  source.lastSyncedAt = new Date().toISOString();
  await writeSources(state, root);
}

export async function purgeAllSources(
  root = getAppDataRoot(),
  walletAdapter = {
    createImportedWallet,
    deleteWalletForSource,
  },
) {
  const state = await readSources(root);
  const layout = getLayout(root);

  // Wipe the entire wallets directory so no stale indexeddbshim SQLite files
  // (including ___tx___ caches) are left behind to cause ConstraintErrors on
  // the next import of the same key or mnemonic.
  await fs.rm(layout.walletsDir, { recursive: true, force: true });
  await fs.mkdir(layout.walletsDir, { recursive: true });

  resetNavcoinJs();

  await writeSources({ sources: [] }, root);
  return { purgedCount: state.sources.length };
}
