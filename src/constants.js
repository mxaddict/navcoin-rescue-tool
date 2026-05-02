export const APP_NAME = 'navcoin-rescue-tool';
export const CLI_NAME = 'ntr';
export const GUI_NAME = 'ntr-gui';
export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_PORT = Number(process.env.NTR_DAEMON_PORT) || 46117;
export const STATIC_WALLET_PASSWORD = 'ObsidianSweepKey';

// Recovery tool uses a large address pool so we don't miss funds on wallets
// that have activity beyond the default navcoin-js pool size of 10.
// BIP44 standard gap limit is 20 — we use 100 to be safe for recovery.
export const RECOVERY_MIN_POOL_SIZE = 100;
export const SUPPORTED_MNEMONIC_WALLET_TYPES = [
  'navcoin-core',
  'navcash',
  'next',
  'navpay',
  'navcoin-js-v1',
];
export const SUPPORTED_SOURCE_TYPES = ['mnemonic', 'private-key'];

export const FILE_LAYOUT = {
  daemon: 'daemon.json',
  authCookie: 'auth.cookie',
  sources: 'sources.json',
  walletsDir: 'wallets',
  logsDir: 'logs',
  daemonLog: 'logs/daemon.log',
};

// Display labels and units for each rescueScan phase. Drives status output
// in the CLI and TUI so users see "deriving keys" instead of "utxo" during
// the long key-derivation pass, etc.
export const SYNC_PHASES = {
  receive: { label: 'scanning receive', unit: 'addr' },
  change: { label: 'scanning change', unit: 'addr' },
  'stake-discover': { label: 'discovering stake partners', unit: 'addr' },
  stake: { label: 'scanning stake', unit: 'script' },
  'xnav-history': { label: 'fetching xNAV history', unit: '' },
  xnav: { label: 'scanning xNAV', unit: 'tx' },
  'xnav-claim': { label: 'claiming xNAV', unit: 'tx' },
};

export function formatSyncPhase(phase, current, total) {
  const meta = SYNC_PHASES[phase];
  if (!meta) return phase ?? 'syncing';
  if (total > 0) {
    const unit = meta.unit ? ` ${meta.unit}` : '';
    return `${meta.label} (${current ?? 0}/${total}${unit})`;
  }
  return meta.label;
}

// Lines of the post-import disclosure shown by every UI surface (CLI, TUI,
// GUI). Keeps wording consistent and centralizes the password constant.
export function getStorageWarningLines(walletsDir) {
  return [
    'Imported wallet data is stored locally.',
    `  Path:     ${walletsDir}`,
    `  Password: ${STATIC_WALLET_PASSWORD} (static, shared across sources)`,
    '',
    'Treat this directory as sensitive — anyone with disk access plus the',
    'static password can read the wallet. Run `purge` after sweeping to',
    'delete it.',
  ];
}
