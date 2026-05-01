import { getLayout } from './app-data.js';
import { STATIC_WALLET_PASSWORD, RECOVERY_MIN_POOL_SIZE } from './constants.js';

// Per-source wallet state held in daemon memory.
// Not persisted - rebuilt on every daemon start.
const walletState = new Map();

// How long to wait in 'connecting' before attempting a reconnect (ms).
const RECONNECT_TIMEOUT_MS = 30_000;
// How long to wait between reconnect attempts (ms).
const RECONNECT_INTERVAL_MS = 10_000;

function makeInitialState(sourceId) {
  return {
    sourceId,
    wallet: null,
    syncStatus: 'opening',
    syncProgress: 0,
    connected: false,
    server: null,
    connectingAt: null,
    addresses: [],
    balance: {
      nav: { confirmed: 0, pending: 0 },
      staked: { confirmed: 0, pending: 0 },
    },
    error: null,
    reconnectTimer: null,
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
    connectingAt: s.connectingAt,
    addresses: s.addresses,
    balance: s.balance,
    error: s.error,
  }));
}

function scheduleReconnect(source, state, navWallet) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(async () => {
    // Don't reconnect if already connected, syncing, synced, or closed.
    if (
      state.connected ||
      state.syncStatus === 'synced' ||
      state.syncStatus === 'syncing' ||
      state.syncStatus === 'error' ||
      !state.wallet
    ) {
      return;
    }

    state.syncStatus = 'connecting';
    state.connectingAt = Date.now();

    try {
      await state.wallet.Connect();
    } catch {
      // Connect() errors are non-fatal — watchdog will retry.
    }
  }, RECONNECT_INTERVAL_MS);
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
    minPoolSize: RECOVERY_MIN_POOL_SIZE,
  });

  state.wallet = wallet;

  wallet.on('connected', (server) => {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    state.connected = true;
    state.server = server;
    state.syncStatus = 'connected';
    state.connectingAt = null;
  });

  wallet.on('disconnected', () => {
    state.connected = false;
    // Only reschedule reconnect if we were previously connected or syncing —
    // not if we're already in an error or no-servers state.
    if (
      state.syncStatus !== 'error' &&
      state.syncStatus !== 'no-servers' &&
      state.wallet
    ) {
      state.syncStatus = 'connecting';
      state.connectingAt = Date.now();
      scheduleReconnect(source, state, navWallet);
    }
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
    // Retry after interval — servers may come back up.
    scheduleReconnect(source, state, navWallet);
  });

  wallet.on('db_load_error', (error) => {
    clearTimeout(state.reconnectTimer);
    state.syncStatus = 'error';
    state.error = String(error);
    state.wallet = null;
  });

  // Watchdog: if stuck in 'connecting' for too long, try reconnecting.
  const watchdog = setInterval(() => {
    if (!walletState.has(source.id)) {
      clearInterval(watchdog);
      return;
    }

    if (
      state.syncStatus === 'connecting' &&
      state.connectingAt !== null &&
      Date.now() - state.connectingAt > RECONNECT_TIMEOUT_MS &&
      !state.reconnectTimer &&
      state.wallet
    ) {
      scheduleReconnect(source, state, navWallet);
    }
  }, 5_000);

  try {
    await wallet.Load({ useP2p: false });

    // Seed initial address and balance snapshot before connecting.
    await refreshAddressesAndBalance(source.id, wallet);

    state.syncStatus = 'connecting';
    state.connectingAt = Date.now();
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
  if (!state) return;

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;

  if (!state.wallet) {
    walletState.delete(sourceId);
    return;
  }

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
