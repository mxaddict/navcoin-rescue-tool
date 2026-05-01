import { readAuthCookie } from './app-data.js';
import { DAEMON_HOST, DAEMON_PORT } from './constants.js';

function buildUrl(pathname) {
  return new URL(`http://${DAEMON_HOST}:${DAEMON_PORT}${pathname}`);
}

export async function daemonRequest(
  pathname,
  { method = 'GET', root, body } = {},
) {
  const authCookie = await readAuthCookie(root);
  const response = await fetch(buildUrl(pathname), {
    method,
    headers: {
      Authorization: authCookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    let message;
    try {
      const json = JSON.parse(text);
      message = json.error ?? text;
    } catch {
      message = text;
    }
    throw new Error(
      message || `Daemon request failed with status ${response.status}`,
    );
  }

  return response.json();
}

export function getDaemonStatus(root) {
  return daemonRequest('/status', { root });
}

export function stopDaemon(root) {
  return daemonRequest('/daemon/stop', { method: 'POST', root });
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

export function sweepPrepare(root) {
  return daemonRequest('/sweep/prepare', { method: 'POST', root });
}

export function sweepConfirm(destination, confirmPhrase, root) {
  return daemonRequest('/sweep/confirm', {
    method: 'POST',
    root,
    body: { destination, confirmPhrase },
  });
}
