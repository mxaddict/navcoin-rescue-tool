import { getLayout } from './app-data.js';
import { STATIC_WALLET_PASSWORD } from './constants.js';
import {
  advanceElectrumNode,
  configureElectrumNodes,
  connectWithFailover,
  describeElectrumNode,
  retireElectrumClient,
} from './electrum-connection.js';
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
// Every unspent output, or null when this wallet has no queryable db.
//
// Real wallets expose wallet.db.GetUtxos / wallet.db.GetTx; tests use a
// simpler mock without a db, and callers fall back to the wallet's own
// GetBalance in that case so the fixtures don't need to model UTXOs.
async function readUnspentOutputs(wallet) {
  try {
    const utxos = await wallet.db.GetUtxos(true);
    return Array.isArray(utxos) ? utxos : null;
  } catch {
    return null;
  }
}

// `outputs` is the result of readUnspentOutputs when the caller already
// has it. Reading them again here is the same table scan twice on the
// busiest path in the daemon.
async function computeBalance(wallet, outputs = undefined) {
  const utxos =
    outputs === undefined ? await readUnspentOutputs(wallet) : outputs;
  if (!utxos) return await wallet.GetBalance();

  let navConfirmed = 0;
  let navPending = 0;
  let xnavConfirmed = 0;
  let xnavPending = 0;
  let stakedConfirmed = 0;
  let stakedPending = 0;

  // One output per transaction is the exception, not the rule, and a
  // rescan re-reads the same set repeatedly — so look each transaction up
  // once rather than once per output it paid us.
  const txByHash = new Map();

  for (const utxo of utxos) {
    if (utxo.spentIn) continue;
    const prevHash = utxo.id.split(':')[0];
    if (!txByHash.has(prevHash)) {
      txByHash.set(prevHash, await wallet.db.GetTx(prevHash));
    }
    const tx = txByHash.get(prevHash);
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

export { resetElectrumNodeSelectionCache } from './electrum-connection.js';

// How long to wait after every node failed before trying the list again.
const RECONNECT_INTERVAL_MS = 10_000;
// How long to wait after a live connection drops before moving to the
// next node. One drop fires several disconnect events; they all land
// inside this window and are handled once.
export const FAILOVER_DELAY_MS = 1_000;
// How often a scan waiting for a connection checks for one.
const CONNECTED_POLL_MS = 50;
// How long transactions are allowed to accumulate before the address and
// balance snapshot is rebuilt.
const REFRESH_COALESCE_MS = 1_000;

function makeInitialState(sourceId, root) {
  return {
    sourceId,
    root,
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
    // The status to show once a connection is (re)established — what the
    // source was doing when it lost one, so a synced source goes back to
    // synced instead of sticking at 'connected'.
    statusOnConnect: null,
    rescanInFlight: false,
    // Aborts the scan running now, if any.
    scanAbort: null,
    // Set when the connection drops under a running scan: that scan is
    // abandoned and runScan starts it over once reconnected.
    scanInterrupted: false,
    refreshPending: false,
    refreshInFlight: false,
    refreshTimer: null,
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

    await runScan(state, {
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

// Run rescueScan to a clean finish, then record the source as synced. A
// scan the connection dropped under is run again once there is a
// connection, because its failed lookups make it an incomplete picture,
// not a finished one.
async function runScan(state, opts) {
  let completed = false;
  do {
    await waitForConnected(state);
    if (state.closing || !state.wallet) return;

    const controller = new AbortController();
    state.scanAbort = controller;
    state.scanInterrupted = false;
    try {
      // A scan the drop cut off can be stuck on a lookup the dead socket
      // will never answer, so stop waiting for it the moment it is
      // aborted rather than when it notices.
      completed = await Promise.race([
        rescueScan(state.wallet, {
          ...opts,
          password: STATIC_WALLET_PASSWORD,
          signal: controller.signal,
        }),
        whenAborted(controller.signal).then(() => false),
      ]);
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    } finally {
      if (state.scanAbort === controller) state.scanAbort = null;
    }
  } while (state.scanInterrupted && !state.closing);

  if (completed && !state.closing) await finishSync(state);
}

async function finishSync(state) {
  state.syncStatus = 'synced';
  state.syncPhase = null;
  state.syncProgress = 100;
  state.syncCurrent = state.syncTotal;
  await refreshAddressesAndBalance(state.sourceId, state.wallet);
  try {
    await markSourceSynced(state.sourceId, state.root);
  } catch {
    // Non-fatal — registry write failure means we'll re-scan on next
    // daemon start instead of skipping. Same effective behavior as
    // before this optimization.
  }
}

function whenAborted(signal) {
  return new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
}

// Resolves once the source is connected, or will never be (closing).
async function waitForConnected(state) {
  while (!state.connected && !state.closing && state.wallet) {
    await new Promise((resolve) => setTimeout(resolve, CONNECTED_POLL_MS));
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

// The syncStatus to show, unless the source is already in error: a
// connection coming and going is not what the user needs to see over a
// failure that still stands.
function setConnectionStatus(state, status) {
  if (state.syncStatus !== 'error') state.syncStatus = status;
}

// Connect to the first node that answers. Resolves true when connected;
// false when every node failed, after scheduling another pass through the
// list. One pass at a time per source.
function connectSource(state) {
  if (!state.connectPromise) {
    state.connectPromise = (async () => {
      setConnectionStatus(state, 'connecting');
      state.connectingAt = Date.now();

      const connected = await connectWithFailover(state.wallet, {
        shouldStop: () => state.closing || !state.wallet || state.connected,
      });
      if (connected || state.connected) return true;
      if (state.closing || !state.wallet) return false;

      console.error(
        `[electrum] no node reachable for ${describeSource(state)}; ` +
          `retrying in ${RECONNECT_INTERVAL_MS / 1000}s`,
      );
      setConnectionStatus(state, 'no-servers');
      scheduleReconnect(state, RECONNECT_INTERVAL_MS, { nextNode: false });
      return false;
    })().finally(() => {
      state.connectPromise = null;
    });
  }
  return state.connectPromise;
}

// Reconnect after `delayMs`, starting from the node after the current one
// when `nextNode` is set. A timer already pending is left alone: the
// events of one outage must not keep pushing the reconnect back, which is
// how a dead node used to hold a wallet forever.
//
// The node only changes when the timer fires. navcoin-js names the
// current node in its own error lines, so moving it any earlier would log
// the dead server's last errors under the next server's name.
function scheduleReconnect(state, delayMs, { nextNode }) {
  if (state.closing || state.reconnectTimer) return;

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.closing || !state.wallet || state.connected) return;

    if (nextNode) advanceElectrumNode(state.wallet);
    connectSource(state).catch((err) => {
      if (state.closing) return;
      state.syncStatus = 'error';
      state.error = err.message;
    });
  }, delayMs);
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
    const state = makeInitialState(source.id, root);
    state.sourceType = source.type;
    // Carried so a sweep blocked by this source can name the derivation.
    // One phrase imports as several sources whose ids are indistinguishable
    // 16-hex strings, and the blocking one is usually a derivation the
    // user never chose and has no funds in.
    state.walletType = source.walletType ?? null;
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
      console.error(
        `[electrum] ${describeSource(state)} connected to ${server}`,
      );
      state.connected = true;
      state.server = server;
      setConnectionStatus(state, state.statusOnConnect ?? 'connected');
      state.statusOnConnect = null;
    });

    // Only a live connection going away is a drop. navcoin-js also fires
    // this while it sets up each new connection and once per failed
    // attempt; those belong to the attempt in progress, which handles its
    // own failure.
    wallet.on('disconnected', () => {
      if (state.closing || !state.connected || !state.wallet) return;

      console.error(
        `[electrum] ${describeSource(state)} lost ` +
          `${describeElectrumNode(wallet)}, failing over`,
      );
      state.connected = false;
      state.server = null;
      if (state.scanAbort) {
        state.scanInterrupted = true;
        state.scanAbort.abort();
      }
      state.statusOnConnect ??= state.syncStatus;
      setConnectionStatus(state, 'connecting');
      state.connectingAt = Date.now();

      scheduleReconnect(state, FAILOVER_DELAY_MS, { nextNode: true });
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

    // navcoin-js 1.1.182 never emits this; kept because it is the event
    // that should drive a balance refresh if it ever does, and routed
    // through the same coalescing so it cannot reintroduce the storm.
    wallet.on('balance_changed', () => {
      requestRefresh(source.id, wallet);
    });

    wallet.on('utxo_phase', (phase) => {
      state.syncStatus = 'syncing';
      state.syncPhase = phase;
    });

    // navcoin-js runs a sync of its own on every connect and reports it
    // finished, usually long before a scan of ours is. While one runs,
    // only that scan's clean finish counts — runScan reports it — or the
    // source is recorded as synced mid-scan and skips the scan next start.
    wallet.on('sync_finished', () => {
      if (state.rescanInFlight) return;
      void finishSync(state);
    });

    wallet.on('new_tx', () => {
      requestRefresh(source.id, wallet);
    });

    wallet.on('db_load_error', (error) => {
      if (state.closing) return;

      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      state.syncStatus = 'error';
      state.error = String(error);
      state.wallet = null;
    });

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

      // Bounded: every node gets one attempt. When none answers the source
      // opens anyway, in 'no-servers', with the next pass already scheduled.
      const connected = await connectSource(state);

      if (source.lastSyncedAt) {
        // Source has been fully scanned before. Skip the auto re-scan on
        // open and rely on user-triggered `rescan` for updates. State is
        // already populated from the seed refresh above.
        state.syncProgress = 100;
        if (connected) state.syncStatus = 'synced';
        else state.statusOnConnect = 'synced';
      } else {
        // Mark in-flight so a /rescan request landing during the brief
        // 'connected' / pre-progress window can't kick off a second
        // concurrent scan that races with this one's outpointsSeen and
        // reapStaleUtxos passes (was the source of growing-balance bugs).
        // runScan waits for a connection itself if there is none yet.
        state.rescanInFlight = true;
        runScan(state, {
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

// Ask for the snapshot to be rebuilt, coalescing bursts into one pass.
//
// A refresh reads every address and every unspent output, so it must not
// run once per transaction: a wallet with thousands of them emits
// `new_tx` thousands of times while it scans, and because the handler is
// async and nothing awaits it, every one of those passes was live at the
// same time — each holding its own address list, output list and pending
// queries. That is what exhausted the heap on a large wallet, and what
// starved the event loop until electrum dropped the socket for missing
// its keepalive, which restarted the scan that was producing the
// transactions.
function requestRefresh(sourceId, wallet) {
  const state = walletState.get(sourceId);
  if (!state || state.closing) return;

  state.refreshPending = true;

  // A pass is already running or already scheduled; it will pick this up.
  if (state.refreshInFlight || state.refreshTimer) return;

  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    void drainRefresh(sourceId, wallet);
  }, REFRESH_COALESCE_MS);

  // The snapshot is a view of the wallet, never a reason to keep the
  // daemon alive.
  state.refreshTimer.unref?.();
}

async function drainRefresh(sourceId, wallet) {
  const state = walletState.get(sourceId);
  if (!state || state.closing || state.refreshInFlight) return;

  state.refreshInFlight = true;
  try {
    state.refreshPending = false;
    await refreshAddressesAndBalance(sourceId, wallet);
  } finally {
    state.refreshInFlight = false;
  }

  // Transactions that landed mid-pass get another one, through the same
  // window — a continuous stream must not become back-to-back full reads.
  if (state.refreshPending && !state.closing) {
    requestRefresh(sourceId, wallet);
  }
}

async function refreshAddressesAndBalance(sourceId, wallet) {
  const state = walletState.get(sourceId);
  if (!state) return;

  // Read once, use for both halves: the per-address balances below and
  // the wallet totals at the end.
  const unspent = await readUnspentOutputs(wallet);

  try {
    const navAddrs = await wallet.NavReceivingAddresses(true);
    const xnavAddrs = await wallet.xNavReceivingAddresses(true);

    // Aggregate UTXO amounts by spendingPk for transparent NAV / cold-stake
    // outputs and by hashId for xNAV outputs (which use blsct keys, not
    // a per-address pubkey).
    const balanceByPk = new Map();
    const balanceByHashId = new Map();
    for (const u of unspent ?? []) {
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
    state.balance = await computeBalance(wallet, unspent);
  } catch {
    // Non-fatal: leave previous balance intact.
  }
}

export async function closeSourceWallet(sourceId) {
  openingWallets.delete(sourceId);
  const state = walletState.get(sourceId);
  if (!state) return;
  state.closing = true;
  state.scanAbort?.abort();

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;

  clearTimeout(state.refreshTimer);
  state.refreshTimer = null;

  if (!state.wallet) {
    walletState.delete(sourceId);
    return;
  }

  try {
    // Disconnect() alone closes the socket but leaves the client's own
    // reconnect loop running against a wallet nobody holds any more.
    retireElectrumClient(state.wallet);
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

function describeSource(state) {
  return state.walletType
    ? `${state.sourceId} (${state.walletType})`
    : state.sourceId;
}

// Why a source cannot take part in a sweep, or null if it can.
function sweepBlockReason(state) {
  if (state.error) return `in error state: ${state.error}`;
  if (state.syncStatus !== 'synced')
    return `not fully synced (status: ${state.syncStatus})`;
  return null;
}

// Split the open wallets into the ones a sweep can spend from and the
// ones it cannot. Both `prepareSweep` and `executeSweep` go through this
// so the preview and the broadcast can never disagree about which
// sources are in.
function partitionSweepSources() {
  const ready = [];
  const blocked = [];

  for (const state of walletState.values()) {
    const reason = sweepBlockReason(state);
    if (reason) {
      blocked.push({ state, reason });
    } else {
      ready.push(state);
    }
  }

  return { ready, blocked };
}

/**
 * Validate the sources and return a sweep preview.
 *
 * Returns:
 *   {
 *     totalNav,
 *     totalXNav,
 *     totalCombined,
 *     sources: [{ sourceId, walletType, nav, xnav }],
 *     skipped: [{ sourceId, walletType, reason }],
 *   }
 *
 * Throws if a source is not synced, unless `force` is set — then that
 * source is excluded from the sweep and reported in `skipped`.
 */
export function prepareSweep({ force = false } = {}) {
  const states = [...walletState.values()];

  if (states.length === 0) {
    throw new Error('No imported sources. Import a wallet before sweeping.');
  }

  const { ready, blocked } = partitionSweepSources();

  // An unsynced source has an unknown balance, so sweeping around it can
  // leave coins behind with nothing saying so. Every blocker is listed
  // rather than just the first: one phrase opens several derivations, and
  // being sent back to wait once per source is its own failure.
  if (blocked.length > 0 && !force) {
    const lines = blocked.map(
      ({ state, reason }) => `  ${describeSource(state)} — ${reason}`,
    );

    throw new Error(
      `${blocked.length} of ${states.length} sources are not ready to sweep:\n` +
        `${lines.join('\n')}\n` +
        `Wait for them to finish syncing, or force the sweep to skip them ` +
        `and send only what the ${ready.length} ready source(s) hold.`,
    );
  }

  if (ready.length === 0) {
    throw new Error(
      'No source is ready to sweep, so forcing would broadcast nothing.',
    );
  }

  let totalNav = 0;
  let totalXNav = 0;
  const sources = [];

  for (const state of ready) {
    const nav = state.balance.nav.confirmed;
    const xnav = state.balance.xnav?.confirmed ?? 0;
    totalNav += nav;
    totalXNav += xnav;
    sources.push({
      sourceId: state.sourceId,
      walletType: state.walletType ?? null,
      nav,
      xnav,
    });
  }

  return {
    totalNav,
    totalXNav,
    totalCombined: totalNav + totalXNav,
    sources,
    // Always present, empty when nothing was skipped, so a caller can
    // render it without checking whether the sweep was forced.
    skipped: blocked.map(({ state, reason }) => ({
      sourceId: state.sourceId,
      walletType: state.walletType ?? null,
      reason,
    })),
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
 *
 * Spends only from the sources `prepareSweep` would have accepted for the
 * same `force`, so what is broadcast is what the preview showed.
 */
export async function executeSweep(destination, { force = false } = {}) {
  const { ready, blocked } = partitionSweepSources();

  if (blocked.length > 0 && !force) {
    throw new Error(`${blocked.length} source(s) are not ready to sweep.`);
  }

  const hashes = [];
  let totalSent = 0;
  let totalFee = 0;

  for (const state of ready) {
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
