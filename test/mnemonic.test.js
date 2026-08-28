import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertMnemonicAccepted,
  explainNoEligibleWalletType,
  getEligibleWalletTypes,
  getMnemonicCheck,
} from '../src/mnemonic.js';
import {
  isWaivableMnemonicError,
  MNEMONIC_CHECKSUM_ERROR,
  MNEMONIC_WORD_COUNT_ERROR,
} from '../src/mnemonic-error.js';
import { MNEMONIC_CHECKSUM_ERROR as GUI_MNEMONIC_CHECKSUM_ERROR } from '../gui/src/lib/mnemonic-error.js';
import { isWaivableMnemonicError as guiIsWaivableMnemonicError } from '../gui/src/lib/mnemonic-error.js';
import { SUPPORTED_MNEMONIC_WALLET_TYPES } from '../src/constants.js';

// BIP39 test vector: valid checksum, and the phrase used wherever a
// phrase only has to be accepted.
const VALID_BIP39 =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// 24 words, valid checksum. navcoin-core needs this length, so anything
// asserting on its checksum behaviour has to use it.
const VALID_BIP39_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';

// The 24-word phrase with one word swapped for another wordlist entry.
const BROKEN_BIP39_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth zoo';

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
    // navcoin-core only derives from 24 words, so give it a phrase of the
    // length it accepts and let the checksum be the thing that fails.
    const phrase =
      walletType === 'navcoin-core' ? BROKEN_BIP39_24 : BROKEN_BIP39;
    const error = rejection(phrase, walletType);
    assert.ok(error, `${walletType} must reject a broken checksum`);
    assert.equal(error.code, MNEMONIC_CHECKSUM_ERROR);
  }
});

test('a valid BIP39 phrase is accepted by the types that derive from one', () => {
  for (const walletType of ['navcoin-js-v1', 'coinomi', 'navpay', 'next']) {
    assert.doesNotThrow(() => assertMnemonicAccepted(VALID_BIP39, walletType));
  }
  assert.doesNotThrow(() =>
    assertMnemonicAccepted(VALID_BIP39_24, 'navcoin-core'),
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
  assert.equal(rejection(BROKEN_BIP39_24, 'navcoin-core').waivable, true);
  assert.doesNotThrow(() =>
    assertMnemonicAccepted(BROKEN_BIP39_24, 'navcoin-core', {
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
    const phrase =
      walletType === 'navcoin-core' ? BROKEN_BIP39_24 : BROKEN_BIP39;
    const { message } = rejection(phrase, walletType);
    for (const word of phrase.split(' ')) {
      assert.ok(
        !message.includes(word),
        `"${word}" leaked into the ${walletType} message: ${message}`,
      );
    }
  }
});

test('the waiver is only advertised where it can be honoured', () => {
  assert.match(
    rejection(BROKEN_BIP39_24, 'navcoin-core').message,
    /unchecked/i,
  );
  assert.doesNotMatch(
    rejection(BROKEN_BIP39, 'navcoin-js-v1').message,
    /unchecked/i,
  );
});

test('isWaivableMnemonicError only fires on a waivable checksum error', () => {
  assert.equal(
    isWaivableMnemonicError(rejection(BROKEN_BIP39_24, 'navcoin-core')),
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

  const waivable = rejection(BROKEN_BIP39_24, 'navcoin-core');
  const notWaivable = rejection(BROKEN_BIP39, 'navcoin-js-v1');
  assert.equal(guiIsWaivableMnemonicError(waivable), true);
  assert.equal(guiIsWaivableMnemonicError(notWaivable), false);
  assert.equal(guiIsWaivableMnemonicError(new Error('nope')), false);
});

// navcoin-core uses the BIP39 entropy as the master key directly, and a
// bitcore PrivateKey is 32 bytes — only 24 words produce that many. A
// 12-word phrase passed the checksum and then died deriving addresses in
// a background worker with "Cannot read properties of undefined".
test('navcoin-core refuses a phrase too short to derive a master key', () => {
  const error = rejection(VALID_BIP39, 'navcoin-core');

  assert.ok(error, '12 words cannot be a navcoin-core wallet');
  assert.equal(error.code, MNEMONIC_WORD_COUNT_ERROR);
  assert.match(error.message, /24 words/);
  assert.match(error.message, /has 12/);
});

// No flag turns 16 bytes of entropy into 32, so the waiver must not reach
// past the length requirement.
test('the waiver cannot get a short phrase past navcoin-core', () => {
  const error = rejection(VALID_BIP39, 'navcoin-core', {
    allowUnchecked: true,
  });

  assert.ok(error, 'the waiver must not apply to a length failure');
  assert.equal(error.code, MNEMONIC_WORD_COUNT_ERROR);
  assert.equal(isWaivableMnemonicError(error), false);
});

// The length requirement is navcoin-core's alone: every other type
// derives through a seed function that takes any valid phrase length.
test('a 12-word phrase is fine for the types that hash it into a seed', () => {
  for (const walletType of ['navcoin-js-v1', 'coinomi', 'navpay', 'next']) {
    assert.doesNotThrow(() => assertMnemonicAccepted(VALID_BIP39, walletType));
  }
});

// A length BIP39 does not define at all. `Mnemonic.isValid` sizes a buffer
// from the word count and throws a RangeError rather than returning false,
// which the eligibility sweep swallows — so without an explicit length
// rule the only surviving complaint is navcash's, and the user is told to
// check the phrase against an Electrum backup they never had.
const THIRTEEN_WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank year wave';

test('a word count BIP39 does not define is reported as a word count', () => {
  assert.deepEqual(getEligibleWalletTypes(THIRTEEN_WORDS), []);

  const error = explainNoEligibleWalletType(THIRTEEN_WORDS);
  assert.equal(error.code, MNEMONIC_WORD_COUNT_ERROR);
  assert.match(error.message, /13/);
  assert.ok(
    !/Electrum/i.test(error.message),
    `blamed on Electrum: ${error.message}`,
  );
  assert.ok(
    !/navcoin-core/.test(error.message),
    `every BIP39 type refuses this length, so it is not navcoin-core's rule: ${error.message}`,
  );
});

test('waiving the checksum reports why the waiver could not apply', () => {
  // navcoin-core is the only derivation that can take a phrase failing the
  // checksum, and it needs 24 words. Answering a 12-word phrase with
  // "the checksum failed" repeats the check the user just overrode.
  const waived = { allowUnchecked: true };
  assert.deepEqual(getEligibleWalletTypes(BROKEN_BIP39, waived), []);

  const error = explainNoEligibleWalletType(BROKEN_BIP39, waived);
  assert.equal(error.code, MNEMONIC_WORD_COUNT_ERROR);
  assert.match(error.message, /24 words/);

  // Without the waiver the checksum is exactly what to report.
  assert.equal(
    explainNoEligibleWalletType(BROKEN_BIP39).code,
    MNEMONIC_CHECKSUM_ERROR,
  );
});

test('no explanation ever contains the phrase', () => {
  for (const phrase of [THIRTEEN_WORDS, BROKEN_BIP39, BROKEN_BIP39_24]) {
    for (const options of [{}, { allowUnchecked: true }]) {
      const { message } = explainNoEligibleWalletType(phrase, options);
      for (const word of phrase.split(' ')) {
        assert.ok(!message.includes(word), `"${word}" leaked into: ${message}`);
      }
    }
  }
});
