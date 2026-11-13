// Splitting a sweep leg into transactions the network will take.
//
// navcoin-js builds a send from every unspent output it needs to reach the
// amount, and a sweep asks for all of them: one transaction, however many
// outputs the wallet holds. An old wallet holds thousands. navcoin-core
// refuses to relay a transaction at or over MAX_STANDARD_TX_WEIGHT (100 kB
// of plain NAV, measured here at 148 bytes an input), and an xNAV input
// costs a BLS signature and a pairing check to build (measured at 60 ms an
// input on a desktop). So each leg is cut into batches, every batch built
// by navcoin-js as before but from its own outputs only, and broadcast
// before the next is built.
import { STATIC_WALLET_PASSWORD } from './constants.js';
import { OUT_XNAV } from './wallet-manager.js';

// Inputs per NAV transaction: well under navcoin-core's size limit even
// for inputs signed with uncompressed keys, which are larger.
export const NAV_BATCH_INPUTS = 250;
// Inputs per xNAV transaction, kept low for the time one takes to build.
export const XNAV_BATCH_INPUTS = 100;

// navcoin-js's flat fee for a NAV transaction. navcoin-core's minimum
// relay fee (DEFAULT_MIN_RELAY_TX_FEE, per kB) comes to less than this for
// any transaction it will relay at all.
export const NAV_TX_FEE = 100_000;

// bitcore-lib charges an xNAV transaction this much for every input and
// output, and counts two outputs beyond the destination.
export const XNAV_FEE_PER_ELEMENT = 200_000;
const XNAV_ELEMENTS_BESIDE_INPUTS = 3;

export function xnavFee(inputs) {
  return XNAV_FEE_PER_ELEMENT * (inputs + XNAV_ELEMENTS_BESIDE_INPUTS);
}

// Cut `outputs` into batches of at most `batchInputs`, dealt out largest
// first so the small outputs ride along with large ones instead of
// collecting in a last batch too poor to pay its own fee. A batch that
// still cannot pay is left out and counted in `left`.
function planBatches(outputs, batchInputs, amountOf, feeOf) {
  const sorted = [...outputs].sort((a, b) => amountOf(b) - amountOf(a));
  const count = Math.ceil(sorted.length / batchInputs);
  const dealt = Array.from({ length: count }, () => []);
  sorted.forEach((output, index) => dealt[index % count].push(output));

  const batches = [];
  const left = { outputs: 0, amount: 0 };
  for (const batchOutputs of dealt) {
    const amount = batchOutputs.reduce((sum, o) => sum + amountOf(o), 0);
    const fee = feeOf(batchOutputs.length);
    if (amount > fee) {
      batches.push({ outputs: batchOutputs, amount, fee });
    } else {
      left.outputs += batchOutputs.length;
      left.amount += amount;
    }
  }
  return { batches, left };
}

/**
 * Plan the NAV leg of one wallet: every spendable output of `type`, in
 * batches of at most `batchInputs`.
 *
 * Returns { batches: [{ outputs, amount, fee }], left: { outputs, amount } }
 * where `left` is what no batch could carry.
 */
export async function planNavBatches(
  wallet,
  type,
  batchInputs = NAV_BATCH_INPUTS,
) {
  const outputs = await wallet.GetUtxos(type);
  return planBatches(
    outputs,
    batchInputs,
    (output) => output.output.satoshis,
    () => NAV_TX_FEE,
  );
}

/**
 * Plan the xNAV leg of one wallet, as `planNavBatches`. An output worth no
 * more than the fee its own input adds is left out before batching: it
 * would lower what arrives.
 */
export async function planXnavBatches(wallet, batchInputs = XNAV_BATCH_INPUTS) {
  const left = { outputs: 0, amount: 0 };
  const worthSpending = [];
  for (const output of await wallet.GetUtxos(OUT_XNAV)) {
    if (output.amount > XNAV_FEE_PER_ELEMENT) {
      worthSpending.push(output);
    } else {
      left.outputs += 1;
      left.amount += output.amount;
    }
  }

  const plan = planBatches(
    worthSpending,
    batchInputs,
    (output) => output.amount,
    xnavFee,
  );
  plan.left.outputs += left.outputs;
  plan.left.amount += left.amount;
  return plan;
}

// Build the transaction(s) of one NAV batch. navcoin-js picks its inputs
// from `this.GetUtxos()` and has no way to be handed a list, so it is run
// on an object that inherits everything from the wallet and answers that
// one call with the batch. The wallet itself is not touched: anything else
// reading its outputs meanwhile still sees all of them.
export function buildNavBatch(wallet, destination, batch, type) {
  const scoped = Object.create(wallet, {
    GetUtxos: { value: async () => batch.outputs },
  });
  return scoped.NavCreateTransaction(
    destination,
    batch.amount,
    '',
    STATIC_WALLET_PASSWORD,
    true,
    NAV_TX_FEE,
    type,
  );
}

// Build the transaction of one xNAV batch: navcoin-js takes the outpoints
// to spend from, and sends all they hold.
export function buildXnavBatch(wallet, destination, batch) {
  const from = batch.outputs.map((output) => `${output.txid}:${output.vout}`);
  return wallet.xNavCreateTransaction(
    destination,
    batch.amount,
    '',
    STATIC_WALLET_PASSWORD,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    from,
    true,
  );
}
