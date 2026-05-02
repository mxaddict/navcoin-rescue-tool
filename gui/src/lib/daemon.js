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

export async function fetchDaemonStatus() {
  await ensureDaemon();
  const { url, cookie } = await getAuth();
  const res = await fetch(`${url}/status`, {
    headers: { Authorization: cookie },
  });
  if (!res.ok) {
    throw new Error(`status ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}
