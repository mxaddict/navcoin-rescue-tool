import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { createImportedWallet } from '../src/navcoin-js-adapter.js';
import { publicSource, redactSourceSecret } from '../src/source-secret.js';
import { makeProjectTempDir, removeDaemonDataDir } from './test-helpers.js';

const WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const mnemonicSource = {
  id: 'a1',
  type: 'mnemonic',
  walletType: 'next',
  normalizedDetails: WORDS.replaceAll(' ', '\n'),
};
const KEYS = ['PCbhgKMp6ym9MgtMQ3XYxqnMrG3yFwAuQgTmZznbLxWExwxXH2pM', 'Kfake2'];
const keySource = {
  id: 'b2',
  type: 'private-key',
  normalizedDetails: KEYS.join('\n'),
};

test('a source in a reply is its record without the secret', () => {
  assert.deepEqual(publicSource(mnemonicSource), {
    id: 'a1',
    type: 'mnemonic',
    walletType: 'next',
  });
  assert.ok(mnemonicSource.normalizedDetails, 'the record itself is kept');
});

test('a phrase is taken out of a message however it is joined', () => {
  assert.equal(
    redactSourceSecret(`Mnemonic string is invalid: ${WORDS}`, mnemonicSource),
    'Mnemonic string is invalid: [redacted]',
  );
  assert.equal(
    redactSourceSecret(
      `bad input ${mnemonicSource.normalizedDetails}!`,
      mnemonicSource,
    ),
    'bad input [redacted]!',
  );
});

test('each private key is taken out of a message', () => {
  assert.equal(
    redactSourceSecret(`cannot import ${KEYS[1]} after ${KEYS[0]}`, keySource),
    'cannot import [redacted] after [redacted]',
  );
});

test('a message with no secret in it is left as it is', () => {
  assert.equal(
    redactSourceSecret('SQLITE_BUSY: database is locked', mnemonicSource),
    'SQLITE_BUSY: database is locked',
  );
  assert.equal(redactSourceSecret('no source', undefined), 'no source');
  assert.equal(redactSourceSecret('no secret', { id: 'c3' }), 'no secret');
});

// The real worker and the real library: a phrase that is not a mnemonic
// is rejected by bitcore-mnemonic with the phrase in the message.
test('a wallet that fails to build reports it without the phrase', async () => {
  const root = await makeProjectTempDir('source-secret');
  const words = Array(12).fill('zebra');

  try {
    await bootstrapAppData(root);
    await assert.rejects(
      () =>
        createImportedWallet(
          {
            id: 'source-secret-bad-phrase',
            type: 'mnemonic',
            walletType: 'next',
            normalizedDetails: words.join('\n'),
          },
          root,
        ),
      (error) => {
        assert.match(error.message, /Mnemonic string is invalid: \[redacted\]/);
        assert.doesNotMatch(error.message, /zebra/);
        return true;
      },
    );
  } finally {
    await removeDaemonDataDir(root);
  }
});
