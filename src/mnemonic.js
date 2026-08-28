import Mnemonic from '@aguycalled/bitcore-mnemonic';
import {
  PREFIXES as ELECTRUM_PREFIXES,
  validateMnemonic as validateElectrumMnemonic,
} from 'electrum-mnemonic';

import { getDerivationWalletType } from './constants.js';
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
    check === 'electrum'
      ? 'Check the phrase against your backup, or pick the wallet type the phrase actually came from.'
      : 'Check the phrase against your backup — a single mistyped word is enough to fail it.';

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
      `A "${walletType}" wallet is derived from ${words} words; this phrase has ${wordCount}. ` +
        `Import it under a wallet type that derives from a ${wordCount}-word phrase.`,
    );
    error.code = MNEMONIC_WORD_COUNT_ERROR;
    error.waivable = false;
    throw error;
  }

  if (waivable && allowUnchecked) return;
  if (isPhraseValid(phrase, check)) return;

  const error = new Error(buildMessage(walletType, check, waivable));
  error.code = MNEMONIC_CHECKSUM_ERROR;
  error.waivable = waivable;
  throw error;
}
