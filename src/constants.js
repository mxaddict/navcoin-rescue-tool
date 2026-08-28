import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Reported on /status so a client can tell whether the daemon it found on
// the port was started from the same code it ships with — a daemon that
// keeps running across an upgrade otherwise serves the old behaviour with
// no sign that it is doing so. Read from the manifest rather than
// duplicated here, so a version bump stays a one-file change.
export const APP_VERSION = require('../package.json').version;

export const APP_NAME = 'navcoin-rescue-tool';
export const CLI_NAME = 'ntr';
export const GUI_NAME = 'ntr-gui';
export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_PORT = Number(process.env.NTR_DAEMON_PORT) || 46117;
export const STATIC_WALLET_PASSWORD = 'ObsidianSweepKey';

// How long `ntr start` and the TUI wait for a freshly spawned daemon to
// answer on its port. Booting it loads navcoin-js and its native
// dependencies, which takes well over a second on a warm machine and tens
// of seconds on a cold or loaded one — a short wait reports a daemon that
// is merely slow as a daemon that failed.
export const DAEMON_READY_TIMEOUT_MS = 60_000;

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
  'coinomi',
];

// User-facing wallet types that navcoin-js has no branch for, mapped to
// the navcoin-js type with the same derivation. Coinomi derives NavCoin
// from a standard BIP39 seed at BIP44 m/44'/130'/0' (SLIP-44 coin 130),
// which is exactly the navcoin-js-v1 scheme — the alias exists so users
// can pick the app they actually used.
const WALLET_TYPE_ALIASES = {
  coinomi: 'navcoin-js-v1',
};

// The navcoin-js wallet type that derives keys for a user-facing type.
export function getDerivationWalletType(walletType) {
  return WALLET_TYPE_ALIASES[walletType] ?? walletType;
}

// The distinct derivation schemes behind the user-facing types: aliases
// collapse into the type they alias, because deriving both would produce
// the same keys twice and double-count every UTXO. An import tries every
// one of these the phrase is valid for, so the user never has to know
// which app produced their phrase.
export const MNEMONIC_DERIVATION_TYPES = [
  ...new Set(SUPPORTED_MNEMONIC_WALLET_TYPES.map(getDerivationWalletType)),
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
