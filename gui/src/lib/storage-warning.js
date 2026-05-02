// Mirrors src/constants.js getStorageWarningLines so the GUI shows the
// same disclosure as the CLI/TUI after every successful import. Keep
// the wording in sync with the node-side helper.
export const STATIC_WALLET_PASSWORD = 'ObsidianSweepKey';

export function getStorageWarningLines(walletsDir) {
  return [
    'Imported wallet data is stored locally.',
    `  Path:     ${walletsDir}`,
    `  Password: ${STATIC_WALLET_PASSWORD} (static, shared across sources)`,
    '',
    'Treat this directory as sensitive — anyone with disk access plus the',
    'static password can read the wallet. Run purge after sweeping to',
    'delete it.',
  ];
}
