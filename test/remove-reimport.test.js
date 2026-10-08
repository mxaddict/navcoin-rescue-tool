// Removing a source and importing it again, against a real daemon, the
// real wallet library and a fixture-backed stub server.
//
// A source id is derived from what was imported, so importing the same
// phrase or key again reuses the id and the wallet database name. Every
// case here ends the same way: the source is back, synced, holding the
// fixture's balance, and the daemon is still up with nothing in its log
// that says the wallet storage went wrong on the way.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import {
  getDaemonStatus,
  importDaemonSource,
  purgeDaemon,
  removeDaemonSource,
  stopDaemon,
} from '../src/daemon-client.js';
import {
  killPortHolders,
  makeProjectTempDir,
  spawnDaemon,
  startStubElectrumServer,
  waitForDaemonReady,
  waitForExit,
} from './test-helpers.js';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PRIVATE_KEY = 'PCbhgKMp6ym9MgtMQ3XYxqnMrG3yFwAuQgTmZznbLxWExwxXH2pM';
// The derivation the fixture's coins sit on.
const FUNDED_TYPE = 'navcoin-js-v1';

// A first sync of the phrase's derivations against the stub, with room
// for a slow CI machine.
const SETTLE_WITHIN_MS = 150_000;
const POLL_MS = 500;
const TEST_TIMEOUT_MS = 480_000;

// What the daemon must never print on the way: a broken wallet store,
// a transaction cache write that collided, or a crash.
const BAD_OUTPUT = [
  /AddTx error/,
  /SQLITE_[A-Z]+/,
  /ConstraintError/,
  /TypeError/,
];

let fixture;
let stub;

before(async () => {
  killPortHolders();
  fixture = JSON.parse(
    await fs.readFile(
      path.join(import.meta.dirname, 'fixtures', 'mainnet-fake.json'),
      'utf8',
    ),
  );
  stub = await startStubElectrumServer(fixture);
});

after(async () => {
  await stub?.close();
});

// A daemon on `root`, with everything it prints kept for the assertions.
async function startDaemon(root, output) {
  const child = spawnDaemon({ root, stubPort: stub.port });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  await waitForDaemonReady(child);
  return child;
}

async function stop(root, child) {
  await stopDaemon(root).catch(() => {});
  await waitForExit(child);
}

async function withRoot(name, body) {
  const root = await makeProjectTempDir(`remove-reimport-${name}`);
  await bootstrapAppData(root);
  const output = [];
  const children = [];
  try {
    await body({
      root,
      output,
      start: async () => {
        const child = await startDaemon(root, output);
        children.push(child);
        return child;
      },
    });
  } finally {
    for (const child of children) {
      child.kill('SIGTERM');
      await waitForExit(child);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

const importPhrase = (root) =>
  importDaemonSource({ type: 'mnemonic', phrase: PHRASE }, root);
const importKey = (root) =>
  importDaemonSource({ type: 'private-key', keys: [PRIVATE_KEY] }, root);

// Every source settled one way or the other: synced, or stuck in a state
// it will not leave by itself.
async function waitForSettled(root) {
  const deadline = Date.now() + SETTLE_WITHIN_MS;
  let sources = [];
  while (Date.now() < deadline) {
    sources = (await getDaemonStatus(root)).sources ?? [];
    if (
      sources.length > 0 &&
      sources.every((source) =>
        ['synced', 'error', 'no-servers'].includes(source.syncStatus),
      )
    ) {
      return sources;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return sources;
}

function describe(sources) {
  return JSON.stringify(
    sources.map((source) => ({
      type: source.walletType ?? source.type,
      syncStatus: source.syncStatus,
      error: source.error,
    })),
  );
}

async function assertAllSynced(root, { expectedTypes }) {
  const sources = await waitForSettled(root);
  assert.deepEqual(
    sources.map((source) => source.walletType ?? source.type).sort(),
    [...expectedTypes].sort(),
    'the sources that should be there are',
  );
  assert.ok(
    sources.every((source) => source.syncStatus === 'synced'),
    `every source synced: ${describe(sources)}`,
  );
  return sources;
}

function assertFundedBalance(sources) {
  const funded = sources.find((source) => source.walletType === FUNDED_TYPE);
  assert.equal(funded.balance.nav.confirmed, fixture.expectedNavConfirmed);
  assert.equal(funded.balance.xnav.confirmed, fixture.expectedXNavConfirmed);
}

function assertCleanOutput(output) {
  const text = output.join('');
  for (const pattern of BAD_OUTPUT) {
    const match = text.match(pattern);
    assert.equal(
      match,
      null,
      `daemon printed ${pattern}: …${match && text.slice(Math.max(0, match.index - 300), match.index + 300)}…`,
    );
  }
}

const PHRASE_TYPES = ['next', 'navpay', FUNDED_TYPE];

test(
  'every derivation removed, then the phrase imported again',
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRoot('all', async ({ root, output, start }) => {
      const child = await start();
      const first = await importPhrase(root);
      await assertAllSynced(root, { expectedTypes: PHRASE_TYPES });

      for (const source of first.sources) {
        await removeDaemonSource(source.id, root);
      }
      assert.equal((await getDaemonStatus(root)).sourceCount, 0);

      await importPhrase(root);
      assertFundedBalance(
        await assertAllSynced(root, { expectedTypes: PHRASE_TYPES }),
      );
      assertCleanOutput(output);
      await stop(root, child);
    }),
);

test(
  'one derivation removed, then the phrase imported again',
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRoot('one', async ({ root, output, start }) => {
      const child = await start();
      const first = await importPhrase(root);
      await assertAllSynced(root, { expectedTypes: PHRASE_TYPES });

      const funded = first.sources.find(
        (source) => source.walletType === FUNDED_TYPE,
      );
      await removeDaemonSource(funded.id, root);

      const second = await importPhrase(root);
      assert.deepEqual(
        second.sources.map((source) => source.walletType),
        [FUNDED_TYPE],
        'only the removed derivation is imported again',
      );
      assertFundedBalance(
        await assertAllSynced(root, { expectedTypes: PHRASE_TYPES }),
      );
      assertCleanOutput(output);
      await stop(root, child);
    }),
);

test(
  'a private key removed, then imported again',
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRoot('key', async ({ root, output, start }) => {
      const child = await start();
      const first = await importKey(root);
      await assertAllSynced(root, { expectedTypes: ['private-key'] });

      await removeDaemonSource(first.sources[0].id, root);
      await importKey(root);

      await assertAllSynced(root, { expectedTypes: ['private-key'] });
      assertCleanOutput(output);
      await stop(root, child);
    }),
);

// The window that matters is right after a wallet connects, while
// navcoin-js is still setting the connection up; removing then used to
// take the whole daemon down.
test(
  'sources removed while still connecting and syncing, then imported again',
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRoot('mid-sync', async ({ root, output, start }) => {
      const child = await start();
      const first = await importPhrase(root);

      // Removed as soon as each has connected, not after it settles.
      const deadline = Date.now() + SETTLE_WITHIN_MS;
      const pending = new Set(first.sources.map((source) => source.id));
      while (pending.size > 0 && Date.now() < deadline) {
        const live = (await getDaemonStatus(root)).sources ?? [];
        for (const source of live) {
          if (pending.has(source.id) && source.connected) {
            await removeDaemonSource(source.id, root);
            pending.delete(source.id);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(pending.size, 0, 'every source connected and was removed');
      assert.equal(child.exitCode, null, 'the daemon is still running');

      await importPhrase(root);
      assertFundedBalance(
        await assertAllSynced(root, { expectedTypes: PHRASE_TYPES }),
      );
      assertCleanOutput(output);
      await stop(root, child);
    }),
);

test(
  'sources removed, the daemon restarted, then imported again',
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRoot('restart', async ({ root, output, start }) => {
      let child = await start();
      const first = await importPhrase(root);
      await assertAllSynced(root, { expectedTypes: PHRASE_TYPES });
      for (const source of first.sources) {
        await removeDaemonSource(source.id, root);
      }
      await stop(root, child);

      child = await start();
      await importPhrase(root);
      assertFundedBalance(
        await assertAllSynced(root, { expectedTypes: PHRASE_TYPES }),
      );
      assertCleanOutput(output);
      await stop(root, child);
    }),
);

test(
  'everything purged, then the phrase imported again',
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRoot('purge', async ({ root, output, start }) => {
      let child = await start();
      await importPhrase(root);
      await assertAllSynced(root, { expectedTypes: PHRASE_TYPES });

      // Purge stops the daemon once the data is gone.
      await purgeDaemon(root);
      await waitForExit(child);

      child = await start();
      await importPhrase(root);
      assertFundedBalance(
        await assertAllSynced(root, { expectedTypes: PHRASE_TYPES }),
      );
      assertCleanOutput(output);
      await stop(root, child);
    }),
);
