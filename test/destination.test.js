import assert from 'node:assert/strict';
import test from 'node:test';

import bitcoreLib from '@aguycalled/bitcore-lib';

import {
  assertSweepDestination,
  INVALID_DESTINATION,
} from '../src/destination.js';

const { PrivateKey } = bitcoreLib;
const key = new PrivateKey(
  bitcoreLib.crypto.Hash.sha256(Buffer.from('sweep test destination')).toString(
    'hex',
  ),
);
const NAV_ADDRESS = key.toAddress('livenet').toString();
// An xNAV address made with navcoin-js's own derivation from that seed.
const XNAV_ADDRESS =
  'xNVTn1dPMy34dMz7xy93h1TdXHwUaVVpqNPFCXMsLU6GHPb2AyLtowETR8Eo7Jj4sxsa3J' +
  'ikBixkFbsfkwq18WT7pCzWN5ZHYbX3by3XNcheiZVGU4EQEEs8qAVQipQWNGLZSwJR9pZ';

test('a mainnet NAV or xNAV address is accepted as a destination', () => {
  assert.doesNotThrow(() => assertSweepDestination(NAV_ADDRESS));
  assert.doesNotThrow(() => assertSweepDestination(XNAV_ADDRESS));
});

test('anything else is refused as a destination', () => {
  const refused = {
    'a DotNav name': 'alice.nav',
    'an address with a wrong character': `${NAV_ADDRESS.slice(0, -1)}x`,
    'a testnet address': key.toAddress('testnet').toString(),
    'an empty string': '',
    nothing: undefined,
    'an object': { toString: () => NAV_ADDRESS },
  };

  for (const [what, destination] of Object.entries(refused)) {
    assert.throws(
      () => assertSweepDestination(destination),
      (error) => {
        assert.equal(error.code, INVALID_DESTINATION, what);
        return true;
      },
      what,
    );
  }
});
