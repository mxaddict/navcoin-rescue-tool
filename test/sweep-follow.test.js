// What the client does when the reply to a sweep never arrives. A user's
// sweep ended in "fetch failed" while the daemon may still have been
// broadcasting; the client now follows the sweep on /status instead. A
// fake daemon stands in for the real one, to script replies a real sweep
// cannot be made to give on demand.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test, { before } from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { describeLeftBehind, sweepConfirm } from '../src/daemon-client.js';
import { LEFT_NOT_SPENDABLE, LEFT_TOO_SMALL } from '../src/sweep.js';
import {
  killPortHolders,
  makeProjectTempDir,
  startFakeDaemon,
  TEST_DAEMON_PORT,
} from './test-helpers.js';

before(() => {
  killPortHolders(TEST_DAEMON_PORT);
});

const RESULT = { hashes: ['abc123'], totalSent: 499990000, totalFee: 10000 };

// Runs `body` with a fake daemon whose /sweep/confirm drops the connection
// unanswered and whose /status reports each entry of `sweeps` in turn, the
// last one from then on. A function entry is given the sweep id the client
// sent, to report a sweep that is the client's own.
async function withLostReply(name, sweeps, body) {
  const root = await makeProjectTempDir(`sweep-follow-${name}`);
  await bootstrapAppData(root);

  let sweepId = null;
  let polls = 0;
  const fake = await startFakeDaemon(({ url, body: sent }) => {
    if (url === '/sweep/confirm') {
      sweepId = sent.sweepId;
      return { destroy: true };
    }
    const next = sweeps[Math.min(polls, sweeps.length - 1)];
    polls += 1;
    return { sweep: typeof next === 'function' ? next(sweepId) : next };
  });

  try {
    await body({ root, fake });
  } finally {
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function confirm(root, options) {
  return sweepConfirm('NDestinationAddr1', 'SEND MY COINS', root, options);
}

test('a sweep whose reply is lost is followed to its result', async () => {
  await withLostReply(
    'finished',
    [
      (id) => ({ id, state: 'running', result: null, error: null }),
      (id) => ({ id, state: 'finished', result: RESULT, error: null }),
    ],
    async ({ root, fake }) => {
      const lost = [];
      const response = await confirm(root, {
        onLostReply: (error) => lost.push(error.message),
      });

      assert.deepEqual(response, { result: RESULT });
      assert.equal(lost.length, 1);
      assert.match(lost[0], /^fetch failed \(/);
      // Asked again while it was still running, rather than giving up.
      assert.deepEqual(fake.requests, [
        'POST /sweep/confirm',
        'GET /status',
        'GET /status',
      ]);
    },
  );
});

test('a followed sweep that failed reports the daemon’s own error', async () => {
  const error =
    'xNAV broadcast failed for source abc: server busy\n' +
    'Already broadcast before this, and not undone:\n' +
    '  NAV from abc: nav-hash';
  await withLostReply(
    'failed',
    [(id) => ({ id, state: 'failed', result: null, error })],
    async ({ root }) => {
      await assert.rejects(confirm(root), { message: error });
    },
  );
});

// A daemon restarted mid-sweep, or one holding only an earlier sweep: the
// client cannot say what happened and must not say nothing did.
test('a lost sweep the daemon has no record of says to check first', async () => {
  for (const sweeps of [
    [null],
    [{ id: 'some-earlier-sweep', state: 'finished', result: RESULT }],
  ]) {
    await withLostReply('unrecorded', sweeps, async ({ root }) => {
      await assert.rejects(confirm(root), (error) => {
        assert.match(error.message, /the daemon has no record of it/);
        assert.match(error.message, /before sweeping again/);
        return true;
      });
    });
  }
});

test('a sweep the daemon refuses is not followed', async () => {
  const root = await makeProjectTempDir('sweep-follow-refused');
  await bootstrapAppData(root);
  const fake = await startFakeDaemon(() => ({
    status: 400,
    json: { error: 'A sweep is already running.', code: 'SWEEP_IN_PROGRESS' },
  }));

  try {
    let lostReplies = 0;
    await assert.rejects(
      confirm(root, { onLostReply: () => (lostReplies += 1) }),
      { message: 'A sweep is already running.', code: 'SWEEP_IN_PROGRESS' },
    );
    assert.equal(lostReplies, 0);
    assert.deepEqual(fake.requests, ['POST /sweep/confirm']);
  } finally {
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A refused connection reached no daemon, so nothing can have been
// broadcast and there is nothing to follow.
test('a sweep sent to no daemon at all fails as unreachable', async () => {
  const root = await makeProjectTempDir('sweep-follow-none');
  await bootstrapAppData(root);

  try {
    let lostReplies = 0;
    await assert.rejects(
      confirm(root, { onLostReply: () => (lostReplies += 1) }),
      (error) => {
        assert.match(error.message, /^fetch failed \(ECONNREFUSED/);
        assert.equal(error.cause?.cause?.code, 'ECONNREFUSED');
        return true;
      },
    );
    assert.equal(lostReplies, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('what a sweep left behind is described with its reason', () => {
  assert.deepEqual(
    describeLeftBehind([
      {
        sourceId: 'imported-1',
        walletType: 'navpay',
        coin: 'xNAV',
        reason: LEFT_TOO_SMALL,
        amount: 150_000,
      },
      {
        sourceId: 'imported-2',
        walletType: null,
        coin: 'NAV',
        reason: LEFT_NOT_SPENDABLE,
        amount: 2_0000_0000,
      },
    ]),
    [
      '0.00150000 xNAV left in imported-1 (navpay): in outputs too small ' +
        'to pay their own fee',
      '2.00000000 NAV left in imported-2: not spendable yet; sweep again ' +
        'once it has confirmed or matured',
    ],
  );
  // A daemon older than the client sends no list.
  assert.deepEqual(describeLeftBehind(undefined), []);
});
