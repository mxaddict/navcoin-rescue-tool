import { randomUUID } from 'node:crypto';

import { readAuthCookie } from './app-data.js';
import { APP_VERSION, DAEMON_HOST, DAEMON_PORT } from './constants.js';

// How long a stopped daemon gets to let go of the port. Its own shutdown
// force-exits on a timer in `performShutdown` (daemon.js); this only has to
// outlast that.
const DAEMON_STOP_TIMEOUT_MS = 15_000;

// How often a sweep whose reply was lost is looked up again on /status.
const SWEEP_FOLLOW_INTERVAL_MS = 2_000;

function buildUrl(pathname) {
  return new URL(`http://${DAEMON_HOST}:${DAEMON_PORT}${pathname}`);
}

function describeFetchFailure(error) {
  const cause = error?.cause;
  if (!cause) return error?.message ?? String(error);
  const reason = [cause.code, cause.message].filter(Boolean).join(': ');
  return `${error.message} (${reason})`;
}

export async function daemonRequest(
  pathname,
  { method = 'GET', root, body } = {},
) {
  const authCookie = await readAuthCookie(root);
  let response;
  try {
    response = await fetch(buildUrl(pathname), {
      method,
      headers: {
        Authorization: authCookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // fetch reports every network failure as "fetch failed" and keeps
    // the reason (refused, reset, timed out) on `cause`; name it, or a
    // daemon that died reads the same as one that was too slow to reply.
    throw new Error(describeFetchFailure(error), { cause: error });
  }

  if (!response.ok) {
    const text = await response.text();
    let message;
    let body;
    try {
      body = JSON.parse(text);
      message = body.error ?? text;
    } catch {
      message = text;
    }
    const error = new Error(
      message || `Daemon request failed with status ${response.status}`,
    );
    // Carry the daemon's classification onto the thrown error so callers
    // can branch on it instead of parsing the message.
    if (body?.code) error.code = body.code;
    if (body?.waivable === true) error.waivable = true;
    throw error;
  }

  return response.json();
}

export function getDaemonStatus(root) {
  return daemonRequest('/status', { root });
}

export function stopDaemon(root) {
  return daemonRequest('/daemon/stop', { method: 'POST', root });
}

// The daemon is detached and outlives the CLI or TUI that started it, so
// after an upgrade the old version keeps the port and the new client drives
// it: a user on a fixed release still runs the bug. Stops a daemon whose
// `/status` reports another version and waits until the port is free,
// returning the version it stopped, or null when the running one is ours.
export async function stopDaemonFromOtherVersion(root, status) {
  if (status.version === APP_VERSION) return null;

  await stopDaemon(root);
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await getDaemonStatus(root);
    } catch (error) {
      if (error.cause?.cause?.code === 'ECONNREFUSED') {
        return status.version ?? 'unknown';
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `The daemon on port ${DAEMON_PORT} (version ` +
      `${status.version ?? 'unknown'}) did not stop. Stop it and try again.`,
  );
}

export function importDaemonSource(body, root) {
  return daemonRequest('/import', { method: 'POST', root, body });
}

export function removeDaemonSource(sourceId, root) {
  return daemonRequest('/remove', {
    method: 'POST',
    root,
    body: { sourceId },
  });
}

export function purgeDaemon(root) {
  return daemonRequest('/purge', { method: 'POST', root });
}

export function rescanDaemon(root) {
  return daemonRequest('/rescan', { method: 'POST', root });
}

export function sweepPrepare(root, { force = false } = {}) {
  return daemonRequest('/sweep/prepare', {
    method: 'POST',
    root,
    body: { force },
  });
}

// Runs the sweep and returns `{ result }`. A sweep can outlast the request
// that started it: building and broadcasting every leg can take longer than
// fetch waits for a reply, and the daemon carries on regardless. So the
// sweep is given an id, and when the reply is lost it is followed on
// /status until it ends, instead of reporting a failure for a sweep that
// may be broadcasting. `onLostReply` is told when that starts.
export async function sweepConfirm(
  destination,
  confirmPhrase,
  root,
  { force = false, onLostReply } = {},
) {
  const sweepId = randomUUID();
  try {
    return await daemonRequest('/sweep/confirm', {
      method: 'POST',
      root,
      body: { destination, confirmPhrase, force, sweepId },
    });
  } catch (error) {
    // No `cause`: the daemon answered, and the sweep failed for the reason
    // it gave. A refused connection never reached a daemon at all.
    if (!error.cause || error.cause.cause?.code === 'ECONNREFUSED') {
      throw error;
    }
    onLostReply?.(error);
    return { result: await followSweep(sweepId, root, error) };
  }
}

const CHECK_BEFORE_SWEEPING_AGAIN =
  'Transactions may have gone out: check the [sweep] lines in the daemon ' +
  'log and the destination address on a block explorer before sweeping again.';

async function followSweep(sweepId, root, lost) {
  for (;;) {
    let status;
    try {
      status = await getDaemonStatus(root);
    } catch (error) {
      throw new Error(
        `Lost the daemon's reply to the sweep (${lost.message}) and it ` +
          `cannot be reached now (${error.message}). ` +
          CHECK_BEFORE_SWEEPING_AGAIN,
      );
    }

    const sweep = status.sweep;
    if (sweep?.id !== sweepId) {
      throw new Error(
        `Lost the daemon's reply to the sweep (${lost.message}) and the ` +
          `daemon has no record of it, as after a restart. ` +
          CHECK_BEFORE_SWEEPING_AGAIN,
      );
    }
    if (sweep.state === 'finished') return sweep.result;
    if (sweep.state === 'failed') throw new Error(sweep.error);

    await new Promise((resolve) =>
      setTimeout(resolve, SWEEP_FOLLOW_INTERVAL_MS),
    );
  }
}

// One line per part of a balance a sweep did not send, for a client to
// print under its result. `leftBehind` is absent from a daemon older than
// the client.
export function describeLeftBehind(leftBehind = []) {
  return leftBehind.map(({ sourceId, walletType, coin, reason, amount }) => {
    const source = walletType ? `${sourceId} (${walletType})` : sourceId;
    const why =
      reason === 'too-small'
        ? 'in outputs too small to pay their own fee'
        : 'not spendable yet; sweep again once it has confirmed or matured';
    return `${(amount / 1e8).toFixed(8)} ${coin} left in ${source}: ${why}`;
  });
}
