import { readAuthCookie } from './app-data.js';
import { DAEMON_HOST, DAEMON_PORT } from './constants.js';

function buildUrl(pathname) {
  return new URL(`http://${DAEMON_HOST}:${DAEMON_PORT}${pathname}`);
}

export async function daemonRequest(
  pathname,
  { method = 'GET', root, body } = {}
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
    throw new Error(
      text || `Daemon request failed with status ${response.status}`
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
