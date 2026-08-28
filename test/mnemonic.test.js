import test from 'node:test';
import assert from 'node:assert/strict';

import { assertMnemonicAccepted, getMnemonicCheck } from '../src/mnemonic.js';
import {
  isWaivableMnemonicError,
  MNEMONIC_CHECKSUM_ERROR,
} from '../src/mnemonic-error.js';
import { MNEMONIC_CHECKSUM_ERROR as GUI_MNEMONIC_CHECKSUM_ERROR } from '../gui/src/lib/mnemonic-error.js';
import { isWaivableMnemonicError as guiIsWaivableMnemonicError } from '../gui/src/lib/mnemonic-error.js';
import { SUPPORTED_MNEMONIC_WALLET_TYPES } from '../src/constants.js';

// BIP39 test vector: valid checksum, and the phrase used wherever a
// phrase only has to be accepted.
const VALID_BIP39 =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// The same 12 words with one changed to another wordlist entry, which
// breaks the checksum while leaving every word valid. This is the shape
// of a real transcription slip — an unknown word would be caught by any
// check, a wrong word is only caught by the checksum.
const BROKEN_BIP39 =
  'legal winner thank year wave sausage worth useful legal winner thank zoo';

function rejection(phrase, walletType, options) {
  try {
    assertMnemonicAccepted(phrase, walletType, options);
  } catch (error) {
    return error;
  }
  return null;
}

test('a phrase with a broken checksum is rejected for every wallet type', () => {
  for (const walletType of SUPPORTED_MNEMONIC_WALLET_TYPES) {
    const error = rejection(BROKEN_BIP39, walletType);
    assert.ok(error, `${walletType} must reject a broken checksum`);
    assert.equal(error.code, MNEMONIC_CHECKSUM_ERROR);
  }
});

test('a valid BIP39 phrase is accepted by the types that derive from one', () => {
  for (const walletType of ['navcoin-js-v1', 'coinomi', 'navpay', 'next']) {
    assert.doesNotThrow(() => assertMnemonicAccepted(VALID_BIP39, walletType));
  }
  assert.doesNotThrow(() =>
    assertMnemonicAccepted(VALID_BIP39, 'navcoin-core'),
  );
});

// coinomi is an alias of navcoin-js-v1, so it has to inherit the check
// rather than fall through to the default by accident.
test('coinomi is checked as the type it aliases', () => {
  assert.deepEqual(
    getMnemonicCheck('coinomi'),
    getMnemonicCheck('navcoin-js-v1'),
  );
});

// navcash is an Electrum wallet: its phrases carry a seed version, not a
// BIP39 checksum, so a BIP39-valid phrase is the wrong thing for it.
test('navcash is checked against the Electrum scheme, not BIP39', () => {
  assert.equal(getMnemonicCheck('navcash').check, 'electrum');

  const error = rejection(VALID_BIP39, 'navcash');
  assert.ok(error, 'a BIP39 phrase is not an Electrum seed');
  assert.equal(error.code, MNEMONIC_CHECKSUM_ERROR);
  assert.equal(error.waivable, false);
});

// navcoin-core derives from the raw entropy and never reads the checksum,
// so it is the only type that can honour a waiver.
test('only navcoin-core can waive the checksum', () => {
  assert.equal(rejection(BROKEN_BIP39, 'navcoin-core').waivable, true);
  assert.doesNotThrow(() =>
    assertMnemonicAccepted(BROKEN_BIP39, 'navcoin-core', {
      allowUnchecked: true,
    }),
  );

  for (const walletType of ['navcoin-js-v1', 'coinomi', 'navpay', 'next']) {
    const error = rejection(BROKEN_BIP39, walletType, { allowUnchecked: true });
    assert.ok(error, `${walletType} must ignore a waiver`);
    assert.equal(error.waivable, false);
  }
  assert.ok(rejection(VALID_BIP39, 'navcash', { allowUnchecked: true }));
});

// The message reaches the daemon log, which is not written with the care
// sources.json is. A rejection that pastes the phrase there is how the
// original report leaked a live seed.
test('a rejection never repeats the phrase', () => {
  for (const walletType of SUPPORTED_MNEMONIC_WALLET_TYPES) {
    const { message } = rejection(BROKEN_BIP39, walletType);
    for (const word of BROKEN_BIP39.split(' ')) {
      assert.ok(
        !message.includes(word),
        `"${word}" leaked into the ${walletType} message: ${message}`,
      );
    }
  }
});

test('the waiver is only advertised where it can be honoured', () => {
  assert.match(rejection(BROKEN_BIP39, 'navcoin-core').message, /unchecked/i);
  assert.doesNotMatch(
    rejection(BROKEN_BIP39, 'navcoin-js-v1').message,
    /unchecked/i,
  );
});

test('isWaivableMnemonicError only fires on a waivable checksum error', () => {
  assert.equal(
    isWaivableMnemonicError(rejection(BROKEN_BIP39, 'navcoin-core')),
    true,
  );
  assert.equal(
    isWaivableMnemonicError(rejection(BROKEN_BIP39, 'navcoin-js-v1')),
    false,
  );
  assert.equal(isWaivableMnemonicError(new Error('daemon unreachable')), false);
  assert.equal(isWaivableMnemonicError(undefined), false);
});

// The webview bundle cannot import src/mnemonic-error.js, so it keeps its
// own copy. The copy is only correct while it agrees with this one.
test('mnemonic error code matches the GUI copy', () => {
  assert.equal(GUI_MNEMONIC_CHECKSUM_ERROR, MNEMONIC_CHECKSUM_ERROR);

  const waivable = rejection(BROKEN_BIP39, 'navcoin-core');
  const notWaivable = rejection(BROKEN_BIP39, 'navcoin-js-v1');
  assert.equal(guiIsWaivableMnemonicError(waivable), true);
  assert.equal(guiIsWaivableMnemonicError(notWaivable), false);
  assert.equal(guiIsWaivableMnemonicError(new Error('nope')), false);
});
