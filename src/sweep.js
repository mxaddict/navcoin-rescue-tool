// Sweeping every imported source to one destination: the preview, the
// broadcast of each leg, and the daemon-log record of what went out.
import {
  buildNavBatch,
  buildXnavBatch,
  planNavBatches,
  planXnavBatches,
} from './sweep-batches.js';
import {
  describeSource,
  listSourceStates,
  OUT_NAV,
  OUT_STAKED,
  rescanSource,
} from './wallet-manager.js';

// Why a source cannot take part in a sweep, or null if it can.
function sweepBlockReason(state) {
  if (state.error) return `in error state: ${state.error}`;
  if (state.syncStatus !== 'synced')
    return `not fully synced (status: ${state.syncStatus})`;
  // 'synced' says the rescue scan finished. navcoin-js runs a sync of its
  // own on every connect, one queued job for each transaction in the
  // wallet's history, and for a long history it is still going then. A
  // build started under it shares the database and the server with those
  // jobs and can run out of time.
  const queue = state.wallet?.queue;
  if (queue?.running)
    return `still processing transactions (${queue.q.length} queued)`;
  return null;
}

// Split the sources into the ones a sweep can spend from and the ones it
// cannot. Both `prepareSweep` and `executeSweep` go through this so the
// preview and the broadcast can never disagree about which sources are in.
//
// `registered` is every source in the registry. One with no open wallet
// has no live state to look at: its wallet is still being built after an
// import, or failed to build. It holds an unknown balance like any other
// unsynced source, so it blocks the sweep the same way instead of being
// left out without a word.
function partitionSweepSources(registered) {
  const ready = [];
  const blocked = [];
  const open = new Set();

  for (const state of listSourceStates()) {
    open.add(state.sourceId);
    const reason = sweepBlockReason(state);
    if (reason) {
      blocked.push({ state, reason });
    } else {
      ready.push(state);
    }
  }

  for (const source of registered) {
    if (open.has(source.id)) continue;
    blocked.push({
      // Just enough of a state for the messages that name a blocker.
      state: { sourceId: source.id, walletType: source.walletType ?? null },
      reason: source.error
        ? `wallet could not be opened: ${source.error}`
        : 'wallet not opened yet',
    });
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
 *
 * `registered` is every source in the registry, so that one whose wallet
 * is not open counts as not synced too.
 */
export function prepareSweep({ force = false, registered = [] } = {}) {
  const { ready, blocked } = partitionSweepSources(registered);
  const total = ready.length + blocked.length;

  if (total === 0) {
    throw new Error('No imported sources. Import a wallet before sweeping.');
  }

  // An unsynced source has an unknown balance, so sweeping around it can
  // leave coins behind with nothing saying so. Every blocker is listed
  // rather than just the first: one phrase opens several derivations, and
  // being sent back to wait once per source is its own failure.
  if (blocked.length > 0 && !force) {
    const lines = blocked.map(
      ({ state, reason }) => `  ${describeSource(state)} — ${reason}`,
    );

    throw new Error(
      `${blocked.length} of ${total} sources are not ready to sweep:\n` +
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

// Why part of a balance was not swept, as `leftBehind[].reason`.
export const LEFT_TOO_SMALL = 'too-small';
export const LEFT_NOT_SPENDABLE = 'not-spendable';

// One timestamped daemon-log line per sweep step. A sweep that fails,
// hangs or loses its client mid-broadcast is otherwise invisible in a
// user's log, and whether a transaction went out is the first thing they
// need to know before retrying. Never logs keys or transaction hex.
function logSweep(message) {
  console.error(`${new Date().toISOString()} [sweep] ${message}`);
}

// How long one step of a leg may go unanswered before the sweep gives up
// on it. Building can be slow for real — an xNAV transaction is heavy
// arithmetic, and it fetches input transactions on the way — so it gets
// far longer than the single request a broadcast is. These are the last
// resort for a server that stays connected and never answers; a dropped
// connection interrupts the step at once through `state.sweepAbort`.
export const SWEEP_BUILD_TIMEOUT_MS = 10 * 60_000;
export const SWEEP_BROADCAST_TIMEOUT_MS = 2 * 60_000;

// How many times in a row a leg may have a batch rejected over spent
// outputs, rescan, and have the next batch rejected too with nothing sent
// in between, before the sweep gives up. Any batch that goes out starts
// the count again, so a wallet that is staking is swept for as long as
// the sweep keeps ahead of it.
export const SWEEP_STALE_ROUNDS = 5;

// On the error of a batch the node answered and refused. The only failure
// a rescan can explain: nothing went out, and the answer is in.
const SWEEP_BATCH_REJECTED = 'SWEEP_BATCH_REJECTED';

// The sweep running now, or the last one that ran: what the daemon reports
// on /status, so a client that lost the reply to its request can still
// learn what was broadcast. Kept in memory only.
let sweepRecord = null;
let sweepRunning = false;

export function getSweepStatus() {
  return sweepRecord ? structuredClone(sweepRecord) : null;
}

// A step of a leg that stopped waiting: the connection dropped, the wallet
// closed, or the server never answered. The request itself may still be
// in flight, which is why a broadcast interrupted this way has an unknown
// outcome rather than a failed one.
class SweepStepInterrupted extends Error {}

// Settle with `promise`, unless the source loses its connection or
// `timeoutMs` passes first. navcoin-js's electrum client drops a pending
// request without settling it when the socket closes, so a step caught by
// a drop would otherwise wait forever and the sweep with it. `timedOut`
// says what did not happen, for the message of a step that ran out of time.
function untilInterrupted(promise, state, timeoutMs, timedOut) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    state.sweepAbort = controller;

    const finish = (settle, value) => {
      clearTimeout(timer);
      if (state.sweepAbort === controller) state.sweepAbort = null;
      settle(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new SweepStepInterrupted(`${timedOut} within ${timeoutMs / 1000}s`),
        ),
      timeoutMs,
    );
    controller.signal.addEventListener(
      'abort',
      () =>
        finish(
          reject,
          new SweepStepInterrupted('the server connection dropped'),
        ),
      { once: true },
    );

    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

// What already went out, for the error of a sweep that then failed: the
// legs after the failure are never attempted, and without this the caller
// sees only the failure and nothing of the coins that moved before it.
function describeBroadcastLegs(record) {
  return record.legs
    .filter((leg) => leg.hashes.length > 0)
    .map(
      (leg) => `  ${leg.label} from ${leg.source}: ${leg.hashes.join(', ')}`,
    );
}

/**
 * Execute the sweep: for each source with a non-zero confirmed balance,
 * broadcast a NAV leg and/or an xNAV leg to the destination. A leg goes
 * out as one transaction per batch of outputs: see sweep-batches.js.
 *
 * Returns:
 *   {
 *     hashes: string[],
 *     totalSent: number,
 *     totalFee: number,
 *     leftBehind: [{ sourceId, walletType, coin, reason, amount }],
 *   }
 * where `leftBehind` is what was not swept, empty when everything went:
 * `reason` is LEFT_TOO_SMALL for outputs that could not pay their own fee
 * and LEFT_NOT_SPENDABLE for coins the wallet cannot spend yet.
 *
 * Throws if any leg fails, with the legs already broadcast listed in the
 * message: they cannot be undone, and the sources after the failure are
 * not attempted. A leg whose broadcast was interrupted before the server
 * answered throws with code SWEEP_OUTCOME_UNKNOWN. Only one sweep runs at a
 * time; a second one throws with code SWEEP_IN_PROGRESS.
 *
 * Spends only from the sources `prepareSweep` would have accepted for the
 * same `force`, so what is broadcast is what the preview showed.
 *
 * A batch the node rejects is not the end when its outputs went stale: a
 * wallet that is still staking spends them while it is swept. The source
 * is rescanned with `rescan(sourceId)`, which resolves true once it is
 * synced again, and the leg goes on from what is still unspent. See
 * `sweepLeg`.
 *
 * `id` names the sweep in `getSweepStatus`, so a client can tell the sweep
 * it asked for from an earlier one. `registered` is as for `prepareSweep`.
 */
export async function executeSweep(
  destination,
  { force = false, id = null, registered = [], rescan = rescanSource } = {},
) {
  if (sweepRunning) {
    logSweep('refused: another sweep is still running');
    const error = new Error(
      'A sweep is already running. Wait for it to finish before starting ' +
        'another: its outcome is in the daemon status and the daemon log.',
    );
    error.code = 'SWEEP_IN_PROGRESS';
    throw error;
  }

  const { ready, blocked } = partitionSweepSources(registered);

  logSweep(
    `start: destination=${destination} ready=${ready.length} ` +
      `blocked=${blocked.length} force=${force}`,
  );

  if (blocked.length > 0 && !force) {
    logSweep(`refused: ${blocked.length} source(s) not ready`);
    for (const { state, reason } of blocked) {
      logSweep(`${describeSource(state)}: ${reason}`);
    }
    throw new Error(`${blocked.length} source(s) are not ready to sweep.`);
  }

  const record = {
    id,
    state: 'running',
    destination,
    force,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    legs: [],
    result: null,
    error: null,
  };
  sweepRecord = record;
  sweepRunning = true;

  try {
    const result = await sweepReadySources(ready, destination, record, rescan);
    logSweep(
      `finished: ${result.hashes.length} transaction(s), ` +
        `sent=${result.totalSent} fee=${result.totalFee}`,
    );
    record.state = 'finished';
    record.result = result;
    return result;
  } catch (error) {
    logSweep(`failed: ${error?.stack ?? error}`);
    const sent = describeBroadcastLegs(record);
    if (sent.length > 0) {
      error.message +=
        `\nAlready broadcast before this, and not undone:\n` + sent.join('\n');
    }
    record.state = 'failed';
    record.error = error.message;
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
    sweepRunning = false;
  }
}

async function sweepReadySources(ready, destination, record, rescan) {
  const totals = { hashes: [], totalSent: 0, totalFee: 0, leftBehind: [] };

  for (const state of ready) {
    if (!state.wallet) {
      logSweep(`${describeSource(state)}: skipped, wallet not open`);
      continue;
    }

    const nav = state.balance.nav.confirmed;
    const xnav = state.balance.xnav?.confirmed ?? 0;
    logSweep(`${describeSource(state)}: nav=${nav} xnav=${xnav}`);

    if (nav > 0) {
      // Spend cold-stake outputs too. Not OUT_STAKED alone: with that
      // type navcoin-js sends change back to a cold-stake script.
      const type = OUT_NAV | OUT_STAKED;
      await sweepLeg(state, 'NAV', record, totals, {
        balance: () => state.balance.nav.confirmed,
        plan: () => planNavBatches(state.wallet, type),
        build: (batch) => buildNavBatch(state.wallet, destination, batch, type),
        rescan,
      });
    }

    if (xnav > 0) {
      await sweepLeg(state, 'xNAV', record, totals, {
        balance: () => state.balance.xnav?.confirmed ?? 0,
        plan: () => planXnavBatches(state.wallet),
        build: (batch) => buildXnavBatch(state.wallet, destination, batch),
        rescan,
      });
    }
  }

  return totals;
}

const outpointOf = (output) => `${output.txid}:${output.vout}`;

// Broadcast one leg of one source, a batch at a time, adding what went out
// to `totals`. Each batch is built only after the one before it was
// broadcast.
//
// `leg` is how to work on this coin of this source: `plan()` deals the
// outputs spendable now into batches, `build(batch)` builds one,
// `balance()` is what the source shows for the coin, and `rescan` is as
// for `executeSweep`.
//
// A batch the node rejects ends the sweep unless its outputs went stale.
// To find out, the source is rescanned and the leg planned again: when
// outputs of the rejected batch are no longer among the unspent ones,
// something else spent them, a stake usually, and the leg carries on with
// the new plan. It does so for as long as batches keep going out; see
// SWEEP_STALE_ROUNDS. When every output of the rejected batch is still
// unspent, the rejection was about something else and stands.
//
// Whatever part of the balance the last plan did not send is reported in
// `totals.leftBehind`.
async function sweepLeg(state, coin, record, totals, leg) {
  const source = describeSource(state);
  // The balance beside the plan made from it: both move with a rescan.
  let balance = leg.balance();
  let plan = await leg.plan();
  let rescans = 0;
  let staleRounds = 0;

  for (;;) {
    const { batches } = plan;
    const outputs = batches.reduce((sum, b) => sum + b.outputs.length, 0);
    logSweep(
      `${source} ${coin}: ${outputs} output(s) in ${batches.length} ` +
        `transaction batch(es)`,
    );
    const round = rescans > 0 ? ` after rescan ${rescans}` : '';

    let rejected = null;
    for (const [index, batch] of batches.entries()) {
      const label =
        (batches.length > 1 ? `${coin} ${index + 1}/${batches.length}` : coin) +
        round;
      try {
        const result = await broadcastLeg(
          state,
          label,
          () => leg.build(batch),
          batch.amount,
          record,
        );
        totals.hashes.push(...result.hashes);
        totals.totalSent += result.sent;
        totals.totalFee += result.fee;
        staleRounds = 0;
      } catch (error) {
        if (error.code !== SWEEP_BATCH_REJECTED) throw error;
        rejected = { batch, error };
        break;
      }
    }
    if (!rejected) break;

    staleRounds += 1;
    if (staleRounds > SWEEP_STALE_ROUNDS) {
      rejected.error.message +=
        `\nGave up after ${SWEEP_STALE_ROUNDS} rescans in a row with ` +
        `nothing sent in between: outputs kept being spent while the ` +
        `sweep ran. If this wallet is staking, stop it and sweep again.`;
      throw rejected.error;
    }

    logSweep(
      `${source} ${coin}: batch rejected, rescanning to see whether its ` +
        `outputs were spent`,
    );
    if (!(await leg.rescan(state.sourceId))) {
      logSweep(`${source} ${coin}: the rescan did not finish`);
      rejected.error.message += `\nThe rescan to check for spent outputs did not finish.`;
      throw rejected.error;
    }
    rescans += 1;

    balance = leg.balance();
    plan = await leg.plan();
    const unspent = new Set(
      plan.batches.flatMap((batch) => batch.outputs.map(outpointOf)),
    );
    const gone = rejected.batch.outputs.filter(
      (output) => !unspent.has(outpointOf(output)),
    );
    if (gone.length === 0) {
      logSweep(
        `${source} ${coin}: every output of the rejected batch is still ` +
          `unspent, so the rejection stands`,
      );
      throw rejected.error;
    }
    logSweep(
      `${source} ${coin}: ${gone.length} output(s) of the rejected batch ` +
        `are no longer unspent; sweeping what is left`,
    );
  }

  const leave = (reason, amount, detail) => {
    logSweep(`${source} ${coin}: ${amount} left behind, ${detail}`);
    totals.leftBehind.push({
      sourceId: state.sourceId,
      walletType: state.walletType ?? null,
      coin,
      reason,
      amount,
    });
  };
  const { batches, left } = plan;
  if (left.outputs > 0) {
    leave(
      LEFT_TOO_SMALL,
      left.amount,
      `${left.outputs} output(s) too small to pay their fee`,
    );
  }
  // navcoin-js holds back outputs the balance already counts: a stake
  // reward until it has matured, xNAV until it has confirmed.
  const planned = batches.reduce((sum, batch) => sum + batch.amount, 0);
  const unspendable = balance - planned - left.amount;
  if (unspendable > 0) {
    leave(LEFT_NOT_SPENDABLE, unspendable, 'not spendable yet');
  }
}

async function broadcastLeg(state, label, createTx, amount, record) {
  const source = describeSource(state);
  // 'building', then 'broadcasting', then 'broadcast'; or 'failed' when the
  // leg certainly did not go out, or 'unknown' when it may have.
  const legRecord = {
    source,
    label,
    amount,
    status: 'building',
    hashes: [],
    error: null,
  };
  record.legs.push(legRecord);

  try {
    return await runLeg(state, label, createTx, amount, legRecord);
  } catch (error) {
    if (legRecord.status !== 'unknown') legRecord.status = 'failed';
    legRecord.error = error.message;
    throw error;
  }
}

async function runLeg(state, label, createTx, amount, legRecord) {
  const leg = `${legRecord.source} ${label}`;

  // Without a connection navcoin-js has no client: it builds from what the
  // wallet database holds and then reports a broadcast that sent nothing.
  if (!state.connected) {
    logSweep(`${leg}: not started, no server connection`);
    throw new Error(
      `${label} for source ${state.sourceId} was not broadcast: the wallet ` +
        `has no server connection. Wait for it to reconnect and sweep again.`,
    );
  }

  logSweep(`${leg}: building transaction for ${amount}`);
  const buildStart = Date.now();
  let tx;
  try {
    tx = await untilInterrupted(
      createTx(),
      state,
      SWEEP_BUILD_TIMEOUT_MS,
      'the build did not finish',
    );
  } catch (error) {
    if (!(error instanceof SweepStepInterrupted)) throw error;
    logSweep(`${leg}: build interrupted, ${error.message}`);
    throw new Error(
      `${label} for source ${state.sourceId} was not broadcast: ` +
        `${error.message} while the transaction was being built.`,
    );
  }
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

  legRecord.status = 'broadcasting';
  const sendStart = Date.now();
  const sending = state.wallet.SendTransaction(tx.tx);
  let result;
  try {
    result = await untilInterrupted(
      sending,
      state,
      SWEEP_BROADCAST_TIMEOUT_MS,
      'the server did not answer',
    );
  } catch (error) {
    if (!(error instanceof SweepStepInterrupted)) throw error;
    logSweep(
      `${leg}: broadcast outcome unknown after ${Date.now() - sendStart}ms, ` +
        `${error.message}`,
    );
    // The request was already sent. If an answer still arrives, the log is
    // the only place left that can record it.
    sending.then(
      (late) =>
        logSweep(
          `${leg}: late broadcast answer, hashes=` +
            `${(late?.hashes ?? []).filter(Boolean).join(',') || 'none'}` +
            `${late?.error ? ` error=${late.error}` : ''}`,
        ),
      (lateError) => logSweep(`${leg}: late broadcast error: ${lateError}`),
    );
    legRecord.status = 'unknown';
    const unknown = new Error(
      `${label} broadcast for source ${state.sourceId} has an unknown ` +
        `outcome: ${error.message} before it confirmed the transaction. ` +
        `It may or may not have gone out. Check the destination address on ` +
        `a block explorer before sweeping again.`,
    );
    unknown.code = 'SWEEP_OUTCOME_UNKNOWN';
    throw unknown;
  }

  // navcoin-js can send a leg as several transactions; on a failure the
  // ones already out are only in `hashes`.
  const hashes = (result.hashes ?? []).filter(Boolean);
  legRecord.hashes = hashes;
  const sentHashes = hashes.join(',') || 'none';
  if (result.error) {
    logSweep(
      `${leg}: broadcast rejected after ${Date.now() - sendStart}ms, ` +
        `hashes=${sentHashes}: ${result.error}`,
    );
    const refused = new Error(
      `${label} broadcast failed for source ${state.sourceId}: ${result.error}`,
    );
    // Part of the leg already out is not something a rescan and another
    // try can account for.
    if (hashes.length === 0) refused.code = SWEEP_BATCH_REJECTED;
    throw refused;
  }
  // navcoin-js reports success with no transaction id when its client is
  // gone, having sent nothing.
  if (hashes.length === 0) {
    logSweep(`${leg}: broadcast returned no transaction id; nothing sent`);
    throw new Error(
      `${label} for source ${state.sourceId} was not broadcast: the wallet ` +
        `lost its server connection. Wait for it to reconnect and sweep again.`,
    );
  }
  logSweep(
    `${leg}: broadcast in ${Date.now() - sendStart}ms, hashes=${sentHashes}`,
  );

  legRecord.status = 'broadcast';
  const fee = tx.fee ?? 0;
  return {
    hashes,
    sent: amount - fee,
    fee,
  };
}
