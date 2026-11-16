// The address a sweep sends to: what the daemon accepts as one.
import bitcoreLib from '@aguycalled/bitcore-lib';

const { Address } = bitcoreLib;

export const INVALID_DESTINATION = 'INVALID_DESTINATION';

// Throws unless `destination` is a mainnet NAV or xNAV address, written
// out in full.
//
// navcoin-js takes more than that: a destination ending in `.nav` is a
// DotNav name, which it resolves by asking the electrum server the source
// is connected to, once per transaction. Those are public servers, and the
// address one of them answers with is never shown to the user, so a name
// would let a server choose where the coins go.
export function assertSweepDestination(destination) {
  if (
    typeof destination === 'string' &&
    Address.isValid(destination, 'livenet')
  )
    return;

  const shown =
    typeof destination === 'string' && destination !== ''
      ? `"${destination}"`
      : 'nothing';
  const error = new Error(
    `The destination must be a NavCoin mainnet address (NAV or xNAV), ` +
      `got ${shown}. A name such as alice.nav is not accepted: enter the ` +
      `address itself.`,
  );
  error.code = INVALID_DESTINATION;
  throw error;
}
