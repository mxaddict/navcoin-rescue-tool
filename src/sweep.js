// Sweeping every imported source to one destination: the preview, the
// broadcast of each leg, and the daemon-log record of what went out.
import { STATIC_WALLET_PASSWORD } from './constants.js';
import {
  describeSource,
  listSourceStates,
  OUT_NAV,
  OUT_STAKED,
} from './wallet-manager.js';

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

  for (const state of listSourceStates()) {
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
  const states = listSourceStates();

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
// One timestamped daemon-log line per sweep step. A sweep that fails,
// hangs or loses its client mid-broadcast is otherwise invisible in a
// user's log, and whether a transaction went out is the first thing they
// need to know before retrying. Never logs keys or transaction hex.
function logSweep(message) {
  console.error(`${new Date().toISOString()} [sweep] ${message}`);
}

export async function executeSweep(destination, { force = false } = {}) {
  const { ready, blocked } = partitionSweepSources();

  logSweep(
    `start: destination=${destination} ready=${ready.length} ` +
      `blocked=${blocked.length} force=${force}`,
  );

  if (blocked.length > 0 && !force) {
    logSweep(`refused: ${blocked.length} source(s) not ready`);
    throw new Error(`${blocked.length} source(s) are not ready to sweep.`);
  }

  try {
    const result = await sweepReadySources(ready, destination);
    logSweep(
      `finished: ${result.hashes.length} transaction(s), ` +
        `sent=${result.totalSent} fee=${result.totalFee}`,
    );
    return result;
  } catch (error) {
    logSweep(`failed: ${error?.stack ?? error}`);
    throw error;
  }
}

async function sweepReadySources(ready, destination) {
  const hashes = [];
  let totalSent = 0;
  let totalFee = 0;

  for (const state of ready) {
    if (!state.wallet) {
      logSweep(`${describeSource(state)}: skipped, wallet not open`);
      continue;
    }

    const nav = state.balance.nav.confirmed;
    const xnav = state.balance.xnav?.confirmed ?? 0;
    logSweep(`${describeSource(state)}: nav=${nav} xnav=${xnav}`);

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
            undefined,
            // Spend cold-stake outputs too. Not OUT_STAKED alone: with
            // that type navcoin-js sends change back to a cold-stake script.
            OUT_NAV | OUT_STAKED,
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
  const leg = `${describeSource(state)} ${label}`;

  logSweep(`${leg}: building transaction for ${amount}`);
  const buildStart = Date.now();
  const tx = await createTx();
  if (!tx || !tx.tx) {
    logSweep(`${leg}: build returned no transaction`);
    throw new Error(
      `Failed to create ${label} transaction for source ${state.sourceId}`,
    );
  }
  logSweep(
    `${leg}: built in ${Date.now() - buildStart}ms, fee=${tx.fee ?? 0}; ` +
      `broadcasting via ${state.server ?? 'no server'}`,
  );

  const sendStart = Date.now();
  const result = await state.wallet.SendTransaction(tx.tx);
  // navcoin-js can send a leg as several transactions; on a failure the
  // ones already out are only in `hashes`, which the error below drops.
  const sentHashes = (result.hashes ?? []).filter(Boolean).join(',') || 'none';
  if (result.error) {
    logSweep(
      `${leg}: broadcast rejected after ${Date.now() - sendStart}ms, ` +
        `hashes=${sentHashes}: ${result.error}`,
    );
    throw new Error(
      `${label} broadcast failed for source ${state.sourceId}: ${result.error}`,
    );
  }
  logSweep(
    `${leg}: broadcast in ${Date.now() - sendStart}ms, hashes=${sentHashes}`,
  );

  const fee = tx.fee ?? 0;
  return {
    hashes: result.hashes ?? [],
    sent: amount - fee,
    fee,
  };
}
