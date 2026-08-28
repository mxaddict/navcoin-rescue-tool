import Mnemonic from '@aguycalled/bitcore-mnemonic';
import {
  PREFIXES as ELECTRUM_PREFIXES,
  validateMnemonic as validateElectrumMnemonic,
} from 'electrum-mnemonic';

import {
  getDerivationWalletType,
  MNEMONIC_DERIVATION_TYPES,
} from './constants.js';
import {
  MNEMONIC_CHECKSUM_ERROR,
  MNEMONIC_WORD_COUNT_ERROR,
} from './mnemonic-error.js';

// The check a wallet type's phrase has to pass before it is accepted, and
// whether the user may knowingly waive it.
//
// Every type not listed here derives its master key by constructing a
// bitcore Mnemonic, which enforces the BIP39 checksum itself — validating
// at import only moves that failure to where the phrase can still be
// corrected, instead of letting it surface from a background worker.
//
// navcash uses Electrum's scheme, which carries its own seed version
// check rather than a BIP39 checksum.
//
// navcoin-core is the one that has to be a policy decision: it derives
// from the raw entropy via `Mnemonic.mnemonicToData`, which slices the
// checksum bits off and never compares them, so it accepts a phrase with
// a wrong word and silently derives a different wallet than the user
// meant. It is checked like the rest, but the check is waivable, because
// a wallet really created from a phrase BIP39 would reject is exactly the
// wallet this tool exists to rescue.
//
// `words` is a hard requirement rather than a check: navcoin-core uses the
// BIP39 entropy itself as the master key, and a bitcore PrivateKey is 32
// bytes, which only a 24-word phrase produces. A shorter phrase used to be
// accepted here and then failed deriving addresses in a background worker.
const WALLET_TYPE_CHECKS = {
  'navcoin-core': { check: 'bip39', waivable: true, words: 24 },
  navcash: { check: 'electrum', waivable: false },
};

const DEFAULT_CHECK = { check: 'bip39', waivable: false };

// The lengths BIP39 defines. `Mnemonic.isValid` sizes a buffer as
// `words * 11 / 32` and throws a RangeError on a fractional result, so
// anything else has to be caught here to be reported as a word count
// rather than swallowed and blamed on the next check in line.
const BIP39_WORD_COUNTS = [12, 15, 18, 21, 24];

export function getMnemonicCheck(walletType) {
  return (
    WALLET_TYPE_CHECKS[getDerivationWalletType(walletType)] ?? DEFAULT_CHECK
  );
}

function isPhraseValid(phrase, check) {
  return check === 'electrum'
    ? validateElectrumMnemonic(phrase, ELECTRUM_PREFIXES.standard)
    : Mnemonic.isValid(phrase);
}

function buildMessage(walletType, check, waivable) {
  const failed =
    check === 'electrum'
      ? `This phrase is not a valid Electrum seed, which is what "${walletType}" wallets are derived from.`
      : `This phrase fails its BIP39 checksum, so at least one word is wrong.`;

  const advice =
    'Check the phrase against your backup — a single mistyped word is enough to fail it.';

  const waiver = waivable
    ? ' If this wallet really was created from a phrase that fails the checksum, re-import it with the unchecked-mnemonic option to derive from it anyway.'
    : '';

  return `${failed} ${advice}${waiver}`;
}

// Throws when `phrase` cannot be the seed of a `walletType` wallet.
//
// The phrase never appears in the error: the message travels into the
// daemon log, which is not written with the same care as sources.json.
export function assertMnemonicAccepted(
  phrase,
  walletType,
  { allowUnchecked = false } = {},
) {
  const { check, waivable, words } = getMnemonicCheck(walletType);

  // Checked before the waiver, and before the checksum: a phrase of the
  // wrong length cannot derive this wallet at all, so there is nothing to
  // waive and no point reporting a checksum for it.
  const wordCount = phrase.trim().split(/\s+/).filter(Boolean).length;
  if (words && wordCount !== words) {
    const error = new Error(
      `A "${walletType}" wallet is derived from ${words} words; this phrase has ${wordCount}.`,
    );
    error.code = MNEMONIC_WORD_COUNT_ERROR;
    error.check = check;
    error.waivable = false;
    throw error;
  }

  if (check === 'bip39' && !BIP39_WORD_COUNTS.includes(wordCount)) {
    const error = new Error(
      `A BIP39 phrase is ${BIP39_WORD_COUNTS.join(', ')} words long; ` +
        `this phrase has ${wordCount}.`,
    );
    error.code = MNEMONIC_WORD_COUNT_ERROR;
    error.check = check;
    // Every BIP39 derivation refuses this length, so it outranks a rule
    // that belongs to one wallet type when both are reported.
    error.everyBip39Type = true;
    error.waivable = false;
    throw error;
  }

  if (waivable && allowUnchecked) return;
  if (isPhraseValid(phrase, check)) return;

  const error = new Error(buildMessage(walletType, check, waivable));
  error.code = MNEMONIC_CHECKSUM_ERROR;
  error.check = check;
  error.waivable = waivable;
  throw error;
}

// Every derivation scheme that can produce a wallet from this phrase.
//
// A rescue tool cannot ask someone which app made a phrase years ago, and
// guessing wrong reports an empty wallet — indistinguishable from having
// no coins. So an import derives all of them and lets the balances say
// which one was real. The set is phrase-dependent: an Electrum seed is
// only ever navcash, a BIP39 phrase is never navcash, and navcoin-core
// needs the full 24 words.
export function getEligibleWalletTypes(
  phrase,
  { allowUnchecked = false } = {},
) {
  return MNEMONIC_DERIVATION_TYPES.filter((walletType) => {
    try {
      assertMnemonicAccepted(phrase, walletType, { allowUnchecked });
      return true;
    } catch {
      return false;
    }
  });
}

// Why no derivation accepted the phrase, as the error to show for it.
//
// Each type refuses for its own reason, and they are not equally useful:
// a phrase failing its checksum is reported as a checksum failure, not as
// navcash complaining it is not an Electrum seed. A waivable rejection
// wins outright, because it is the one the user can still act on.
export function explainNoEligibleWalletType(
  phrase,
  { allowUnchecked = false } = {},
) {
  const errors = [];
  for (const walletType of MNEMONIC_DERIVATION_TYPES) {
    try {
      assertMnemonicAccepted(phrase, walletType, { allowUnchecked });
    } catch (error) {
      // Waivable means navcoin-core would take it with an explicit
      // opt-in, so this is the only rejection with a way forward.
      if (error.waivable === true) return error;
      errors.push(error);
    }
  }

  // BIP39 before Electrum: nearly every phrase in circulation is BIP39,
  // and navcash refusing it as "not an Electrum seed" describes the
  // scheme the user was not using rather than the word they mistyped.
  //
  // Within BIP39, which failure to report depends on what the user
  // asked for. Having already waived the checksum, they need to hear
  // that the waiver's one derivation needs 24 words — repeating the
  // checksum answers a question they just overrode.
  const isBip39 = (error) => error.check === 'bip39';
  const byCode = (code) => (error) => isBip39(error) && error.code === code;

  const ranked = [
    // A length no BIP39 scheme accepts is the whole story, and saying so
    // beats quoting one wallet type's stricter rule back at the user.
    (error) => isBip39(error) && error.everyBip39Type === true,
    ...(allowUnchecked
      ? [byCode(MNEMONIC_WORD_COUNT_ERROR), byCode(MNEMONIC_CHECKSUM_ERROR)]
      : [byCode(MNEMONIC_CHECKSUM_ERROR), byCode(MNEMONIC_WORD_COUNT_ERROR)]),
  ];

  for (const matches of ranked) {
    const match = errors.find(matches);
    if (match) return match;
  }

  return (
    errors.find((error) => error.code === MNEMONIC_CHECKSUM_ERROR) ??
    errors[0] ??
    new Error('This phrase cannot be derived by any supported wallet type.')
  );
}
