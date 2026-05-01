import { getLayout } from './app-data.js';
import { STATIC_WALLET_PASSWORD } from './constants.js';

// Per-source wallet state held in daemon memory.
// Not persisted - rebuilt on every daemon start.
const walletState = new Map();

function makeInitialState(sourceId) {
  return {
    sourceId,
    wallet: null,
    syncStatus: 'opening',
    syncProgress: 0,
    connected: false,
    server: null,
    addresses: [],
    balance: {
      nav: { confirmed: 0, pending: 0 },
      staked: { confirmed: 0, pending: 0 },
    },
    error: null,
  };
}

export function getSourceState(sourceId) {
  return walletState.get(sourceId) ?? null;
}

export function getAllSourceStates() {
  return [...walletState.values()].map((s) => ({
    sourceId: s.sourceId,
    syncStatus: s.syncStatus,
    syncProgress: s.syncProgress,
    connected: s.connected,
    server: s.server,
    addresses: s.addresses,
    balance: s.balance,
    error: s.error,
  }));
}

export async function openSourceWallet(source, root, navWallet) {
  const layout = getLayout(root);
  const state = makeInitialState(source.id);
  walletState.set(source.id, state);

  const wallet = new navWallet.WalletFile({
    file: `${source.id}.db`,
    password: STATIC_WALLET_PASSWORD,
    spendingPassword: STATIC_WALLET_PASSWORD,
    network: 'mainnet',
    log: false,
  });

  state.wallet = wallet;

  wallet.on('connected', (server) => {
    state.connected = true;
    state.server = server;
    state.syncStatus = 'connected';
  });

  wallet.on('disconnected', () => {
    state.connected = false;
  });

  wallet.on('sync_started', () => {
    state.syncStatus = 'syncing';
  });

  wallet.on('sync_status', (progress) => {
    state.syncProgress = progress;
    state.syncStatus = 'syncing';
  });

  wallet.on('sync_finished', async () => {
    state.syncStatus = 'synced';
    state.syncProgress = 100;
    await refreshAddressesAndBalance(source.id, wallet);
  });

  wallet.on('new_tx', async () => {
    await refreshAddressesAndBalance(source.id, wallet);
  });

  wallet.on('no_servers_available', () => {
    state.syncStatus = 'no-servers';
    state.connected = false;
  });

  wallet.on('db_load_error', (error) => {
    state.syncStatus = 'error';
    state.error = String(error);
    state.wallet = null;
  });

  try {
    await wallet.Load({ useP2p: false });

    // Seed initial address and balance snapshot before connecting.
    await refreshAddressesAndBalance(source.id, wallet);

    state.syncStatus = 'connecting';
    await wallet.Connect();
  } catch (error) {
    state.syncStatus = 'error';
    state.error = error.message;
  }

  return state;
}

async function refreshAddressesAndBalance(sourceId, wallet) {
  const state = walletState.get(sourceId);
  if (!state) return;

  try {
    const rawAddresses = await wallet.NavReceivingAddresses(true);
    state.addresses = rawAddresses.map((a) => ({
      address: a.address,
      path: a.path,
      used: a.used === 1,
    }));
  } catch {
    // Non-fatal: leave previous address list intact.
  }

  try {
    const bal = await wallet.GetBalance();
    state.balance = {
      nav: {
        confirmed: bal.nav?.confirmed ?? 0,
        pending: bal.nav?.pending ?? 0,
      },
      staked: {
        confirmed: bal.staked?.confirmed ?? 0,
        pending: bal.staked?.pending ?? 0,
      },
    };
  } catch {
    // Non-fatal: leave previous balance intact.
  }
}

export async function closeSourceWallet(sourceId) {
  const state = walletState.get(sourceId);
  if (!state?.wallet) return;

  try {
    state.wallet.Disconnect();
  } catch {
    // Ignore disconnect errors on close.
  }

  try {
    state.wallet.CloseDb();
  } catch {
    // Ignore close errors.
  }

  state.wallet = null;
  walletState.delete(sourceId);
}

export async function closeAllWallets() {
  await Promise.all([...walletState.keys()].map(closeSourceWallet));
}

/**
 * Validate that all sources are fully synced and return a sweep preview.
 *
 * Returns:
 *   { totalNav, sources: [{ sourceId, nav }] }
 *
 * Throws if any source is not synced or has an error.
 */
export function prepareSweep() {
  const states = [...walletState.values()];

  if (states.length === 0) {
    throw new Error('No imported sources. Import a wallet before sweeping.');
  }

  for (const state of states) {
    if (state.error) {
      throw new Error(
        `Source ${state.sourceId} is in error state: ${state.error}`,
      );
    }

    if (state.syncStatus !== 'synced') {
      throw new Error(
        `Source ${state.sourceId} is not fully synced (status: ${state.syncStatus}). Wait for sync to complete.`,
      );
    }
  }

  let totalNav = 0;
  const sources = [];

  for (const state of states) {
    const nav = state.balance.nav.confirmed;
    totalNav += nav;
    sources.push({ sourceId: state.sourceId, nav });
  }

  return { totalNav, sources };
}

/**
 * Execute the sweep: create and broadcast a NAV transaction from each source
 * wallet that has a non-zero confirmed balance.
 *
 * Returns:
 *   { hashes: string[], totalSent: number, totalFee: number }
 *
 * Throws if any broadcast fails.
 */
export async function executeSweep(destination) {
  const states = [...walletState.values()];
  const hashes = [];
  let totalSent = 0;
  let totalFee = 0;

  for (const state of states) {
    const nav = state.balance.nav.confirmed;

    if (nav <= 0 || !state.wallet) {
      continue;
    }

    const tx = await state.wallet.NavCreateTransaction(
      destination,
      nav,
      '',
      STATIC_WALLET_PASSWORD,
      true, // subtractFee — fee comes out of the amount
    );

    if (!tx || !tx.tx) {
      throw new Error(
        `Failed to create transaction for source ${state.sourceId}`,
      );
    }

    const result = await state.wallet.SendTransaction(tx.tx);

    if (result.error) {
      throw new Error(
        `Broadcast failed for source ${state.sourceId}: ${result.error}`,
      );
    }

    const fee = tx.fee ?? 0;
    totalFee += fee;
    totalSent += nav - fee;

    if (result.hashes) {
      hashes.push(...result.hashes);
    }
  }

  return { hashes, totalSent, totalFee };
}
