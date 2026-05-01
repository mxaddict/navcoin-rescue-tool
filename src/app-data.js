import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  APP_NAME,
  DAEMON_HOST,
  DAEMON_PORT,
  FILE_LAYOUT,
} from './constants.js';

export function getAppDataRoot(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (!appData) throw new Error('APPDATA is required on Windows');
    return path.join(appData, APP_NAME);
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }

  const dataHome =
    env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, APP_NAME);
}

export function getLayout(root = getAppDataRoot()) {
  return {
    root,
    daemonFile: path.join(root, FILE_LAYOUT.daemon),
    authCookieFile: path.join(root, FILE_LAYOUT.authCookie),
    sourcesFile: path.join(root, FILE_LAYOUT.sources),
    walletsDir: path.join(root, FILE_LAYOUT.walletsDir),
    logsDir: path.join(root, FILE_LAYOUT.logsDir),
    daemonLogFile: path.join(root, FILE_LAYOUT.daemonLog),
  };
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(filePath, content, mode) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, mode ? { mode } : undefined);
  }
}

export async function bootstrapAppData(root = getAppDataRoot()) {
  const layout = getLayout(root);
  const now = new Date().toISOString();

  await fs.mkdir(layout.walletsDir, { recursive: true });
  await fs.mkdir(layout.logsDir, { recursive: true });

  await ensureFile(
    layout.daemonFile,
    JSON.stringify(
      {
        host: DAEMON_HOST,
        port: DAEMON_PORT,
        createdAt: now,
        updatedAt: now,
        status: 'initialized',
      },
      null,
      2
    ) + '\n'
  );

  await ensureFile(
    layout.sourcesFile,
    JSON.stringify({ sources: [] }, null, 2) + '\n'
  );
  await ensureAuthCookie(root);
  await ensureFile(layout.daemonLogFile, '');

  return layout;
}

export async function ensureAuthCookie(root = getAppDataRoot()) {
  const layout = getLayout(root);

  if (!(await pathExists(layout.authCookieFile))) {
    const authCookie = crypto.randomBytes(24).toString('hex');
    await fs.writeFile(layout.authCookieFile, `${authCookie}\n`, {
      mode: 0o600,
    });
  }

  return readAuthCookie(root);
}

export async function readAuthCookie(root = getAppDataRoot()) {
  const layout = getLayout(root);
  const cookie = await fs.readFile(layout.authCookieFile, 'utf8');
  return cookie.trim();
}

export async function writeDaemonState(partialState, root = getAppDataRoot()) {
  const layout = getLayout(root);
  const current = (await pathExists(layout.daemonFile))
    ? JSON.parse(await fs.readFile(layout.daemonFile, 'utf8'))
    : {
        host: DAEMON_HOST,
        port: DAEMON_PORT,
        createdAt: new Date().toISOString(),
      };

  const nextState = {
    ...current,
    ...partialState,
    updatedAt: new Date().toISOString(),
  };

  await fs.writeFile(
    layout.daemonFile,
    `${JSON.stringify(nextState, null, 2)}\n`
  );
  return nextState;
}

export async function readStatus(root = getAppDataRoot()) {
  const layout = getLayout(root);
  const [daemonRaw, sourcesRaw] = await Promise.all([
    fs.readFile(layout.daemonFile, 'utf8'),
    fs.readFile(layout.sourcesFile, 'utf8'),
  ]);

  return {
    layout,
    daemon: JSON.parse(daemonRaw),
    sources: JSON.parse(sourcesRaw),
  };
}
