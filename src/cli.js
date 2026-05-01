#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bootstrapAppData,
  getAppDataRoot,
  getLayout,
  readStatus,
} from './app-data.js';
import { getDaemonStatus, stopDaemon } from './daemon-client.js';
import {
  CLI_NAME,
  DAEMON_HOST,
  DAEMON_PORT,
  STATIC_WALLET_PASSWORD,
} from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function printHelp() {
  process.stdout.write(
    `Usage:\n  ${CLI_NAME}\n  ${CLI_NAME} start\n  ${CLI_NAME} stop\n  ${CLI_NAME} import\n  ${CLI_NAME} remove\n  ${CLI_NAME} status\n  ${CLI_NAME} sweep <address>\n`
  );
}

function printTuiPlaceholder() {
  process.stdout.write(
    `${CLI_NAME} TUI not implemented yet. Use \`${CLI_NAME} start\` to initialize local state.\n`
  );
}

async function handleStart() {
  const root = getAppDataRoot();
  const layout = await bootstrapAppData(root);

  try {
    const status = await getDaemonStatus(root);
    process.stdout.write(
      `Daemon already running with pid ${status.daemon.pid}.\n`
    );
    process.stdout.write(`App data: ${layout.root}\n`);
    return;
  } catch {
    // Daemon not running yet.
  }

  const logFd = fs.openSync(layout.daemonLogFile, 'a');
  const daemon = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true,
    env: {
      ...process.env,
      NTR_APP_DATA: root,
    },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  const ready = await waitForDaemonReady(daemon, root);

  if (!ready.ok) {
    process.stderr.write(`${ready.message}\n`);
    process.exitCode = 1;
    return;
  }

  daemon.unref();

  process.stdout.write(`Started ${CLI_NAME} daemon.\n`);
  process.stdout.write(`App data: ${layout.root}\n`);
  process.stdout.write(`Daemon API: http://${DAEMON_HOST}:${DAEMON_PORT}\n`);
  process.stdout.write(`Auth cookie: ${layout.authCookieFile}\n`);
  process.stdout.write(`Static wallet password: ${STATIC_WALLET_PASSWORD}\n`);
}

async function handleStatus() {
  try {
    const status = await getDaemonStatus(getAppDataRoot());
    process.stdout.write(`Daemon status: ${status.daemon.status}\n`);
    process.stdout.write(
      `Daemon API: http://${status.daemon.host}:${status.daemon.port}\n`
    );
    process.stdout.write(`App data: ${status.appData}\n`);
    process.stdout.write(`Imported sources: ${status.sourceCount}\n`);
  } catch {
    process.stderr.write(
      `No running daemon found. Run \`${CLI_NAME} start\` first.\n`
    );
    process.exitCode = 1;
  }
}

async function handleStop() {
  try {
    await stopDaemon(getAppDataRoot());
    process.stdout.write(`Stopped ${CLI_NAME} daemon.\n`);
  } catch {
    process.stderr.write('No running daemon found.\n');
    process.exitCode = 1;
  }
}

async function waitForDaemonReady(daemon, root) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    daemon.on('exit', async (code) => {
      try {
        const status = await readStatus(root);
        finish({
          ok: false,
          message:
            status.daemon.error || `Daemon exited early with code ${code}.`,
        });
      } catch {
        finish({
          ok: false,
          message: `Daemon exited early with code ${code}.`,
        });
      }
    });

    const start = Date.now();
    const poll = async () => {
      try {
        await getDaemonStatus(root);
        finish({ ok: true });
      } catch {
        if (Date.now() - start >= 3000) {
          const daemonStatePath = getLayout(root).daemonFile;
          finish({
            ok: false,
            message: `Daemon did not become ready in time. Check ${daemonStatePath} and daemon log.`,
          });
          return;
        }

        timer = setTimeout(poll, 100);
      }
    };

    timer = setTimeout(poll, 100);
  });
}

function printCommandPlaceholder(command) {
  process.stdout.write(`${CLI_NAME} ${command} not implemented yet.\n`);
}

async function main(argv) {
  const [command] = argv;

  switch (command) {
    case undefined:
      printTuiPlaceholder();
      return;
    case 'start':
      await handleStart();
      return;
    case 'status':
      await handleStatus();
      return;
    case 'stop':
      await handleStop();
      return;
    case 'import':
    case 'remove':
    case 'sweep':
      printCommandPlaceholder(command);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
