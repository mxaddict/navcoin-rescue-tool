import { readAuthCookie } from './app-data.js';
import { APP_VERSION, DAEMON_HOST, DAEMON_PORT } from './constants.js';

// How long a stopped daemon gets to let go of the port. Its own shutdown
// force-exits on a timer in `performShutdown` (daemon.js); this only has to
// outlast that.
const DAEMON_STOP_TIMEOUT_MS = 15_000;

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

export function sweepConfirm(
  destination,
  confirmPhrase,
  root,
  { force = false } = {},
) {
  return daemonRequest('/sweep/confirm', {
    method: 'POST',
    root,
    body: { destination, confirmPhrase, force },
  });
}
