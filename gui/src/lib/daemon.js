// Thin daemon HTTP client for the GUI. Mirrors src/daemon-client.js but
// runs in the webview, so it asks the Tauri side for the auth cookie and
// daemon address rather than reading the cookie file directly.
import { invoke } from '@tauri-apps/api/core';

let cachedAuth = null;

async function getAuth() {
  if (cachedAuth) return cachedAuth;
  cachedAuth = await invoke('daemon_auth');
  return cachedAuth;
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
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
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
