// Mirrors src/mnemonic-error.js for the webview bundle, which cannot
// import the node-side module — it pulls in bitcore-mnemonic through
// src/mnemonic.js. Keep the code string in sync with the node-side copy;
// `mnemonic error code matches the GUI copy` in test/mnemonic.test.js
// fails if they drift.
export const MNEMONIC_CHECKSUM_ERROR = 'mnemonic-checksum';

export function isWaivableMnemonicError(error) {
  return error?.code === MNEMONIC_CHECKSUM_ERROR && error?.waivable === true;
}
