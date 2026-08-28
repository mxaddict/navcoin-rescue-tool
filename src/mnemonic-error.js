// Marker the daemon puts on an import rejected for a failed mnemonic
// checksum, carried over the HTTP boundary in the error body so a client
// can tell that case from every other import failure without matching on
// message text. `gui/src/lib/mnemonic-error.js` mirrors this for the
// webview bundle; `mnemonic error code matches the GUI copy` in
// test/mnemonic.test.js fails if the two drift.
export const MNEMONIC_CHECKSUM_ERROR = 'mnemonic-checksum';

// Whether a checksum rejection is one the user may knowingly override.
// Only navcoin-core derives without looking at the checksum, so only it
// can import a phrase that fails one — every other type would throw again
// deeper in navcoin-js, where the error is worse and the phrase is gone.
export function isWaivableMnemonicError(error) {
  return error?.code === MNEMONIC_CHECKSUM_ERROR && error?.waivable === true;
}
