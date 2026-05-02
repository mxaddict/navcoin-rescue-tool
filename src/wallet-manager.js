import { getLayout } from './app-data.js';
import { STATIC_WALLET_PASSWORD } from './constants.js';
import { rescueScan } from './rescue-scan.js';
import { markSourceSynced } from './source-registry.js';

// Output type bitmask values from navcoin-js (utils/output_types.js).
// Inlined to avoid coupling to internal module paths.
const OUT_NAV = 0x1;
const OUT_STAKED = 0x2;
const OUT_XNAV = 0x4;

// Replacement for navcoin-js wallet.GetBalance with a recovery-friendly
// pending rule: anything with at least one confirmation is spendable. The
// upstream rule flags coinstake/coinbase outputs (tx.pos < 2) as pending
// for 120 blocks, which leaves matured stake rewards stuck in pending if
// the wallet's tip lags. For a one-shot rescue + sweep flow we'd rather
// surface the balance as confirmed and let the broadcast fail clearly if
// the chain still considers it immature.
async function computeBalance(wallet) {
  // Real wallets expose wallet.db.GetUtxos / wallet.db.GetTx; tests use a
  // simpler mock without a db. Fall back to the wallet's own GetBalance in
  // that case so the test fixtures don't need to model UTXOs.
  let utxos;
  try {
    utxos = await wallet.db.GetUtxos(true);
  } catch {
    return await wallet.GetBalance();
  }
  if (!Array.isArray(utxos)) return await wallet.GetBalance();

  let navConfirmed = 0;
  let navPending = 0;
  let xnavConfirmed = 0;
  let xnavPending = 0;
  let stakedConfirmed = 0;
  let stakedPending = 0;

  for (const utxo of utxos) {
    if (utxo.spentIn) continue;
    const prevHash = utxo.id.split(':')[0];
    const tx = await wallet.db.GetTx(prevHash);
    if (!tx) continue;

    const pending = tx.height === undefined || tx.height <= 0;

    if (utxo.type & OUT_XNAV && utxo.amount > 0) {
      if (pending) xnavPending += utxo.amount;
      else xnavConfirmed += utxo.amount;
    } else if (utxo.type & OUT_STAKED) {
      if (pending) stakedPending += utxo.amount;
      else stakedConfirmed += utxo.amount;
    } else if (utxo.type & OUT_NAV) {
      if (pending) navPending += utxo.amount;
      else navConfirmed += utxo.amount;
    }
  }

  return {
    nav: { confirmed: navConfirmed, pending: navPending },
    xnav: { confirmed: xnavConfirmed, pending: xnavPending },
    staked: { confirmed: stakedConfirmed, pending: stakedPending },
  };
}

// Per-source wallet state held in daemon memory.
// Not persisted - rebuilt on every daemon start.
const walletState = new Map();
const openingWallets = new Map();

const MAINNET_ELECTRUM_NODES = [
  { host: 'electrum4.nav.community', port: 40004, proto: 'wss' },
  { host: 'electrum.nextwallet.org', port: 40004, proto: 'wss' },
  { host: 'electrum2.nav.community', port: 40004, proto: 'wss' },
  { host: 'electrum3.nav.community', port: 40004, proto: 'wss' },
  { host: 'electrum.nav.community', port: 40004, proto: 'wss' },
];

// How long to wait in 'connecting' before attempting a reconnect (ms).
const RECONNECT_TIMEOUT_MS = 30_000;
// How long to wait between reconnect attempts (ms).
const RECONNECT_INTERVAL_MS = 10_000;
const ELECTRUM_PROBE_TIMEOUT_MS = 5_000;

let electrumNodeCache = null;
let electrumNodeCacheAt = 0;
let electrumNodeProbePromise = null;

export function resetElectrumNodeSelectionCache() {
  electrumNodeCache = null;
  electrumNodeCacheAt = 0;
  electrumNodeProbePromise = null;
}

function makeInitialState(sourceId) {
  return {
    sourceId,
    wallet: null,
    syncStatus: 'opening',
    syncPhase: null,
    syncProgress: 0,
    syncCurrent: 0,
    syncTotal: 0,
    connected: false,
    server: null,
    connectingAt: null,
    addresses: [],
    balance: {
      nav: { confirmed: 0, pending: 0 },
      xnav: { confirmed: 0, pending: 0 },
      staked: { confirmed: 0, pending: 0 },
    },
    error: null,
    reconnectTimer: null,
    watchdog: null,
    rescanInFlight: false,
    sourceType: null,
    closing: false,
    connectPromise: null,
  };
}

export function getSourceState(sourceId) {
  return walletState.get(sourceId) ?? null;
}

export function getAllSourceStates() {
  return [...walletState.values()].map((s) => ({
    sourceId: s.sourceId,
    syncStatus: s.syncStatus,
    syncPhase: s.syncPhase,
    syncProgress: s.syncProgress,
    syncCurrent: s.syncCurrent,
    syncTotal: s.syncTotal,
    connected: s.connected,
    server: s.server,
    connectingAt: s.connectingAt,
    addresses: s.addresses,
    balance: s.balance,
    error: s.error,
  }));
}

function getSourceMinPoolSize(source) {
  // Match wallet-worker: start small; rescueScan derives the rest.
  return source.type === 'private-key' ? 0 : 10;
}

// Sync states that mean a scan is already in progress (or about to be).
// rescanAllSources skips any source whose state isn't a clean stable
// terminal — initial-open scans flow through 'opening' / 'connected' /
// 'syncing' before settling on 'synced', so we exclude all of those.
const SCAN_BUSY_STATES = new Set([
  'opening',
  'connecting',
  'connected',
  'syncing',
]);

export async function rescanAllSources() {
  const states = [...walletState.values()];
  if (states.length === 0) {
    throw new Error('No imported sources to rescan.');
  }

  const started = [];
  for (const state of states) {
    if (state.closing || !state.wallet) continue;
    if (state.rescanInFlight) continue;
    if (SCAN_BUSY_STATES.has(state.syncStatus)) continue;

    state.rescanInFlight = true;
    started.push(state.sourceId);
    runFreshRescan(state).catch(() => {
      // Errors are surfaced into state.syncStatus/error inside runFreshRescan.
    });
  }

  return { started };
}

async function runFreshRescan(state) {
  try {
    // Wipe UTXO/tx/scripthash state so the scan rebuilds from a clean
    // slate — addresses no longer in chain's listunspent set don't carry
    // over and inflate the balance. Keys, master keys, and the txKeys
    // bootstrap cache survive (ZapWalletTxes only touches statuses,
    // scriptHistories, outPoints, walletTxs, names).
    //
    // Failure here MUST abort the rescan: ZapWalletTxes silently swallows
    // per-table errors internally, and continuing against half-stale data
    // grows the balance over successive rescans because new stake-reward
    // outpoints accumulate on top of old ones that were never cleared.
    await state.wallet.db.ZapWalletTxes();

    // Reset displayed balance immediately so the user sees the rescan
    // start from zero rather than showing stale numbers until the first
    // balance_changed emit.
    state.balance = {
      nav: { confirmed: 0, pending: 0 },
      xnav: { confirmed: 0, pending: 0 },
      staked: { confirmed: 0, pending: 0 },
    };

    await rescueScan(state.wallet, {
      skipDerive: state.sourceType === 'private-key',
    });
  } catch (err) {
    if (state.closing) return;
    state.syncStatus = 'error';
    state.error = err.message;
  } finally {
    state.rescanInFlight = false;
  }
}

async function waitForConnected(state, timeoutMs = 15_000) {
  const start = Date.now();
  while (!state.connected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for electrum connection to be ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function setSyncProgress(state, phaseProgress) {
  state.syncStatus = 'syncing';
  state.syncProgress = Math.max(5, phaseProgress);
}

async function prunePrivateKeyPool(wallet, source) {
  if (source.type !== 'private-key') return;

  // Imported private-key sources should expose only explicitly imported keys,
  // not the dummy navcoin-js container pool addresses.
  await wallet.db.db.keys
    .where('type')
    .equals(1)
    .filter((key) => key.path !== 'imported')
    .delete();
}

function probeElectrumNode(node) {
  return new Promise((resolve) => {
    const url = `${node.proto}://${node.host}:${node.port}`;
    const ws = new WebSocket(url);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // Ignore close errors during probe.
      }
      resolve(ok);
    };

    const timeout = setTimeout(() => finish(false), ELECTRUM_PROBE_TIMEOUT_MS);

    ws.addEventListener('open', () => finish(true), { once: true });
    ws.addEventListener('error', () => finish(false), { once: true });
    ws.addEventListener('close', () => finish(false), { once: true });
  });
}

async function selectElectrumNodes() {
  const now = Date.now();
  if (electrumNodeCache && now - electrumNodeCacheAt < 60_000) {
    return electrumNodeCache;
  }

  if (!electrumNodeProbePromise) {
    electrumNodeProbePromise = (async () => {
      const results = await Promise.all(
        MAINNET_ELECTRUM_NODES.map(async (node) => ({
          node,
          ok: await probeElectrumNode(node),
        })),
      );

      const healthy = results.filter((r) => r.ok).map((r) => r.node);
      const unhealthy = results.filter((r) => !r.ok).map((r) => r.node);
      const selected =
        healthy.length > 0
          ? [...healthy, ...unhealthy]
          : MAINNET_ELECTRUM_NODES;

      electrumNodeCache = selected;
      electrumNodeCacheAt = Date.now();
      return selected;
    })();
  }

  try {
    return await electrumNodeProbePromise;
  } finally {
    electrumNodeProbePromise = null;
  }
}

async function configureElectrumNodes(wallet) {
  const nodes = await selectElectrumNodes();

  wallet.ClearNodeList();
  for (const node of nodes) {
    wallet.AddNode(node.host, node.port, node.proto);
  }

  wallet.electrumNodeIndex = 0;
}

function scheduleReconnect(source, state, navWallet) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(async () => {
    if (state.closing) return;

    // Don't reconnect if already connected, syncing, synced, or closed.
    if (
      state.connected ||
      state.syncStatus === 'synced' ||
      state.syncStatus === 'syncing' ||
      state.syncStatus === 'error' ||
      state.connectPromise ||
      !state.wallet
    ) {
      return;
    }

    const electrumNodes = state.wallet.electrumNodes;
    if (Array.isArray(electrumNodes) && electrumNodes.length > 1) {
      const currentIndex = Number.isInteger(state.wallet.electrumNodeIndex)
        ? state.wallet.electrumNodeIndex
        : 0;
      state.wallet.electrumNodeIndex =
        (currentIndex + 1) % electrumNodes.length;
    }

    state.syncStatus = 'connecting';
    state.connectingAt = Date.now();

    try {
      state.connectPromise = state.wallet.Connect();
      await state.connectPromise;
    } catch {
      // Connect() errors are non-fatal — watchdog will retry.
    } finally {
      state.connectPromise = null;
    }
  }, RECONNECT_INTERVAL_MS);
}

export async function openSourceWallet(source, root, navWallet) {
  const existing = walletState.get(source.id);
  if (existing && existing.wallet && !existing.closing) {
    return existing;
  }

  if (openingWallets.has(source.id)) {
    return openingWallets.get(source.id);
  }

  const openPromise = (async () => {
    const layout = getLayout(root);
    const state = makeInitialState(source.id);
    state.sourceType = source.type;
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
      state.syncStatus = 'connected';
      state.server = server;
    });

    wallet.on('disconnected', () => {
      if (state.closing) return;

      state.connected = false;
      state.server = null;
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

    // bootstrap_started fires once at rescueScan entry AND on every electrum
    // reconnect (wallet.js:818, inside the 'ready' handler). Resetting
    // sync counters here would make progress visibly drop to 0/N on every
    // reconnect mid-scan. scripthash_progress drives the counters; nothing
    // to do here.

    wallet.on('scripthash_progress', (index, total) => {
      setSyncProgress(state, Math.round((index / total) * 100));
      state.syncCurrent = index;
      state.syncTotal = total;
    });

    wallet.on('balance_changed', async () => {
      try {
        state.balance = await computeBalance(wallet);
      } catch {
        // Non-fatal: leave previous balance intact.
      }
    });

    wallet.on('utxo_phase', (phase) => {
      state.syncStatus = 'syncing';
      state.syncPhase = phase;
    });

    wallet.on('sync_finished', async () => {
      state.syncStatus = 'synced';
      state.syncPhase = null;
      state.syncProgress = 100;
      state.syncCurrent = state.syncTotal;
      await refreshAddressesAndBalance(source.id, wallet);
      try {
        await markSourceSynced(source.id, root);
      } catch {
        // Non-fatal — registry write failure means we'll re-scan on next
        // daemon start instead of skipping. Same effective behavior as
        // before this optimization.
      }
    });

    wallet.on('new_tx', async () => {
      await refreshAddressesAndBalance(source.id, wallet);
    });

    wallet.on('no_servers_available', () => {
      if (state.closing) return;

      state.syncStatus = 'no-servers';
      state.connected = false;
      state.server = null;
      // Retry after interval — servers may come back up.
      scheduleReconnect(source, state, navWallet);
    });

    wallet.on('db_load_error', (error) => {
      if (state.closing) return;

      clearTimeout(state.reconnectTimer);
      state.syncStatus = 'error';
      state.error = String(error);
      state.wallet = null;
    });

    // Watchdog: if stuck in 'connecting' for too long, try reconnecting.
    state.watchdog = setInterval(() => {
      if (!walletState.has(source.id)) {
        clearInterval(state.watchdog);
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
      await wallet.Load({
        useP2p: false,
        minPoolSize: getSourceMinPoolSize(source),
        skipInitialHistorySync: true,
      });
      await prunePrivateKeyPool(wallet, source);
      await configureElectrumNodes(wallet);

      // Seed initial address and balance snapshot before connecting.
      await refreshAddressesAndBalance(source.id, wallet);

      state.syncStatus = 'connecting';
      state.connectingAt = Date.now();
      state.connectPromise = wallet.Connect();
      await state.connectPromise;

      // wallet.Connect resolves when server_banner returns, but the
      // 'ready' handler (which subscribes to headers/dao/etc) is async
      // and may still be running. Wait for the 'connected' event handler
      // to flip state.connected before starting the scan so the first
      // requests don't race against the connect handshake.
      await waitForConnected(state);

      if (source.lastSyncedAt) {
        // Source has been fully scanned before. Skip the auto re-scan on
        // open and rely on user-triggered `rescan` for updates. State is
        // already populated from the seed refresh above.
        state.syncStatus = 'synced';
        state.syncProgress = 100;
      } else {
        // Mark in-flight so a /rescan request landing during the brief
        // 'connected' / pre-progress window can't kick off a second
        // concurrent scan that races with this one's outpointsSeen and
        // reapStaleUtxos passes (was the source of growing-balance bugs).
        state.rescanInFlight = true;
        rescueScan(wallet, {
          skipDerive: source.type === 'private-key',
        })
          .catch((err) => {
            if (state.closing) return;
            state.syncStatus = 'error';
            state.error = err.message;
          })
          .finally(() => {
            state.rescanInFlight = false;
          });
      }
    } catch (error) {
      state.syncStatus = 'error';
      state.error = error.message;
    } finally {
      state.connectPromise = null;
    }

    return state;
  })();

  openingWallets.set(source.id, openPromise);

  try {
    return await openPromise;
  } finally {
    openingWallets.delete(source.id);
  }
}

async function refreshAddressesAndBalance(sourceId, wallet) {
  const state = walletState.get(sourceId);
  if (!state) return;

  try {
    const navAddrs = await wallet.NavReceivingAddresses(true);
    const xnavAddrs = await wallet.xNavReceivingAddresses(true);

    // Aggregate UTXO amounts by spendingPk for transparent NAV / cold-stake
    // outputs and by hashId for xNAV outputs (which use blsct keys, not
    // a per-address pubkey).
    const balanceByPk = new Map();
    const balanceByHashId = new Map();
    try {
      const utxos = await wallet.db.GetUtxos(true);
      for (const u of utxos) {
        if (u.spentIn) continue;
        if (u.type & OUT_XNAV) {
          if (!u.hashId) continue;
          balanceByHashId.set(
            u.hashId,
            (balanceByHashId.get(u.hashId) ?? 0) + (u.amount ?? 0),
          );
          continue;
        }
        if (!u.spendingPk) continue;
        balanceByPk.set(
          u.spendingPk,
          (balanceByPk.get(u.spendingPk) ?? 0) + (u.amount ?? 0),
        );
      }
    } catch {
      // Non-fatal: balance maps stay empty, addresses report 0.
    }

    state.addresses = [
      ...navAddrs.map((a) => ({
        address: a.address,
        path: a.path,
        used: a.used === 1,
        isChange: a.change,
        isXNav: false,
        balance: balanceByPk.get(a.hash) ?? 0,
      })),
      ...xnavAddrs.map((a) => ({
        address: a.address,
        path: a.path,
        used: false,
        isChange: false,
        isXNav: true,
        balance: balanceByHashId.get(a.hash) ?? 0,
      })),
    ];
  } catch {
    // Non-fatal: leave previous address list intact.
  }

  try {
    state.balance = await computeBalance(wallet);
  } catch {
    // Non-fatal: leave previous balance intact.
  }
}

export async function closeSourceWallet(sourceId) {
  openingWallets.delete(sourceId);
  const state = walletState.get(sourceId);
  if (!state) return;
  state.closing = true;

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;

  clearInterval(state.watchdog);
  state.watchdog = null;

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

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;

  state.wallet = null;
  walletState.delete(sourceId);
}

export async function closeAllWallets() {
  await Promise.all([...walletState.keys()].map(closeSourceWallet));
}

export async function purgeAllWallets() {
  await closeAllWallets();
  walletState.clear();
}

/**
 * Validate that all sources are fully synced and return a sweep preview.
 *
 * Returns:
 *   {
 *     totalNav,
 *     totalXNav,
 *     totalCombined,
 *     sources: [{ sourceId, nav, xnav }],
 *   }
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
  let totalXNav = 0;
  const sources = [];

  for (const state of states) {
    const nav = state.balance.nav.confirmed;
    const xnav = state.balance.xnav?.confirmed ?? 0;
    totalNav += nav;
    totalXNav += xnav;
    sources.push({ sourceId: state.sourceId, nav, xnav });
  }

  return {
    totalNav,
    totalXNav,
    totalCombined: totalNav + totalXNav,
    sources,
  };
}

/**
 * Execute the sweep: for each source with a non-zero confirmed balance,
 * broadcast a NAV leg and/or an xNAV leg to the destination.
 *
 * Returns:
 *   { hashes: string[], totalSent: number, totalFee: number }
 *
 * Throws if any broadcast fails. Already-broadcast legs from earlier sources
 * cannot be undone — partial-success state is the responsibility of callers
 * to surface.
 */
export async function executeSweep(destination) {
  const states = [...walletState.values()];
  const hashes = [];
  let totalSent = 0;
  let totalFee = 0;

  for (const state of states) {
    if (!state.wallet) continue;

    const nav = state.balance.nav.confirmed;
    const xnav = state.balance.xnav?.confirmed ?? 0;

    if (nav > 0) {
      const navResult = await broadcastLeg(
        state,
        'NAV',
        () =>
          state.wallet.NavCreateTransaction(
            destination,
            nav,
            '',
            STATIC_WALLET_PASSWORD,
            true,
          ),
        nav,
      );
      hashes.push(...navResult.hashes);
      totalSent += navResult.sent;
      totalFee += navResult.fee;
    }

    if (xnav > 0) {
      const xnavResult = await broadcastLeg(
        state,
        'xNAV',
        () =>
          state.wallet.xNavCreateTransaction(
            destination,
            xnav,
            '',
            STATIC_WALLET_PASSWORD,
            true,
          ),
        xnav,
      );
      hashes.push(...xnavResult.hashes);
      totalSent += xnavResult.sent;
      totalFee += xnavResult.fee;
    }
  }

  return { hashes, totalSent, totalFee };
}

async function broadcastLeg(state, label, createTx, amount) {
  const tx = await createTx();
  if (!tx || !tx.tx) {
    throw new Error(
      `Failed to create ${label} transaction for source ${state.sourceId}`,
    );
  }

  const result = await state.wallet.SendTransaction(tx.tx);
  if (result.error) {
    throw new Error(
      `${label} broadcast failed for source ${state.sourceId}: ${result.error}`,
    );
  }

  const fee = tx.fee ?? 0;
  return {
    hashes: result.hashes ?? [],
    sent: amount - fee,
    fee,
  };
}
