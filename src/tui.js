import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  getAppDataRoot,
  bootstrapAppData,
  getLayout,
  readStatus,
} from './app-data.js';
import {
  getDaemonStatus,
  importDaemonSource,
  removeDaemonSource,
  sweepPrepare,
  sweepConfirm,
} from './daemon-client.js';
import {
  CLI_NAME,
  DAEMON_HOST,
  DAEMON_PORT,
  SUPPORTED_MNEMONIC_WALLET_TYPES,
} from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// blessed is CJS only
const blessed = require('blessed');

// chalk is ESM
const { default: chalk } = await import('chalk');

// ---------------------------------------------------------------------------
// Navio brand palette (terminal-safe approximations via chalk hex)
// ---------------------------------------------------------------------------
const C = {
  magenta: (s) => chalk.hex('#ec1ec6')(s),
  blue: (s) => chalk.hex('#1d8ff9')(s),
  fuchsia: (s) => chalk.hex('#d946ef')(s),
  cyan: (s) => chalk.hex('#06b6d4')(s),
  teal: (s) => chalk.hex('#0f766e')(s),
  pink: (s) => chalk.hex('#be185d')(s),
  indigo: (s) => chalk.hex('#6366f1')(s),
  muted: (s) => chalk.gray(s),
  bold: (s) => chalk.bold(s),
  boldMagenta: (s) => chalk.bold.hex('#ec1ec6')(s),
  boldCyan: (s) => chalk.bold.hex('#06b6d4')(s),
  gradient: (s) => chalk.bold.hex('#d946ef')(s), // fuchsia for headings
};

// ---------------------------------------------------------------------------
// Commands and tab-completion
// ---------------------------------------------------------------------------
const COMMANDS = [
  'status',
  'import mnemonic',
  'import private-key',
  'remove',
  'sweep',
  'help',
  'quit',
];

function tabComplete(partial) {
  if (!partial) return null;
  const match = COMMANDS.find((c) => c.startsWith(partial));
  return match ?? null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function navStr(satoshis) {
  return (satoshis / 1e8).toFixed(8);
}

function renderHelp() {
  return [
    C.gradient('  navcoin-rescue-tool TUI'),
    '',
    C.bold('Commands:'),
    `  ${C.cyan('status')}                      Show daemon and source status`,
    `  ${C.cyan('import mnemonic')}             Import a mnemonic source`,
    `  ${C.cyan('import private-key')}          Import a private key source`,
    `  ${C.cyan('remove')}                      Remove an imported source`,
    `  ${C.cyan('sweep')}                       Sweep all funds to a destination`,
    `  ${C.cyan('help')}                        Show this help`,
    `  ${C.cyan('quit')}                        Exit the TUI`,
    '',
    C.muted('  Use Tab to auto-complete commands.'),
    C.muted('  Press Ctrl+C or type quit to exit.'),
  ].join('\n');
}

function renderStatus(data) {
  const lines = [];
  const d = data.daemon;
  const statusColor = d.status === 'running' ? C.teal : C.pink;

  lines.push(C.gradient('  Daemon Status'));
  lines.push(
    `  ${C.bold('Status:')}   ${statusColor(d.status)}   ${C.muted(`pid=${d.pid ?? 'none'}`)}`,
  );
  lines.push(
    `  ${C.bold('API:')}      ${C.muted(`http://${d.host}:${d.port}`)}`,
  );
  lines.push(`  ${C.bold('App data:')} ${C.muted(data.appData)}`);
  lines.push(`  ${C.bold('Sources:')}  ${data.sourceCount}`);

  if (data.sources.length === 0) {
    lines.push('');
    lines.push(
      C.muted(
        '  No sources imported. Use `import mnemonic` or `import private-key`.',
      ),
    );
    return lines.join('\n');
  }

  let totalNav = 0;
  let totalStaked = 0;

  for (const src of data.sources) {
    lines.push('');
    const typeLabel = src.walletType
      ? `${src.type}:${src.walletType}`
      : src.type;
    lines.push(`  ${C.boldMagenta('Source')} ${C.muted(src.id)}`);
    lines.push(
      `  ${C.bold('Label:')}  ${src.label}   ${C.muted(`[${typeLabel}]`)}`,
    );

    const syncColor =
      src.syncStatus === 'synced'
        ? C.teal
        : src.syncStatus === 'syncing'
          ? C.blue
          : src.syncStatus === 'error' || src.syncStatus === 'no-servers'
            ? C.pink
            : C.muted;

    const syncLabel =
      src.syncStatus === 'syncing'
        ? `syncing (${src.syncProgress}%)`
        : src.syncStatus;

    const serverLabel = src.server ? C.muted(` via ${src.server}`) : '';
    lines.push(`  ${C.bold('Sync:')}   ${syncColor(syncLabel)}${serverLabel}`);

    if (src.liveError) {
      lines.push(`  ${C.pink('Error:')}  ${src.liveError}`);
    }

    const navConf = navStr(src.balance.nav.confirmed);
    const navPend = navStr(src.balance.nav.pending);
    const staked = navStr(src.balance.staked.confirmed);
    lines.push(
      `  ${C.bold('Balance:')} ${C.cyan(navConf)} NAV confirmed  ` +
        `${C.muted(navPend + ' NAV pending')}  ` +
        `${C.indigo(staked)} NAV staked`,
    );

    totalNav += src.balance.nav.confirmed;
    totalStaked += src.balance.staked.confirmed;

    if (src.addresses.length > 0) {
      lines.push(`  ${C.bold('Addresses')} (${src.addresses.length}):`);
      for (const addr of src.addresses) {
        const usedLabel = addr.used ? C.muted(' [used]') : '';
        lines.push(`    ${C.magenta(addr.address)}${usedLabel}`);
      }
    }
  }

  lines.push('');
  lines.push(C.gradient('  Totals'));
  lines.push(
    `  ${C.bold('NAV:')}    ${C.cyan(navStr(totalNav))} NAV confirmed`,
  );
  lines.push(
    `  ${C.bold('Staked:')} ${C.indigo(navStr(totalStaked))} NAV staked`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Daemon auto-start
// ---------------------------------------------------------------------------
async function ensureDaemonRunning(root, layout, log) {
  try {
    await getDaemonStatus(root);
    return true;
  } catch {
    // Not running — start it.
  }

  log(C.muted('  Starting daemon...'));

  const logFd = fs.openSync(layout.daemonLogFile, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true,
    env: { ...process.env, NTR_APP_DATA: root },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  // Wait up to 5s for daemon to be ready.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await getDaemonStatus(root);
      child.unref();
      return true;
    } catch {
      // keep waiting
    }
  }

  child.kill();
  return false;
}

// ---------------------------------------------------------------------------
// Prompt helpers — multi-step interactive flows inside the TUI
// ---------------------------------------------------------------------------
function tuiPrompt(inputBox, question) {
  return new Promise((resolve) => {
    inputBox.setValue(question + ' ');
    inputBox.once('submit', (val) => {
      const answer = val.slice(question.length + 1).trim();
      inputBox.setValue('');
      resolve(answer);
    });
    inputBox.readInput();
  });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function cmdStatus(root, log) {
  log(C.muted('  Fetching status...'));
  try {
    const data = await getDaemonStatus(root);
    log(renderStatus(data));
  } catch {
    log(C.pink('  Daemon not reachable. Run `ntr start` or restart the TUI.'));
  }
}

async function cmdImportMnemonic(root, log, ask) {
  const walletType = await ask(
    `Wallet type (${SUPPORTED_MNEMONIC_WALLET_TYPES.join('/')}): `,
  );
  if (!SUPPORTED_MNEMONIC_WALLET_TYPES.includes(walletType)) {
    log(C.pink(`  Unknown wallet type: ${walletType}`));
    return;
  }
  const label = await ask('Label: ');
  const phrase = await ask('Mnemonic phrase: ');

  log(C.muted('  Importing...'));
  try {
    const result = await importDaemonSource(
      { type: 'mnemonic', walletType, label, phrase },
      root,
    );
    log(C.teal(`  Imported: ${result.source.id}`));
    log(
      `  Label: ${result.source.label}   Wallet type: ${result.source.walletType}`,
    );
    log(C.muted('  Wallet DB will sync in the background.'));
  } catch (error) {
    log(C.pink(`  Import failed: ${error.message}`));
  }
}

async function cmdImportPrivateKey(root, log, ask) {
  const label = await ask('Label: ');
  const key = await ask('WIF private key: ');

  log(C.muted('  Importing...'));
  try {
    const result = await importDaemonSource(
      { type: 'private-key', label, keys: [key] },
      root,
    );
    log(C.teal(`  Imported: ${result.source.id}`));
    log(`  Label: ${result.source.label}`);
    log(C.muted('  Wallet DB will sync in the background.'));
  } catch (error) {
    log(C.pink(`  Import failed: ${error.message}`));
  }
}

async function cmdRemove(root, log, ask) {
  const sourceId = await ask('Source ID to remove: ');
  const confirm = await ask(`Type YES to confirm removal of ${sourceId}: `);
  if (confirm !== 'YES') {
    log(C.muted('  Removal cancelled.'));
    return;
  }
  try {
    await removeDaemonSource(sourceId, root);
    log(C.teal(`  Removed: ${sourceId}`));
  } catch (error) {
    log(C.pink(`  Remove failed: ${error.message}`));
  }
}

async function cmdSweep(root, log, ask) {
  log(C.muted('  Checking sync state...'));

  let preview;
  try {
    const response = await sweepPrepare(root);
    preview = response.preview;
  } catch (error) {
    log(C.pink(`  Sweep blocked: ${error.message}`));
    return;
  }

  log('');
  log(C.gradient('  Sweep Preview'));
  log(
    `  Total NAV: ${C.cyan(navStr(preview.totalNav))} NAV (confirmed, before fee)`,
  );
  log('  Sources:');
  for (const src of preview.sources) {
    log(`    ${C.muted(src.sourceId)}  ${C.cyan(navStr(src.nav))} NAV`);
  }

  const destination = await ask('Destination address: ');
  if (!destination) {
    log(C.muted('  Sweep cancelled.'));
    return;
  }

  const reenter = await ask('Re-enter destination address: ');
  if (reenter !== destination) {
    log(C.pink('  Destination mismatch. Sweep aborted.'));
    return;
  }

  log('');
  log(C.pink('  !! This will broadcast a transaction and cannot be undone !!'));
  const phrase = await ask('Type SEND MY COINS to confirm: ');
  if (phrase !== 'SEND MY COINS') {
    log(C.muted('  Confirmation phrase incorrect. Sweep aborted.'));
    return;
  }

  log(C.muted('  Broadcasting...'));
  try {
    const response = await sweepConfirm(destination, 'SEND MY COINS', root);
    const result = response.result;
    log(C.teal('  Sweep broadcast successfully.'));
    log(
      `  Sent: ${C.cyan(navStr(result.totalSent))} NAV   Fee: ${C.muted(navStr(result.totalFee) + ' NAV')}`,
    );
    if (result.hashes?.length) {
      log('  Tx hashes:');
      for (const h of result.hashes) log(`    ${C.magenta(h)}`);
    }
  } catch (error) {
    log(C.pink(`  Sweep failed: ${error.message}`));
  }
}

// ---------------------------------------------------------------------------
// Main TUI entry point
// ---------------------------------------------------------------------------
export async function launchTui() {
  const root = getAppDataRoot();
  const layout = getLayout(root);
  await bootstrapAppData(root);

  const screen = blessed.screen({
    smartCSR: true,
    title: 'navcoin-rescue-tool',
  });

  // ---- Header bar --------------------------------------------------------
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content:
      C.boldMagenta(' navcoin-rescue-tool ') +
      C.muted('| type help for commands | Tab to complete | Ctrl+C to quit'),
    tags: false,
  });

  // ---- Main output box ---------------------------------------------------
  const output = blessed.log({
    top: 1,
    left: 0,
    width: '100%',
    height: '100%-3',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
      style: { bg: 'gray' },
    },
    tags: false,
    wrap: true,
  });

  // ---- Input box ---------------------------------------------------------
  const inputBox = blessed.textbox({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  // ---- Prompt line (above input) -----------------------------------------
  const promptLine = blessed.box({
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: C.magenta(' > '),
    tags: false,
  });

  screen.append(header);
  screen.append(output);
  screen.append(promptLine);
  screen.append(inputBox);

  // ---- Helpers -----------------------------------------------------------
  function log(text) {
    output.log(text);
    screen.render();
  }

  // Multi-step ask: temporarily hands input control to a one-shot question.
  function ask(question) {
    return new Promise((resolve) => {
      promptLine.setContent(C.cyan(' ? ') + question);
      screen.render();
      inputBox.setValue('');
      inputBox.focus();
      inputBox.once('submit', (val) => {
        promptLine.setContent(C.magenta(' > '));
        inputBox.setValue('');
        screen.render();
        resolve(val.trim());
      });
    });
  }

  // ---- Input handling ----------------------------------------------------
  let inputBuffer = '';
  let awaitingSubmit = false;

  function resetInput() {
    inputBuffer = '';
    inputBox.setValue('');
    screen.render();
  }

  async function dispatch(raw) {
    const cmd = raw.trim();
    if (!cmd) return;

    log(C.muted(`\n  $ ${cmd}`));

    if (cmd === 'quit' || cmd === 'exit') {
      screen.destroy();
      process.exit(0);
    } else if (cmd === 'help') {
      log(renderHelp());
    } else if (cmd === 'status') {
      await cmdStatus(root, log);
    } else if (cmd === 'import mnemonic') {
      await cmdImportMnemonic(root, log, ask);
    } else if (cmd === 'import private-key') {
      await cmdImportPrivateKey(root, log, ask);
    } else if (cmd === 'remove') {
      await cmdRemove(root, log, ask);
    } else if (cmd === 'sweep') {
      await cmdSweep(root, log, ask);
    } else {
      log(C.pink(`  Unknown command: ${cmd}`));
      log(C.muted('  Type help for available commands.'));
    }
  }

  // Tab completion on the raw textbox value.
  inputBox.key('tab', () => {
    const current = inputBox.getValue();
    const completed = tabComplete(current);
    if (completed) {
      inputBox.setValue(completed);
      screen.render();
    }
  });

  inputBox.on('submit', async (val) => {
    if (awaitingSubmit) return; // let ask() handle it
    resetInput();
    awaitingSubmit = true;
    try {
      await dispatch(val);
    } finally {
      awaitingSubmit = false;
      inputBox.focus();
    }
  });

  // Ctrl+C to quit.
  screen.key(['C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  // Enter key submits.
  inputBox.key('enter', () => {
    inputBox.emit('submit', inputBox.getValue());
  });

  // ---- Auto-start daemon -------------------------------------------------
  log(
    C.gradient('  navcoin-rescue-tool') +
      C.muted('  —  recovery tool for legacy NavCoin wallets'),
  );
  log('');

  const running = await ensureDaemonRunning(root, layout, log);

  if (running) {
    log(
      C.teal('  Daemon ready.') +
        C.muted(`  http://${DAEMON_HOST}:${DAEMON_PORT}`),
    );
    log('');
    await cmdStatus(root, log);
  } else {
    log(
      C.pink('  Failed to start daemon. Check logs at: ') +
        C.muted(layout.daemonLogFile),
    );
  }

  log('');
  log(C.muted('  Type a command below. Tab to complete.'));

  // ---- Periodic status refresh every 5s ----------------------------------
  const refreshTimer = setInterval(async () => {
    try {
      const data = await getDaemonStatus(root);
      const syncing = data.sources.some(
        (s) => s.syncStatus === 'syncing' || s.syncStatus === 'connecting',
      );
      if (syncing) {
        const progress = data.sources
          .filter((s) => s.syncStatus === 'syncing')
          .map((s) => `${s.label}: ${s.syncProgress}%`)
          .join('  ');
        // Update header with sync progress.
        header.setContent(
          C.boldMagenta(' navcoin-rescue-tool ') +
            C.blue(`syncing: ${progress}`) +
            C.muted(' | Tab to complete | Ctrl+C to quit'),
        );
      } else {
        header.setContent(
          C.boldMagenta(' navcoin-rescue-tool ') +
            C.muted(
              '| type help for commands | Tab to complete | Ctrl+C to quit',
            ),
        );
      }
      screen.render();
    } catch {
      // Daemon went away.
      header.setContent(
        C.boldMagenta(' navcoin-rescue-tool ') +
          C.pink('daemon offline') +
          C.muted(' | Ctrl+C to quit'),
      );
      screen.render();
    }
  }, 5000);

  screen.on('destroy', () => {
    clearInterval(refreshTimer);
  });

  inputBox.focus();
  screen.render();
}
