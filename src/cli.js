#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline';
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
import {
  getDaemonStatus,
  importDaemonSource,
  removeDaemonSource,
  stopDaemon,
  sweepPrepare,
  sweepConfirm,
} from './daemon-client.js';
import { SUPPORTED_MNEMONIC_WALLET_TYPES } from './constants.js';
import {
  CLI_NAME,
  DAEMON_HOST,
  DAEMON_PORT,
  STATIC_WALLET_PASSWORD,
} from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Return true when an error looks like the daemon is not reachable.
 * fetch throws a TypeError with cause ECONNREFUSED when nothing is listening.
 */
function isDaemonUnreachable(error) {
  return (
    error?.cause?.code === 'ECONNREFUSED' ||
    error?.message?.includes('ECONNREFUSED') ||
    error?.message?.includes('fetch failed')
  );
}

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }

  throw error;
});

function printHelp() {
  process.stdout.write(
    `Usage:\n  ${CLI_NAME}\n  ${CLI_NAME} start\n  ${CLI_NAME} stop\n  ${CLI_NAME} import mnemonic --wallet-type <type> --label <label> --phrase <words>\n  ${CLI_NAME} import private-key --label <label> --key <wif> [--key <wif>]\n  ${CLI_NAME} remove <source-id>\n  ${CLI_NAME} status\n  ${CLI_NAME} sweep <address>\n`,
  );
}

function printTuiPlaceholder() {
  process.stdout.write(
    `${CLI_NAME} TUI not implemented yet. Use \`${CLI_NAME} start\` to initialize local state.\n`,
  );
}

async function handleStart() {
  const root = getAppDataRoot();
  const layout = await bootstrapAppData(root);

  try {
    const status = await getDaemonStatus(root);
    process.stdout.write(
      `Daemon already running with pid ${status.daemon.pid}.\n`,
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
      `Daemon API: http://${status.daemon.host}:${status.daemon.port}\n`,
    );
    process.stdout.write(`App data: ${status.appData}\n`);
    process.stdout.write(`Imported sources: ${status.sourceCount}\n`);

    for (const source of status.sources) {
      const typeLabel = source.walletType
        ? `${source.type}:${source.walletType}`
        : source.type;
      const syncLabel =
        source.syncStatus === 'syncing'
          ? `syncing(${source.syncProgress}%)`
          : source.syncStatus;
      const serverLabel = source.server ? ` server=${source.server}` : '';

      process.stdout.write(`\nSource: ${source.id} [${typeLabel}]\n`);
      process.stdout.write(`  Label:  ${source.label}\n`);
      process.stdout.write(
        `  Status: ${source.status}  Sync: ${syncLabel}${serverLabel}\n`,
      );

      if (source.liveError) {
        process.stdout.write(`  Error:  ${source.liveError}\n`);
      }

      const navConfirmed = (source.balance.nav.confirmed / 1e8).toFixed(8);
      const navPending = (source.balance.nav.pending / 1e8).toFixed(8);
      const staked = (source.balance.staked.confirmed / 1e8).toFixed(8);
      process.stdout.write(
        `  Balance: ${navConfirmed} NAV confirmed  ${navPending} NAV pending  ${staked} NAV staked\n`,
      );

      if (source.addresses.length > 0) {
        process.stdout.write(`  Addresses (${source.addresses.length}):\n`);
        for (const addr of source.addresses) {
          const usedLabel = addr.used ? ' [used]' : '';
          process.stdout.write(`    ${addr.address}${usedLabel}\n`);
        }
      }
    }
  } catch {
    process.stderr.write(
      `No running daemon found. Run \`${CLI_NAME} start\` first.\n`,
    );
    process.exitCode = 1;
  }
}

function parseOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    if (options[key] === undefined) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }

    index += 1;
  }

  return options;
}

async function handleImport(argv) {
  const [sourceType, ...rest] = argv;
  const options = parseOptions(rest);
  const root = getAppDataRoot();

  try {
    let result;

    if (sourceType === 'mnemonic') {
      result = await importDaemonSource(
        {
          type: 'mnemonic',
          walletType: options['wallet-type'],
          label: options.label,
          phrase: options.phrase,
        },
        root,
      );
    } else if (sourceType === 'private-key') {
      const keys = options.key
        ? Array.isArray(options.key)
          ? options.key
          : [options.key]
        : [];
      result = await importDaemonSource(
        {
          type: 'private-key',
          label: options.label,
          keys,
        },
        root,
      );
    } else {
      throw new Error(
        `Unsupported import type: ${sourceType}. Use mnemonic or private-key.`,
      );
    }

    process.stdout.write(`Imported source: ${result.source.id}\n`);
    process.stdout.write(`Label: ${result.source.label}\n`);
    if (result.source.walletType) {
      process.stdout.write(`Wallet type: ${result.source.walletType}\n`);
    }
    if (result.source.wallet) {
      process.stdout.write(
        `Wallet database: ${result.source.wallet.databaseName}\n`,
      );
      process.stdout.write(`Wallet file: ${result.source.wallet.dataFile}\n`);
    }
    process.stdout.write(`Status: ${result.source.status}\n`);
    process.stdout.write(`Sync: ${result.source.syncStatus}\n`);
  } catch (error) {
    if (isDaemonUnreachable(error)) {
      process.stderr.write(
        `No running daemon found. Run \`${CLI_NAME} start\` first.\n`,
      );
    } else {
      process.stderr.write(`${error.message}\n`);
      if (sourceType === 'mnemonic') {
        process.stderr.write(
          `Supported wallet types: ${SUPPORTED_MNEMONIC_WALLET_TYPES.join(', ')}\n`,
        );
      }
    }
    process.exitCode = 1;
  }
}

async function handleRemove(argv) {
  const [sourceId] = argv;

  if (!sourceId) {
    process.stderr.write('Source id is required.\n');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await removeDaemonSource(sourceId, getAppDataRoot());
    process.stdout.write(`Removed source: ${result.removedSourceId}\n`);
  } catch (error) {
    if (isDaemonUnreachable(error)) {
      process.stderr.write(
        `No running daemon found. Run \`${CLI_NAME} start\` first.\n`,
      );
    } else {
      process.stderr.write(`${error.message}\n`);
    }
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

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function handleSweep(argv) {
  const [destination] = argv;

  if (!destination) {
    process.stderr.write('Usage: ntr sweep <destination-address>\n');
    process.exitCode = 1;
    return;
  }

  const root = getAppDataRoot();

  // Step 1: call prepare — validates all sources are synced, returns preview.
  let preview;

  try {
    const response = await sweepPrepare(root);
    preview = response.preview;
  } catch (error) {
    if (isDaemonUnreachable(error)) {
      process.stderr.write(
        `No running daemon found. Run \`${CLI_NAME} start\` first.\n`,
      );
    } else {
      process.stderr.write(`Sweep blocked: ${error.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const totalNav = (preview.totalNav / 1e8).toFixed(8);

  process.stdout.write(`\nSweep preview\n`);
  process.stdout.write(`  Destination : ${destination}\n`);
  process.stdout.write(
    `  Total NAV   : ${totalNav} NAV (confirmed, before fee)\n`,
  );
  process.stdout.write(`\nSources:\n`);

  for (const src of preview.sources) {
    process.stdout.write(
      `  ${src.sourceId}  ${(src.nav / 1e8).toFixed(8)} NAV\n`,
    );
  }

  // Step 2: re-enter destination.
  const reenter = await prompt(
    '\nRe-enter the destination address to confirm:\n> ',
  );

  if (reenter.trim() !== destination) {
    process.stderr.write('Destination mismatch. Sweep aborted.\n');
    process.exitCode = 1;
    return;
  }

  // Step 3: require SEND MY COINS.
  process.stdout.write('\nType SEND MY COINS to broadcast the sweep:\n');
  const phrase = await prompt('> ');

  if (phrase.trim() !== 'SEND MY COINS') {
    process.stderr.write('Confirmation phrase incorrect. Sweep aborted.\n');
    process.exitCode = 1;
    return;
  }

  // Step 4: execute.
  try {
    const response = await sweepConfirm(destination, 'SEND MY COINS', root);
    const result = response.result;

    process.stdout.write('\nSweep broadcast successfully.\n');
    process.stdout.write(
      `  Total sent : ${(result.totalSent / 1e8).toFixed(8)} NAV\n`,
    );
    process.stdout.write(
      `  Total fee  : ${(result.totalFee / 1e8).toFixed(8)} NAV\n`,
    );

    if (result.hashes && result.hashes.length > 0) {
      process.stdout.write('  Tx hashes:\n');

      for (const hash of result.hashes) {
        process.stdout.write(`    ${hash}\n`);
      }
    }
  } catch (error) {
    if (isDaemonUnreachable(error)) {
      process.stderr.write(
        `No running daemon found. Run \`${CLI_NAME} start\` first.\n`,
      );
    } else {
      process.stderr.write(`Sweep failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}

async function main(argv) {
  const [command, ...rest] = argv;

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
      await handleImport(rest);
      return;
    case 'remove':
      await handleRemove(rest);
      return;
    case 'sweep':
      await handleSweep(rest);
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
