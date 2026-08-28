// Thin daemon HTTP client for the GUI. Mirrors src/daemon-client.js but
// runs in the webview, so it asks the Tauri side for the auth cookie and
// daemon address rather than reading the cookie file directly.
import { invoke } from '@tauri-apps/api/core';

// Always re-read the auth cookie on each call. The daemon rewrites
// auth.cookie on every start (e.g. after a purge-triggered shutdown
// + auto-respawn), so caching the value risks stale auth across that
// transition. The cookie read is a local file open; cheap enough.
async function getAuth() {
  return await invoke('daemon_auth');
}

async function ensureDaemon() {
  await invoke('ensure_daemon');
}

async function daemonRequest(path, init = {}) {
  await ensureDaemon();
  const { url, cookie } = await getAuth();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: cookie,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    credentials: 'include',
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.error ?? body ?? `status ${res.status}`;
    const error = new Error(
      typeof msg === 'string' ? msg : JSON.stringify(msg),
    );
    // Carry the daemon's classification through so the view can branch on
    // it rather than matching on message text.
    if (body?.code) error.code = body.code;
    if (body?.waivable === true) error.waivable = true;
    throw error;
  }
  return body;
}

export async function fetchDaemonStatus() {
  return await daemonRequest('/status');
}

export async function importSource(payload) {
  return await daemonRequest('/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function purgeDaemon() {
  return await daemonRequest('/purge', { method: 'POST' });
}

export async function removeSource(sourceId) {
  return await daemonRequest('/remove', {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  });
}

export async function rescanDaemon() {
  return await daemonRequest('/rescan', { method: 'POST' });
}

export async function sweepPrepare({ force = false } = {}) {
  return await daemonRequest('/sweep/prepare', {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

export async function sweepConfirm({
  destination,
  confirmPhrase,
  force = false,
}) {
  return await daemonRequest('/sweep/confirm', {
    method: 'POST',
    body: JSON.stringify({ destination, confirmPhrase, force }),
  });
}
