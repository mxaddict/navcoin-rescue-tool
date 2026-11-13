// Sweep batching: the planning on its own, then the builds against the
// real navcoin-js. The fakes in sweep.test.js cannot show that navcoin-js
// spends only the outputs of the batch it is handed; a wallet opened on
// the fixture's outputs can.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { bootstrapAppData } from '../src/app-data.js';
import { getNavWallet } from '../src/navcoin-js-adapter.js';
import {
  buildNavBatch,
  buildXnavBatch,
  NAV_TX_FEE,
  planNavBatches,
  planXnavBatches,
  XNAV_FEE_PER_ELEMENT,
  xnavFee,
} from '../src/sweep-batches.js';
import {
  closeAllWallets,
  getSourceState,
  OUT_NAV,
  OUT_STAKED,
  openSourceWallet,
  resetElectrumNodeSelectionCache,
} from '../src/wallet-manager.js';
import {
  buildWalletForSource,
  getProjectRoot,
  startStubElectrumServer,
} from './test-helpers.js';

const require = createRequire(import.meta.url);
const bitcore = require('@aguycalled/bitcore-lib');

const NAV_TYPES = OUT_NAV | OUT_STAKED;

// A wallet as far as planning reads one: its spendable outputs.
function walletHolding(amounts) {
  return {
    GetUtxos: async () =>
      amounts.map((amount, index) => ({
        txid: `tx${index}`,
        vout: 0,
        amount,
        output: { satoshis: amount },
      })),
  };
}

function coins(n) {
  return n * 1_0000_0000;
}

const amountsOf = (batch) => batch.outputs.map((output) => output.amount);

test('outputs are dealt into batches no larger than the limit', async () => {
  const wallet = walletHolding([700, 600, 500, 400, 300, 200, 100].map(coins));
  const { batches, left } = await planNavBatches(wallet, NAV_TYPES, 3);

  assert.deepEqual(batches.map(amountsOf), [
    [700, 400, 100].map(coins),
    [600, 300].map(coins),
    [500, 200].map(coins),
  ]);
  for (const batch of batches) {
    assert.equal(
      batch.amount,
      amountsOf(batch).reduce((sum, amount) => sum + amount, 0),
    );
    assert.equal(batch.fee, NAV_TX_FEE);
  }
  assert.deepEqual(left, { outputs: 0, amount: 0 });
});

test('small outputs ride with large ones instead of being stranded', async () => {
  // In wallet order the two dust outputs would fill a batch of their own
  // and could not pay its fee.
  const wallet = walletHolding([coins(5), coins(4), 10, 20]);
  const { batches, left } = await planNavBatches(wallet, NAV_TYPES, 2);

  assert.deepEqual(batches.map(amountsOf), [
    [coins(5), 20],
    [coins(4), 10],
  ]);
  assert.deepEqual(left, { outputs: 0, amount: 0 });
});

test('a batch that cannot pay its fee is left behind, not built', async () => {
  const wallet = walletHolding([NAV_TX_FEE - 10, 10]);
  assert.deepEqual(await planNavBatches(wallet, NAV_TYPES), {
    batches: [],
    left: { outputs: 2, amount: NAV_TX_FEE },
  });

  // One more satoshi and the same outputs pay their way.
  const enough = walletHolding([NAV_TX_FEE - 10, 11]);
  const plan = await planNavBatches(enough, NAV_TYPES);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].amount, NAV_TX_FEE + 1);
});

test('an xNAV batch is charged per input, and dust is not spent', async () => {
  const wallet = walletHolding([
    coins(1),
    XNAV_FEE_PER_ELEMENT,
    XNAV_FEE_PER_ELEMENT + 1,
  ]);
  const { batches, left } = await planXnavBatches(wallet);

  assert.deepEqual(batches.map(amountsOf), [
    [coins(1), XNAV_FEE_PER_ELEMENT + 1],
  ]);
  assert.equal(batches[0].fee, xnavFee(2));
  assert.deepEqual(left, { outputs: 1, amount: XNAV_FEE_PER_ELEMENT });

  // A batch worth no more than its whole fee is left too.
  const poor = walletHolding([xnavFee(1)]);
  assert.deepEqual(await planXnavBatches(poor), {
    batches: [],
    left: { outputs: 1, amount: xnavFee(1) },
  });
});

test('a wallet with nothing spendable plans nothing', async () => {
  assert.deepEqual(await planNavBatches(walletHolding([]), NAV_TYPES), {
    batches: [],
    left: { outputs: 0, amount: 0 },
  });
});

// ─── Against the real navcoin-js ───────────────────────────────────────────

// A first scan of the fixture wallet: derivation plus a stub round trip
// per address.
const SCAN_WITHIN_MS = 120_000;
const POLL_MS = 100;
// Comfortably past the confirmations navcoin-js wants on a stake reward.
const MATURE_DEPTH = 1_000;

// One fixed directory, cleared when the run starts: the indexeddb shim
// keeps its sqlite files open for the life of the process, so this
// process can never delete them.
const root = path.join(getProjectRoot(), 'tmp', 'sweep-batches');

const outpointOf = (output) => `${output.txid}:${output.vout}`;
const inputsOf = (hex) =>
  bitcore
    .Transaction(hex)
    .inputs.map(
      (input) => `${input.prevTxId.toString('hex')}:${input.outputIndex}`,
    );

test(
  'navcoin-js builds each batch from that batch alone',
  { timeout: SCAN_WITHIN_MS + 60_000 },
  async () => {
    const fixture = JSON.parse(
      await fs.readFile(
        path.join(import.meta.dirname, 'fixtures', 'mainnet-fake.json'),
        'utf8',
      ),
    );
    // The fixture's outputs sit a hundred blocks under its tip, first in
    // their block: navcoin-js takes that for a fresh stake reward and will
    // not spend it yet. Bury them deep enough to be spendable.
    for (const entry of Object.values(fixture.scripthashes)) {
      for (const item of [...entry.history, ...entry.unspent]) {
        item.height = fixture.header.height - MATURE_DEPTH;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await bootstrapAppData(root);
    const navWallet = await getNavWallet(root);
    const stub = await startStubElectrumServer(fixture);
    process.env.NTR_ELECTRUM_NODES = `127.0.0.1:${stub.port}:ws`;

    try {
      const source = {
        id: 'sweep-batches',
        type: 'mnemonic',
        walletType: 'navcoin-js-v1',
      };
      await buildWalletForSource(navWallet, source.id);
      await openSourceWallet(source, root, navWallet);
      const state = getSourceState(source.id);

      const deadline = Date.now() + SCAN_WITHIN_MS;
      while (
        state.balance.nav.confirmed !== fixture.expectedNavConfirmed ||
        state.balance.xnav?.confirmed !== fixture.expectedXNavConfirmed
      ) {
        assert.ok(Date.now() < deadline, 'the fixture balance never arrived');
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }

      const wallet = state.wallet;
      const destination = (await wallet.NavReceivingAddresses())[0].address;

      // The fixture holds more than one NAV output, so batches of one
      // input make more than one batch.
      const navPlan = await planNavBatches(wallet, NAV_TYPES, 1);
      assert.ok(navPlan.batches.length > 1);
      assert.equal(
        navPlan.batches.reduce((sum, batch) => sum + batch.amount, 0),
        fixture.expectedNavConfirmed,
      );
      for (const batch of navPlan.batches) {
        const built = await buildNavBatch(
          wallet,
          destination,
          batch,
          NAV_TYPES,
        );
        assert.equal(built.tx.length, 1);
        assert.equal(built.fee, NAV_TX_FEE);
        assert.deepEqual(inputsOf(built.tx[0]), batch.outputs.map(outpointOf));
        const outputs = bitcore.Transaction(built.tx[0]).outputs;
        assert.equal(outputs.length, 1);
        assert.equal(outputs[0].satoshis, batch.amount - NAV_TX_FEE);
      }

      // And one batch holding every output spends every output.
      const whole = await planNavBatches(wallet, NAV_TYPES);
      assert.equal(whole.batches.length, 1);
      const wholeTx = await buildNavBatch(
        wallet,
        destination,
        whole.batches[0],
        NAV_TYPES,
      );
      assert.deepEqual(
        inputsOf(wholeTx.tx[0]).sort(),
        whole.batches[0].outputs.map(outpointOf).sort(),
      );
      // The wallet itself still lists all of its outputs.
      assert.equal(
        (await wallet.GetUtxos(NAV_TYPES)).length,
        whole.batches[0].outputs.length,
      );

      const xnavPlan = await planXnavBatches(wallet);
      assert.equal(xnavPlan.batches.length, 1);
      const xnavBatch = xnavPlan.batches[0];
      assert.equal(xnavBatch.amount, fixture.expectedXNavConfirmed);
      const xnavTx = await buildXnavBatch(wallet, destination, xnavBatch);
      assert.deepEqual(inputsOf(xnavTx.tx[0]), [
        outpointOf(xnavBatch.outputs[0]),
      ]);
      assert.equal(xnavTx.fee, xnavBatch.fee);

      // A batch naming an outpoint the wallet does not hold spends nothing:
      // navcoin-js is limited to the outpoints it is given.
      await assert.rejects(
        buildXnavBatch(wallet, destination, {
          ...xnavBatch,
          outputs: [{ txid: '00'.repeat(32), vout: 0 }],
        }),
        /No available xNAV outputs/,
      );
    } finally {
      await closeAllWallets();
      await stub.close();
      resetElectrumNodeSelectionCache();
      delete process.env.NTR_ELECTRUM_NODES;
    }
  },
);
