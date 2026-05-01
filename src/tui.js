import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { getAppDataRoot, bootstrapAppData, getLayout } from './app-data.js';
import {
  getDaemonStatus,
  importDaemonSource,
  removeDaemonSource,
  sweepPrepare,
  sweepConfirm,
} from './daemon-client.js';
import {
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
// Terminal background detection
// ---------------------------------------------------------------------------

/**
 * Query the terminal background color via OSC 11.
 * Returns { r, g, b } (0-255) or null if unsupported/timeout.
 * Must be called before blessed takes over stdin/stdout.
 */
async function queryTerminalBg() {
  // Only attempt on TTY with a writable stdout.
  if (!process.stdout.isTTY || !process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 200);

    let buf = '';

    function onData(chunk) {
      buf += chunk.toString();
      // OSC 11 response: ESC ] 11 ; rgb:rrrr/gggg/bbbb BEL  or ST
      const match = buf.match(
        /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x07|\x1b\\)/i,
      );
      if (match) {
        cleanup();
        // Values are 16-bit (0-65535) — scale to 8-bit.
        resolve({
          r: Math.round(parseInt(match[1], 16) / 257),
          g: Math.round(parseInt(match[2], 16) / 257),
          b: Math.round(parseInt(match[3], 16) / 257),
        });
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
      process.stdin.pause();
    }

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
      // Send OSC 11 query.
      process.stdout.write('\x1b]11;?\x07');
    } catch {
      cleanup();
      resolve(null);
    }
  });
}

/**
 * Returns true if the given RGB color is perceptually dark
 * (relative luminance < 0.5).
 */
function isColorDark({ r, g, b }) {
  // sRGB relative luminance (WCAG formula).
  const toLinear = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L < 0.5;
}

// ---------------------------------------------------------------------------
// Navio brand palettes — dark and light terminal variants
// ---------------------------------------------------------------------------

/**
 * Build a chalk-based color helper set tuned for the detected background.
 * All colors sourced from the Navio brand palette (nav.io).
 */
function buildPalette(dark) {
  if (dark) {
    // Dark terminal — use bright/saturated Navio colors.
    return {
      magenta: (s) => chalk.hex('#ec1ec6')(s),
      blue: (s) => chalk.hex('#1d8ff9')(s),
      cyan: (s) => chalk.hex('#06b6d4')(s),
      teal: (s) => chalk.hex('#2dd4bf')(s), // teal-400 — brighter for dark bg
      pink: (s) => chalk.hex('#f472b6')(s), // pink-400 — brighter for dark bg
      indigo: (s) => chalk.hex('#818cf8')(s), // indigo-400 — brighter for dark bg
      muted: (s) => chalk.hex('#9ca3af')(s), // gray-400
      bold: (s) => chalk.bold(s),
      boldMagenta: (s) => chalk.bold.hex('#ec1ec6')(s),
      boldCyan: (s) => chalk.bold.hex('#06b6d4')(s),
      gradient: (s) => chalk.bold.hex('#d946ef')(s),
    };
  } else {
    // Light terminal — use darker/more saturated variants for contrast.
    return {
      magenta: (s) => chalk.hex('#a21caf')(s), // fuchsia-700
      blue: (s) => chalk.hex('#1d4ed8')(s), // blue-700
      cyan: (s) => chalk.hex('#0e7490')(s), // cyan-700
      teal: (s) => chalk.hex('#0f766e')(s), // teal-700
      pink: (s) => chalk.hex('#be185d')(s), // pink-700
      indigo: (s) => chalk.hex('#4338ca')(s), // indigo-700
      muted: (s) => chalk.hex('#4b5563')(s), // gray-600
      bold: (s) => chalk.bold(s),
      boldMagenta: (s) => chalk.bold.hex('#a21caf')(s),
      boldCyan: (s) => chalk.bold.hex('#0e7490')(s),
      gradient: (s) => chalk.bold.hex('#a21caf')(s),
    };
  }
}

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
  return COMMANDS.find((c) => c.startsWith(partial)) ?? null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function navStr(satoshis) {
  return (satoshis / 1e8).toFixed(8);
}

function makeSep(C) {
  return C.muted('─'.repeat(80));
}

function renderHelp(C) {
  const SEP = makeSep(C);
  return [
    SEP,
    C.gradient('  navcoin-rescue-tool  ') + C.muted('TUI'),
    SEP,
    '',
    C.bold('  Commands:'),
    `    ${C.cyan('status')}              Show daemon and source status`,
    `    ${C.cyan('import mnemonic')}     Import a mnemonic source`,
    `    ${C.cyan('import private-key')}  Import one or more private keys`,
    `    ${C.cyan('remove')}              Remove an imported source`,
    `    ${C.cyan('sweep')}               Sweep all funds to a destination`,
    `    ${C.cyan('help')}                Show this help`,
    `    ${C.cyan('quit')}                Exit the TUI`,
    '',
    C.muted('  Tab auto-completes commands.  Ctrl+C to quit.'),
    SEP,
  ].join('\n');
}

function renderStatus(C, data) {
  const SEP = makeSep(C);
  const lines = [];
  const d = data.daemon;
  const statusColor = d.status === 'running' ? C.teal : C.pink;

  lines.push(SEP);
  lines.push(C.gradient('  Daemon'));
  lines.push(
    `  ${C.bold('Status:')}   ${statusColor(d.status)}  ${C.muted(`pid=${d.pid ?? 'none'}`)}`,
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
    lines.push(SEP);
    return lines.join('\n');
  }

  let totalNav = 0;
  let totalStaked = 0;

  for (const src of data.sources) {
    lines.push(SEP);
    const typeLabel = src.walletType
      ? `${src.type}:${src.walletType}`
      : src.type;
    lines.push(
      `  ${C.boldMagenta('Source')}  ${src.label}  ${C.muted(`[${typeLabel}]  ${src.id}`)}`,
    );

    const syncColor =
      src.syncStatus === 'synced'
        ? C.teal
        : src.syncStatus === 'syncing' || src.syncStatus === 'connecting'
          ? C.blue
          : src.syncStatus === 'error' || src.syncStatus === 'no-servers'
            ? C.pink
            : C.muted;

    const syncLabel =
      src.syncStatus === 'syncing'
        ? `syncing (${src.syncProgress}%)`
        : src.syncStatus;

    const serverLabel = src.server ? C.muted(`  via ${src.server}`) : '';
    lines.push(`  ${C.bold('Sync:')}    ${syncColor(syncLabel)}${serverLabel}`);

    if (src.liveError) {
      lines.push(`  ${C.pink('Error:')}   ${src.liveError}`);
    }

    const navConf = navStr(src.balance.nav.confirmed);
    const navPend = navStr(src.balance.nav.pending);
    const staked = navStr(src.balance.staked.confirmed);
    lines.push(
      `  ${C.bold('Balance:')} ${C.cyan(navConf)} NAV  ` +
        `${C.muted(navPend + ' pending')}  ` +
        `${C.indigo(staked)} staked`,
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

  lines.push(SEP);
  lines.push(C.gradient('  Totals'));
  lines.push(
    `  ${C.bold('NAV:')}    ${C.cyan(navStr(totalNav))} NAV confirmed`,
  );
  lines.push(
    `  ${C.bold('Staked:')} ${C.indigo(navStr(totalStaked))} NAV staked`,
  );
  lines.push(SEP);

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

  log('  Starting daemon...');

  const logFd = fs.openSync(layout.daemonLogFile, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true,
    env: { ...process.env, NTR_APP_DATA: root },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

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
// Command handlers
// ---------------------------------------------------------------------------
async function cmdStatus(C, root, log) {
  log(C.muted('  Fetching status...'));
  try {
    const data = await getDaemonStatus(root);
    log(renderStatus(C, data));
  } catch {
    log(C.pink('  Daemon not reachable. Restart the TUI to reconnect.'));
  }
}

async function cmdImportMnemonic(C, root, log, ask) {
  const walletType = await ask(
    `Wallet type (${SUPPORTED_MNEMONIC_WALLET_TYPES.join('/')}):`,
  );
  if (!SUPPORTED_MNEMONIC_WALLET_TYPES.includes(walletType)) {
    log(C.pink(`  Unknown wallet type: ${walletType}`));
    log(C.muted(`  Supported: ${SUPPORTED_MNEMONIC_WALLET_TYPES.join(', ')}`));
    return;
  }
  const label = await ask('Label:');
  const phrase = await ask('Mnemonic phrase:');

  if (!phrase) {
    log(C.muted('  Import cancelled.'));
    return;
  }

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
    log(C.muted('  Syncing in the background — check `status` for progress.'));
  } catch (error) {
    log(C.pink(`  Import failed: ${error.message}`));
  }
}

async function cmdImportPrivateKey(C, root, log, ask) {
  const label = await ask('Label:');

  const keys = [];
  log(
    C.muted('  Enter WIF private keys one at a time. Leave blank to finish.'),
  );
  for (;;) {
    const key = await ask(`Key ${keys.length + 1} (blank to finish):`);
    if (!key) break;
    keys.push(key);
  }

  if (keys.length === 0) {
    log(C.muted('  No keys entered. Import cancelled.'));
    return;
  }

  log(C.muted(`  Importing ${keys.length} key(s)...`));
  try {
    const result = await importDaemonSource(
      { type: 'private-key', label, keys },
      root,
    );
    log(C.teal(`  Imported: ${result.source.id}`));
    log(`  Label: ${result.source.label}   Keys: ${keys.length}`);
    log(C.muted('  Syncing in the background — check `status` for progress.'));
  } catch (error) {
    log(C.pink(`  Import failed: ${error.message}`));
  }
}

async function cmdRemove(C, root, log, ask) {
  try {
    const data = await getDaemonStatus(root);
    if (data.sources.length === 0) {
      log(C.muted('  No sources to remove.'));
      return;
    }
    log(C.gradient('  Imported sources:'));
    for (const src of data.sources) {
      const typeLabel = src.walletType
        ? `${src.type}:${src.walletType}`
        : src.type;
      log(`  ${C.magenta(src.id)}  ${src.label}  ${C.muted(`[${typeLabel}]`)}`);
    }
  } catch {
    log(C.pink('  Could not fetch source list. Daemon unreachable.'));
    return;
  }

  const sourceId = await ask('Source ID to remove:');
  if (!sourceId) {
    log(C.muted('  Removal cancelled.'));
    return;
  }

  const confirm = await ask(`Type YES to confirm removal of ${sourceId}:`);
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

async function cmdSweep(C, root, log, ask) {
  const SEP = makeSep(C);
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
  log(SEP);
  log(C.gradient('  Sweep Preview'));
  log(
    `  Total NAV: ${C.cyan(navStr(preview.totalNav))} NAV  ${C.muted('(confirmed, before fee)')}`,
  );
  log('  Sources:');
  for (const src of preview.sources) {
    log(`    ${C.muted(src.sourceId)}  ${C.cyan(navStr(src.nav))} NAV`);
  }
  log(SEP);

  const destination = await ask('Destination address:');
  if (!destination) {
    log(C.muted('  Sweep cancelled.'));
    return;
  }

  const reenter = await ask('Re-enter destination address:');
  if (reenter !== destination) {
    log(C.pink('  Destination mismatch. Sweep aborted.'));
    return;
  }

  log('');
  log(
    C.pink(
      '  !! This will broadcast a real transaction and cannot be undone !!',
    ),
  );
  const phrase = await ask('Type SEND MY COINS to confirm:');
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

  // Detect terminal background before blessed takes over stdin/stdout.
  const bgColor = await queryTerminalBg();
  const dark = bgColor ? isColorDark(bgColor) : true; // assume dark if unknown
  const C = buildPalette(dark);

  const screen = blessed.screen({
    smartCSR: true,
    title: 'navcoin-rescue-tool',
    // Use xterm-256color to avoid terminfo parse errors on terminals like
    // Alacritty that don't fully support all capabilities blessed probes.
    terminal: 'xterm-256color',
    fullUnicode: true,
  });

  // ---- Header bar -------------------------------------------------------
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content:
      C.boldMagenta(' navcoin-rescue-tool ') +
      C.muted('| help  Tab=complete  Ctrl+C=quit'),
    tags: false,
  });

  // ---- Separator below header -------------------------------------------
  const headerSep = blessed.box({
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: C.muted('─'.repeat(200)),
    tags: false,
  });

  // ---- Main output box --------------------------------------------------
  // top=2 (header + headerSep), bottom=3 (warnBox + inputSep + inputBox)
  const output = blessed.log({
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-5',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: '▐',
      style: { fg: dark ? '#818cf8' : '#4338ca' },
    },
    tags: false,
    wrap: true,
  });

  // ---- Warning row — shown above the separator when Ctrl+C pressed once --
  const warnBox = blessed.box({
    bottom: 2,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    tags: false,
  });

  // ---- Separator above input --------------------------------------------
  const inputSep = blessed.box({
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: C.muted('─'.repeat(200)),
    tags: false,
  });

  // ---- Input box --------------------------------------------------------
  const inputBox = blessed.textbox({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    inputOnFocus: true,
  });

  screen.append(header);
  screen.append(headerSep);
  screen.append(output);
  screen.append(warnBox);
  screen.append(inputSep);
  screen.append(inputBox);

  // ---- Helpers ----------------------------------------------------------
  function log(text) {
    output.log(text);
    screen.render();
  }

  // Exclusive ask mode — uses a depth counter so nested asks work correctly.
  let askDepth = 0;

  function ask(question) {
    return new Promise((resolve) => {
      askDepth += 1;
      // Clear any pending Ctrl+C warning when a prompt takes over.
      if (ctrlCPending) {
        ctrlCPending = false;
        clearTimeout(ctrlCTimer);
        warnBox.setContent('');
      }
      inputSep.setContent(
        C.cyan(' ? ') + question + C.muted(' (Enter to submit)'),
      );
      inputBox.setValue('');
      screen.render();
      inputBox.focus();

      function onSubmit(val) {
        askDepth -= 1;
        inputSep.setContent(C.muted('─'.repeat(200)));
        inputBox.setValue('');
        screen.render();
        resolve(val.trim());
      }

      inputBox.once('submit', onSubmit);
    });
  }

  // ---- Input dispatch ---------------------------------------------------
  let dispatching = false;

  async function dispatch(raw) {
    const cmd = raw.trim();
    if (!cmd) return;

    log(C.muted(`\n  $ ${cmd}`));

    switch (cmd) {
      case 'quit':
      case 'exit':
        screen.destroy();
        process.exit(0);
        break;
      case 'help':
        log(renderHelp(C));
        break;
      case 'status':
        await cmdStatus(C, root, log);
        break;
      case 'import mnemonic':
        await cmdImportMnemonic(C, root, log, ask);
        break;
      case 'import private-key':
        await cmdImportPrivateKey(C, root, log, ask);
        break;
      case 'remove':
        await cmdRemove(C, root, log, ask);
        break;
      case 'sweep':
        await cmdSweep(C, root, log, ask);
        break;
      default:
        log(C.pink(`  Unknown command: ${cmd}`));
        log(C.muted('  Type help for available commands.'));
    }
  }

  // Tab completion.
  inputBox.key('tab', () => {
    const current = inputBox.getValue();
    const completed = tabComplete(current);
    if (completed) {
      inputBox.setValue(completed);
      screen.render();
    }
  });

  // Enter submits — routes to active ask() or dispatches a command.
  inputBox.key('enter', () => {
    const val = inputBox.getValue();

    if (askDepth > 0) {
      inputBox.emit('submit', val);
      return;
    }

    if (dispatching) return;
    dispatching = true;
    inputBox.setValue('');
    screen.render();

    dispatch(val).finally(() => {
      dispatching = false;
      inputBox.focus();
    });
  });

  // Ctrl+C to quit — requires two presses within 2s.
  // Must be bound on both screen and inputBox because blessed textbox with
  // inputOnFocus captures raw keypresses before screen sees them.
  let ctrlCPending = false;
  let ctrlCTimer = null;

  function handleCtrlC() {
    if (ctrlCPending) {
      clearTimeout(ctrlCTimer);
      screen.destroy();
      process.exit(0);
    }

    ctrlCPending = true;
    warnBox.setContent(C.pink(' !! Press Ctrl+C again to quit !!'));
    screen.render();

    ctrlCTimer = setTimeout(() => {
      ctrlCPending = false;
      warnBox.setContent('');
      screen.render();
    }, 2000);
  }

  screen.key(['C-c'], handleCtrlC);
  inputBox.key(['C-c'], handleCtrlC);

  // ---- Startup ----------------------------------------------------------
  log(
    C.gradient('  navcoin-rescue-tool') +
      C.muted('  —  recovery tool for legacy NavCoin wallets'),
  );
  log(C.muted(`  Theme: ${dark ? 'dark' : 'light'} terminal detected`));
  log('');

  const running = await ensureDaemonRunning(root, layout, log);

  if (running) {
    log(
      C.teal('  Daemon ready.') +
        C.muted(`  http://${DAEMON_HOST}:${DAEMON_PORT}`),
    );
    log('');
    await cmdStatus(C, root, log);
  } else {
    log(
      C.pink('  Failed to start daemon. Check logs at: ') +
        C.muted(layout.daemonLogFile),
    );
  }

  log('');
  log(C.muted('  Type a command below. Tab to complete. help for reference.'));

  // ---- Periodic status refresh every 5s ---------------------------------
  let lastStatusSnapshot = null;

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
        header.setContent(
          C.boldMagenta(' navcoin-rescue-tool ') +
            C.blue(`⟳ syncing: ${progress}`) +
            C.muted('  Ctrl+C=quit'),
        );
      } else {
        header.setContent(
          C.boldMagenta(' navcoin-rescue-tool ') +
            C.teal('● synced') +
            C.muted('  | help  Tab=complete  Ctrl+C=quit'),
        );
      }

      if (!dispatching && askDepth === 0) {
        const snapshot = JSON.stringify(
          data.sources.map((s) => ({
            id: s.id,
            balance: s.balance,
            syncStatus: s.syncStatus,
          })),
        );
        if (snapshot !== lastStatusSnapshot) {
          lastStatusSnapshot = snapshot;
          log(C.muted('  ↻ Status updated'));
          log(renderStatus(C, data));
        }
      }

      screen.render();
    } catch {
      header.setContent(
        C.boldMagenta(' navcoin-rescue-tool ') +
          C.pink('● daemon offline') +
          C.muted('  Ctrl+C=quit'),
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
