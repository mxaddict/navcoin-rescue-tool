#!/usr/bin/env node
/**
 * Fixture builder for transparent-NAV daemon tests.
 *
 * Derives BIP44 addresses from the well-known test mnemonic, fabricates
 * coinbase-style transactions (no real signatures needed — electrum just
 * serves bytes), and writes test/fixtures/mainnet-fake.json.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, 'mainnet-fake.json');

// ─── Config ────────────────────────────────────────────────────────────────

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_TYPE = 'navcoin-js-v1';
const NETWORK = 'mainnet';
const DERIVATION_PATH_PREFIX = "m/44'/130'/0'";
const NUM_RECEIVE_ADDRS = 10;
const FIXTURE_HEIGHT = 5_000_000;
const TX_HEIGHT = 4_999_900;
// 1 NAV in satoshis
const COIN_VALUE = 100_000_000;

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
function deriveAddress(masterKey, change, index) {
  const path = `${DERIVATION_PATH_PREFIX}/${change}/${index}`;
  const child = masterKey.deriveChild(path);
  const pubKey = child.publicKey;
  const address = bitcore.Address(pubKey, NETWORK).toString();
  return { path, address };
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

// ─── Build fixture ─────────────────────────────────────────────────────────

const scripthashes = {};
const transactions = {};

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

// Fake 80-byte navcoin block header (all zeros for simplicity).
const HEADER_HEX = '00'.repeat(80);

const fixture = {
  header: {
    height: FIXTURE_HEIGHT,
    hex: HEADER_HEX,
  },
  // Total expected NAV balance: 2 * COIN_VALUE satoshis
  expectedNavConfirmed: FUNDED_INDICES.length * COIN_VALUE,
  scripthashes,
  transactions,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Written: ${OUT_FILE}`);
console.log(`Funded addresses: ${FUNDED_INDICES.length}`);
console.log(`Total NAV: ${fixture.expectedNavConfirmed / COIN_VALUE} NAV`);

// Print sanity-check for one funded address
const firstFunded = deriveAddress(masterKey, 0, 0);
const firstSh = addressToScriptHash(firstFunded.address);
const firstTxid = Object.keys(transactions)[0];
console.log(`\nSanity check:`);
console.log(`  Address[0]: ${firstFunded.address}`);
console.log(`  Scripthash: ${firstSh}`);
console.log(`  TxID:       ${firstTxid}`);
console.log(`  Tx hex:     ${transactions[firstTxid].slice(0, 40)}...`);
