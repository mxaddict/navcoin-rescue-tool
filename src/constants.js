export const APP_NAME = 'navcoin-rescue-tool';
export const CLI_NAME = 'ntr';
export const GUI_NAME = 'ntr-gui';
export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_PORT = 46117;
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
