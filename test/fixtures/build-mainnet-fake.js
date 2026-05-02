#!/usr/bin/env node
/**
 * Fixture builder for transparent-NAV and xNAV daemon tests.
 *
 * Derives BIP44 addresses from the well-known test mnemonic, fabricates
 * coinbase-style transactions (no real signatures needed — electrum just
 * serves bytes), and writes test/fixtures/mainnet-fake.json.
 *
 * xNAV outputs are constructed using bitcore-lib's BLSCT primitives with a
 * deterministic blinding key so the fixture is stable across runs.
 *
 * Run:  node test/fixtures/build-mainnet-fake.js
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const bitcore = require('@aguycalled/bitcore-lib');
const Mnemonic = require('@aguycalled/bitcore-mnemonic');

// BLSCT (mcl wasm) must be initialized before any Transaction.Output or
// Transaction.to() is called — the Output constructor unconditionally uses
// blsct.mcl.G1 even for plain P2PKH outputs.
await bitcore.Transaction.Blsct.Init();

const blsct = bitcore.Transaction.Blsct;
const mcl = blsct.mcl;
const {
  HashG1Element,
  G,
  bytesArray,
} = require('@aguycalled/bitcore-lib/lib/crypto/blsct');
const { sha256sha256 } = require('@aguycalled/bitcore-lib/lib/crypto/hash');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, 'mainnet-fake.json');

// ─── Config ────────────────────────────────────────────────────────────────

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NETWORK = 'mainnet';
const DERIVATION_PATH_PREFIX = "m/44'/130'/0'";
const NUM_RECEIVE_ADDRS = 10;
const FIXTURE_HEIGHT = 5_000_000;
const TX_HEIGHT = 4_999_900;
// 1 NAV in satoshis
const COIN_VALUE = 100_000_000;
// 3 xNAV in satoshis
const XNAV_VALUE = 300_000_000;

// ─── Derive master key ─────────────────────────────────────────────────────

const mnem = new Mnemonic(MNEMONIC);
const seed = mnem.toSeed('');
const masterKey = bitcore.HDPrivateKey.fromSeed(seed, NETWORK);

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Electrum scripthash: sha256(scriptPubKey), bytes reversed, hex.
 */
function addressToScriptHash(address) {
  const script = bitcore.Script.fromAddress(address);
  const hash = bitcore.crypto.Hash.sha256(script.toBuffer());
  return Buffer.from(hash).reverse().toString('hex');
}

/**
 * Derive BIP44 child at m/44'/130'/0'/<change>/<index>.
 */
function deriveAddress(mk, change, index) {
  const p = `${DERIVATION_PATH_PREFIX}/${change}/${index}`;
  const child = mk.deriveChild(p);
  const pubKey = child.publicKey;
  const address = bitcore.Address(pubKey, NETWORK).toString();
  return { path: p, address };
}

/**
 * Build a minimal fake NAV transaction paying `value` satoshis to `address`.
 * Input: all-zeros prevout (coinbase-style). No signatures needed.
 */
function buildFakeTx(address, value) {
  const tx = new bitcore.Transaction();

  // Coinbase-style input: all-zeros txid, vout 0xffffffff
  tx.uncheckedAddInput(
    new bitcore.Transaction.Input({
      prevTxId:
        '0000000000000000000000000000000000000000000000000000000000000000',
      outputIndex: 0,
      sequenceNumber: 0xffffffff,
      script: bitcore.Script('OP_0'),
    }),
  );

  // Output paying the address
  tx.to(address, value);

  return tx;
}

/**
 * Compute txid (double-sha256 of serialized tx, little-endian hex).
 */
function txToId(tx) {
  const raw = tx.toBuffer();
  const hash = crypto.createHash('sha256').update(raw).digest();
  const txid = crypto.createHash('sha256').update(hash).digest().reverse();
  return txid.toString('hex');
}

/**
 * Build a deterministic xNAV (BLSCT) output paying `amount` to the wallet's
 * account-0/index-0 sub-address.  Uses a fixed blinding key derived from a
 * constant seed so the transaction hex — and therefore the fixture JSON — is
 * identical on every run.
 *
 * Mirrors the logic of blsct.CreateBLSCTOutput but substitutes the random
 * `bk.setByCSPRNG()` with `bk.setBigEndianMod(deterministicBytes)`.
 */
async function buildFakeXNavTx(masterViewKey, masterSpendKey, amount) {
  // Sub-address account 0, index 0 — the first key xNavFillKeyPool derives.
  const { viewKey, spendKey } = blsct.DerivePublicKeys(
    masterViewKey,
    masterSpendKey,
    0,
    0,
  );

  // Deterministic blinding key — same bytes every run.
  const bkBytes = crypto
    .createHash('sha256')
    .update('navcoin-rescue-tool-fixture-bk')
    .digest();
  const bk = new mcl.Fr();
  bk.setBigEndianMod(bkBytes);

  // G1 views of the sub-address keys.
  const destViewKey = new mcl.G1();
  destViewKey.deserialize(viewKey.serialize());
  const destSpendKey = new mcl.G1();
  destSpendKey.deserialize(spendKey.serialize());

  const tokenId = Buffer.alloc(32);
  const tokenNftId = -1;
  const memo = '';

  // Build output (OP_TRUE script = xNAV output marker).
  const output = new bitcore.Transaction.Output({
    satoshis: 0,
    script: bitcore.Script.fromHex('51'),
  });
  output.amount = amount;

  const nonce = mcl.mul(destViewKey, bk);

  const gamma = new mcl.Fr();
  gamma.setBigEndianMod(HashG1Element(nonce, 100));
  output.gamma = gamma;
  output.memo = memo;

  const hashNonce = new mcl.Fr();
  hashNonce.setBigEndianMod(HashG1Element(nonce, 0));

  // Range proof.
  output.bp = blsct.RangeProve([amount], nonce, memo, tokenId, tokenNftId);

  output.ek = mcl.mul(G(), bk);
  output.ok = mcl.mul(destSpendKey, bk);
  output.sk = mcl.add(destSpendKey, mcl.mul(G(), hashNonce));
  output.vData = Buffer.alloc(0);
  output.tokenId = tokenId;
  output.tokenNftId = tokenNftId;

  const outhash = sha256sha256(output.toBufferWriter().toBuffer());
  output.blstxsig = await blsct.AugmentedSign(bk, outhash);
  output.outhash = outhash;

  // Wrap in a fake tx (coinbase-style input).
  const tx = new bitcore.Transaction();
  tx.uncheckedAddInput(
    new bitcore.Transaction.Input({
      prevTxId:
        '0000000000000000000000000000000000000000000000000000000000000000',
      outputIndex: 0,
      sequenceNumber: 0xffffffff,
      script: bitcore.Script('OP_0'),
    }),
  );
  tx.outputs.push(output);

  const txHex = tx.toBuffer().toString('hex');
  const txid = txToId(tx);

  // Build txKeys entry so blockchain.transaction.get_keys returns meaningful
  // data.  The wallet's hasOwnedXNavOutput checks outputKey + spendingKey to
  // identify owned CT outputs without fetching the full raw tx.
  const keys = {
    vin: [],
    vout: [
      {
        outputKey: output.ok.serializeToHexStr(),
        spendingKey: output.sk.serializeToHexStr(),
      },
    ],
  };

  return { txid, txHex, keys };
}

// ─── Build fixture ─────────────────────────────────────────────────────────

const scripthashes = {};
const transactions = {};
// txKeys map: txid → { vin: [], vout: [{ outputKey, spendingKey }] }
// The stub returns these for blockchain.transaction.get_keys so that
// hasOwnedXNavOutput can find the owned output without falling back to the
// raw-tx decode path.  The wallet's built-in Sync() also calls getKeys and
// would crash if it receives null, so we always return a valid object.
const txKeys = {};

// Derive receive-branch addresses and fund two of them.
const FUNDED_INDICES = [0, 1];

for (let i = 0; i < NUM_RECEIVE_ADDRS; i++) {
  const { address } = deriveAddress(masterKey, 0, i);
  const sh = addressToScriptHash(address);

  if (FUNDED_INDICES.includes(i)) {
    const tx = buildFakeTx(address, COIN_VALUE);
    const txid = txToId(tx);
    const txHex = tx.serialize({ disableAll: true });

    scripthashes[sh] = {
      address,
      history: [{ tx_hash: txid, height: TX_HEIGHT, fee: 0 }],
      unspent: [
        {
          tx_hash: txid,
          tx_pos: 0,
          value: COIN_VALUE,
          height: TX_HEIGHT,
        },
      ],
    };
    transactions[txid] = txHex;
  } else {
    scripthashes[sh] = {
      address,
      history: [],
      unspent: [],
    };
  }
}

// Derive change-branch addresses (no funds, just coverage).
for (let i = 0; i < NUM_RECEIVE_ADDRS; i++) {
  const { address } = deriveAddress(masterKey, 1, i);
  const sh = addressToScriptHash(address);
  scripthashes[sh] = {
    address,
    history: [],
    unspent: [],
  };
}

// ─── xNAV (BLSCT) fixture ─────────────────────────────────────────────────

// Derive master BLS keys (mirrors navcoin-js wallet.js DeriveMasterKeys call).
const { masterViewKey, masterSpendKey } = blsct.DeriveMasterKeys(masterKey);

// Build the deterministic xNAV tx.
const {
  txid: xnavTxid,
  txHex: xnavTxHex,
  keys: xnavKeys,
} = await buildFakeXNavTx(masterViewKey, masterSpendKey, XNAV_VALUE);

// Add xNAV tx to the transactions map.
transactions[xnavTxid] = xnavTxHex;
// Store per-output keys so the stub can serve them for get_keys requests.
txKeys[xnavTxid] = xnavKeys;

// OP_TRUE anchor scripthash — the scripthash scanXNav queries for history.
// anchor = sha256(Script('51').toBuffer()) reversed.
const opTrueBuf = bitcore.Script.fromHex('51').toBuffer();
const anchorHash = Buffer.from(
  bitcore.crypto.Hash.sha256(opTrueBuf).reverse(),
).toString('hex');

// Register the xNAV tx in the anchor scripthash history + unspent list.
scripthashes[anchorHash] = {
  address: 'OP_TRUE',
  history: [{ tx_hash: xnavTxid, height: TX_HEIGHT, fee: 0 }],
  unspent: [
    {
      tx_hash: xnavTxid,
      tx_pos: 0,
      value: 0,
      height: TX_HEIGHT,
    },
  ],
};

// Fake 80-byte navcoin block header (all zeros for simplicity).
const HEADER_HEX = '00'.repeat(80);

const fixture = {
  header: {
    height: FIXTURE_HEIGHT,
    hex: HEADER_HEX,
  },
  // Total expected NAV balance: 2 * COIN_VALUE satoshis
  expectedNavConfirmed: FUNDED_INDICES.length * COIN_VALUE,
  // Total expected xNAV balance: XNAV_VALUE satoshis
  expectedXNavConfirmed: XNAV_VALUE,
  scripthashes,
  transactions,
  // Per-tx output keys served by blockchain.transaction.get_keys.
  txKeys,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Written: ${OUT_FILE}`);
console.log(`Funded NAV addresses: ${FUNDED_INDICES.length}`);
console.log(`Total NAV: ${fixture.expectedNavConfirmed / COIN_VALUE} NAV`);
console.log(`Total xNAV: ${fixture.expectedXNavConfirmed / COIN_VALUE} xNAV`);
console.log(`xNAV txid: ${xnavTxid}`);
console.log(`anchor scripthash: ${anchorHash}`);

// Sanity-check: round-trip the xNAV output and verify ownership.
const decodedXNav = new bitcore.Transaction(xnavTxHex);
const xnavOut = decodedXNav.outputs[0];
const hashId = Buffer.from(blsct.GetHashId(xnavOut, masterViewKey)).toString(
  'hex',
);
const recovered = blsct.RecoverBLSCTOutput(
  xnavOut,
  masterViewKey,
  undefined,
  0,
  0,
);
console.log(`\nxNAV sanity check:`);
console.log(`  isCt: ${xnavOut.isCt?.()}`);
console.log(`  hashId: ${hashId}`);
console.log(`  recovered amount: ${recovered?.amount}`);
console.log(
  `  amount matches: ${recovered?.amount === XNAV_VALUE ? 'YES' : 'NO'}`,
);
