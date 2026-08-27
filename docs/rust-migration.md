# Rust migration plan

Goal: remove Node.js from the project entirely — runtime, build, and
dependencies — and ship self-contained binaries for the CLI/TUI/daemon and
the GUI. This document is the plan and the reference for the decisions it
depends on. Delete it when the migration lands; what still binds future work
then belongs in `PLAN.md`.

## Verdict

Achievable. Nothing in the project needs Node at runtime once `navcoin-js` is
replaced, and everything `navcoin-js` does for the rescue workflow is
reproducible in Rust with mature crates plus a bounded amount of
NavCoin-specific code (custom transaction format, BLSCT/xNAV key derivation,
output recovery, and — for the sweep only — the bulletproof range prover).

The cost is concentrated in one place: the xNAV cryptography has no existing
Rust implementation for the legacy NavCoin chain. The `navio-blsct` crate
targets Navio (the successor chain, different wire format) and builds C++
from git at compile time, so it is neither compatible nor in the spirit of a
self-contained binary. The port is done against `navcoin-js`'s bitcore fork,
byte-for-byte, with test vectors generated from the JS implementation before
it is deleted.

What "self-contained" ends up meaning per binary:

| Binary    | Linux                                                 | macOS    | Windows                     |
| --------- | ----------------------------------------------------- | -------- | --------------------------- |
| `ntr`     | Fully static (`musl`), one file                       | One file | One file                    |
| `ntr-gui` | One file, links system `libwebkit2gtk-4.1` (as today) | One file | One file (WebView2 from OS) |

The Linux webview dependency is the status quo and the only place a system
library remains. A Rust-native toolkit (`iced`/`egui`) would remove it at the
cost of rewriting the UI outside the browser model; see Decisions.

A side benefit: the two platforms currently excluded — Windows ARM64 and
macOS Intel — were excluded because `bcrypto`'s vendored C failed to build.
A pure-Rust crypto stack has no such problem, so both come back for free.

## What exists today

| Piece                   | Source                                              | Lines | Depends on Node for                                  |
| ----------------------- | --------------------------------------------------- | ----: | ---------------------------------------------------- |
| CLI                     | `src/cli.js`                                        |   641 | runtime, `fetch`                                     |
| TUI                     | `src/tui.js`                                        |  1301 | `blessed`, `chalk`, OSC 11 bg probe                  |
| Daemon HTTP + lifecycle | `src/daemon.js`, `src/app-data.js`                  |   548 | `node:http`, detached spawn                          |
| Source registry         | `src/source-registry.js`                            |   189 | —                                                    |
| Wallet manager          | `src/wallet-manager.js`                             |   823 | `navcoin-js` wallet object, WebSocket probe          |
| Scan engine             | `src/rescue-scan.js`                                |   596 | `navcoin-js` wallet/db/client, bitcore `Transaction` |
| navcoin-js boundary     | `src/navcoin-js-adapter.js`, `src/wallet-worker.js` |   402 | `indexeddbshim`, child process, WS frame patch       |
| GUI shell               | `src-tauri/src/lib.rs`, `src-tauri/daemon-launch`   |  ~450 | spawns the Node CLI to start the daemon              |
| GUI frontend            | `gui/src/*.svelte`, `gui/src/lib/*`                 |  ~900 | Svelte + Vite at build time only                     |
| Tests                   | `test/*.js`                                         | ~2400 | `node --test`, WebSocket electrum stub               |

`navcoin-js` itself pulls in bitcore (secp256k1, BIP32/39, base58, scripts),
`@aguycalled/mcl-wasm` (BLS12-381 arithmetic), `@aguycalled/noble-bls12-381`
(BLS signatures), an Electrum client over WebSocket, Dexie/IndexedDB via a
SQLite shim, and a 4.4 MB embedded xNAV bootstrap cache.

## Target layout

One Cargo workspace at the repo root, replacing `src-tauri/` as the Rust root:

```text
Cargo.toml                 workspace
crates/
  ntr-core/                library: everything below the UI
    keys/                  mnemonic → master keys per wallet type, WIF, BIP32
    address/               NavCoin base58check address types
    blsct/                 BLS12-381 keys, transcript, output recovery, range proof
    tx/                    NavCoin tx (de)serialization, sighash, signing
    electrum/              async JSON-RPC client over TCP/TLS
    scan/                  port of rescue-scan.js
    wallet/                per-source state, balances, sweep (wallet-manager.js)
    registry/              sources.json, fingerprints (source-registry.js)
    appdata/               paths, auth cookie, daemon.json (app-data.js)
    daemon/                HTTP API + lifecycle (daemon.js)
  ntr/                     binary: `ntr` — CLI, TUI, `ntr start` daemon
  ntr-gui/                 binary: Tauri shell (moved from src-tauri/)
gui/                       static HTML/CSS/JS, no build step
fixtures/                  JSON test vectors generated from navcoin-js
docs/
```

Both binaries link `ntr-core`. `ntr-gui` keeps the "connect to a running
daemon, else start one" behaviour, but "start one" becomes running the
daemon in-process on a background thread rather than spawning a Node CLI.
`ntr-daemon-launch` and its PATH/bundled-runtime search are deleted.

The daemon stays an HTTP service on `127.0.0.1:46117` with the same
endpoints, auth cookie, and JSON shapes. That contract is what lets the CLI,
TUI and GUI be ported in any order and is what the existing
`test/daemon.test.js` asserts; it gets ported as Rust integration tests.

## Component mapping

| Today                          | Rust                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:http` daemon             | `axum` + `tokio`                                                                                                      | CORS echo-origin + `Authorization` cookie check as middleware                                                                                                                                                                                                                                              |
| `fetch` client                 | `ureq` (blocking, CLI) or `reqwest` (rustls)                                                                          | CLI calls are sequential; blocking is simpler                                                                                                                                                                                                                                                              |
| Electrum over `wss`            | Hand-rolled JSON-RPC over `tokio` + `tokio-rustls`, TCP/TLS ports                                                     | Verified: `electrum2.nav.community` answers on 40001 (tcp) and 40002 (ssl), Let's Encrypt cert, ElectrumX 1.16.0, protocol 1.4–1.5. No WebSocket needed. NavCoin-only methods (`blockchain.transaction.get_keys`, `blockchain.staking.get_keys`, `get_history` with `from_height`) are plain method names. |
| `blessed` + `chalk` TUI        | `ratatui` + `crossterm`                                                                                               | OSC 11 background probe is ~40 lines over raw crossterm, same as the JS did                                                                                                                                                                                                                                |
| secp256k1, BIP32, base58       | `secp256k1`, `bitcoin_hashes`, `bs58`, `hmac`/`sha2`/`pbkdf2`/`ripemd`                                                | BIP32 hand-rolled (~100 lines) or `bip32` crate; NavCoin addresses are custom either way                                                                                                                                                                                                                   |
| BIP39 / Electrum mnemonics     | `bip39` + `unicode-normalization`                                                                                     | Electrum-style seed (`navcash`) is pbkdf2 with a different salt; hand-rolled                                                                                                                                                                                                                               |
| `mcl-wasm` + `noble-bls12-381` | `bls12_381` (zkcrypto) with `group`/`ff`, `experimental` feature for hash-to-curve                                    | Pure Rust. Signatures are `H(m)·sk` on G2 with the standard DSTs; no pairing needed to sign, only to verify our own tx before broadcast (optional)                                                                                                                                                         |
| EIP-2333 key derivation        | Hand-rolled HKDF-based (~40 lines), tested against EIP-2333 vectors                                                   | `hkdf` crate                                                                                                                                                                                                                                                                                               |
| Dexie/IndexedDB SQLite wallet  | Not ported                                                                                                            | See Decisions: keys are re-derived from `sources.json`; scan results are a small JSON cache                                                                                                                                                                                                                |
| `indexeddbshim`, `websocket`   | Gone                                                                                                                  |                                                                                                                                                                                                                                                                                                            |
| `wallet-worker.js` subprocess  | `tokio::task::spawn_blocking` for derivation                                                                          | Same reason (keep the HTTP loop responsive), no process boundary                                                                                                                                                                                                                                           |
| Detached `ntr start`           | `std::process::Command` with `setsid`/double-fork on Unix, `DETACHED_PROCESS` + `CREATE_NEW_PROCESS_GROUP` on Windows | Port of `handleStart` in `cli.js`                                                                                                                                                                                                                                                                          |
| Svelte + Vite frontend         | Static HTML/CSS/JS in `gui/`, `frontendDist` pointed at it                                                            | Five views, ~900 lines; no bundler, no npm. See Decisions                                                                                                                                                                                                                                                  |
| `@tauri-apps/cli` via npm      | `cargo tauri` (`tauri-cli` installed with cargo in CI)                                                                | `beforeBuildCommand` removed                                                                                                                                                                                                                                                                               |
| `prettier` for JS              | `cargo fmt`, `cargo clippy`; prettier stays for markdown and the static GUI files                                     |                                                                                                                                                                                                                                                                                                            |

Every crate above is a new dependency and needs your sign-off per the
project rules; the list is the proposal.

## The hard part: replacing navcoin-js

This is what a rescue needs from `navcoin-js`, what each piece actually is,
and the traps found while reading the library. File references are into
`node_modules/@aguycalled/bitcore-lib/lib/` and `node_modules/navcoin-js/src/lib/`.

### Key derivation per wallet type (`wallet.js` `Load`, `SetMasterKey`, `NavCreateAddress`)

| Type            | Seed                                                                 | Address path                  |
| --------------- | -------------------------------------------------------------------- | ----------------------------- |
| `navcoin-js-v1` | BIP39 pbkdf2 → HMAC-SHA512("Bitcoin seed")                           | `m/44'/130'/0'/{c}/{i}`       |
| `coinomi`       | same (alias: Coinomi uses SLIP-44 130 at BIP44 account 0)            | `m/44'/130'/0'/{c}/{i}`       |
| `navpay`        | same                                                                 | `m/44'/0'/0'/{c}/{i}`         |
| `navcash`       | Electrum seed: pbkdf2(nfkd(m), "electrum"), version prefix `01`      | `m/{c}/{i}`                   |
| `navcoin-core`  | **BIP39 entropy bytes used directly as the BIP32 seed** (no pbkdf2)  | `m/0'/{c}'/{i}'` all hardened |
| `next`          | `sha256(utf8(mnemonic))` is the one and only private key; no HD walk | imported                      |
| private-key     | WIF, version `0x96`, also accepts `0xB5` (electrum alias)            | imported                      |

xNAV keys come from the same master (`transaction/blsct.js` `DeriveMasterKeys`):
`Transcript(mk.toBuffer()).getHash()` → EIP-2333 master → hardened children
`130' / 0' / {0' view, 1' spend}`. Trap: `HDPrivateKey.toBuffer()` returns
the **ASCII bytes of the base58 `xprv…` string**, not the 78-byte
serialization; for `navcoin-core` (a bare `PrivateKey`) it is the unpadded
big-endian scalar. Get this wrong and every xNAV balance silently reads as
zero.

Subaddresses (`DerivePublicKeys`): `t = Fr(Transcript["SubAddress", vk, acct(8 BE), index(8 BE)])`,
`spend = G·(t + sk)`, `view = spend·vk`, `hashId = ripemd160(sha256(spend))`.
The scan pool is 100 subaddresses on account 0.

### Addresses (`address.js`, `networks.js`)

All base58check with a sha256d checksum, no bech32. Mainnet versions: P2PKH
`0x35`, P2SH `0x55`, cold-staking v1 `0x15` (40-byte payload), cold-staking
v2 `0x24` (60-byte), xNAV `0x4921` — a two-byte version, big-endian — over
`view(48) || spend(48)` compressed G1 points. Trap: `CreateBLSCTOutput`
slices the xNAV payload at `1..49` / `49..` (an off-by-one that happens to
work in the JS); the Rust side must slice `0..48` / `48..96` and be
verified against a real `xN…` address.

### Transaction format (`transaction/transaction.js`, `output.js`)

Not Bitcoin's. `version(i32) nTime(i32) vin vout nLockTime`, then for
`version >= 2` a varint-prefixed `strdzeel` string, then `vchbalsig` if
`version & (0x10|0x20)`, then `vchtxsig` if `version & 0x10`. `0x10` is set
when any input spends a BLSCT output, `0x20` when any output is BLSCT, so an
xNAV sweep carries both. Sighash is legacy `sha256d(serialize || i32(type))`
byte-reversed, `SIGHASH_ALL`, no segwit. Outputs are tri-modal: plain
`u64 || script`, or a `0x80…flags` header selecting `satoshis, ek, ok, sk,
bulletproof, tokenId, nftId, vData`. Bulletproof wire order:
`V[] L[] R[] A S T1 T2 taux mu a b t`.

Cold-staking scripts use `OP_COINSTAKE (0xC6)`; v1 is the 14-chunk
`OP_COINSTAKE OP_IF … OP_ELSE … OP_ENDIF` form, v2 prepends `<voting> OP_DROP`.
xNAV outputs sit behind `OP_TRUE` with zero satoshis, which is why the scan
subscribes to `sha256(0x51)` as an anchor scripthash.

### xNAV read side — needed for balance (`transaction/blsct.js`, `crypto/blsct.js`)

- `Transcript`: custom sponge over sha256 with a hand-written padding step in
  `finalize()`. Must be ported byte-exactly; it feeds every challenge.
- `HashG1Element(el, salt) = sha256d([len] || el || reverse(be8(salt)))`.
- `GetHashId(out, vk)`: `t = ok·vk`, `dh = sk − G·Fr(HashG1Element(t, 0))`,
  `ripemd160(sha256(dh))`. Ownership needs the **view key only**.
- `RecoverBLSCTOutput`: `nonce = ok·vk`; derive `gamma, alpha, rho, tau1,
tau2` from `HashG1Element(nonce, 100|1|2|3|4)`; replay the challenge
  transcript over `V A S y z T1 T2 x taux mu t`; `excess = mu − rho·x − alpha`;
  amount is the low 8 bytes of `excess` big-endian; check
  `G·gamma + H·amount == V[0]`. No range-proof verification is required to
  read a balance.
- Memo decoding (including the AES-CBC long-memo path) is not needed for a
  sweep and is left out.

### xNAV write side — needed for the sweep

- `RangeProve`: 64-bit, up to 16 values, over 1024 hard-coded `Gi/Hi`
  generators plus `H` (`crypto/blsct.js` `Gens`, ~790 KB of Fp limbs). The
  prover is deterministic given the nonce: `sL = sR = 1`, blinding scalars
  come from the nonce, the memo is folded into `alpha`. Determinism is what
  makes it testable against JS output.
- `CreateBLSCTOutput`: random `bk`; `nonce = destView·bk`; `ek = G·bk`,
  `ok = destSpend·bk`, `sk = destSpend + G·Fr(HashG1Element(nonce, 0))`;
  output signature = AugSchemeMPL over `sha256d(output)` with key `bk`.
- Inputs: one AugSchemeMPL signature per input with the recovered spend key
  (`hash_t + sk + subaddress t`), aggregated into `vchtxsig`. Balance proof:
  BasicSchemeMPL signature of `"BLSCTBALANCE"` with key `Σγ_in − Σγ_out` into
  `vchbalsig`.
- Fee: `200000 · (nInputs + 2 + nDests)` satoshi as an explicit `OP_RETURN`
  output. NAV leg fee: flat `100000`. Dust `546`.
- The generator table is exported once from the JS (`Gens` → 2×1024 + 1
  compressed G1 points, under 100 KB) and committed as a binary fixture with
  `include_bytes!`.

### Persistence

The Dexie/IndexedDB-on-SQLite wallet files are not ported. Every key is
re-derivable from `sources.json` — which already holds mnemonics and WIFs
verbatim, mode `0600` — so the Rust daemon derives at startup and persists
only scan state (`wallets/<id>.json`: utxos with hex output, tx height/pos,
staking partners, sync marker). Existing `D_*.sqlite` files are deleted on
first run and the source re-scanned; `rescan` already does exactly this.

The bundled `xNavBootstrap` cache (4.4 MB JSON, 2,672 entries) is a
speed-up, not a correctness input. Embed it compressed with `include_bytes!`
and parse lazily on the first xNAV scan, or drop it and accept ~2.7k extra
`get_keys` round-trips at concurrency 25. Measure before choosing.

## Decisions needed

1. **GUI frontend.** (a) Static HTML/CSS/JS, no bundler — recommended: the
   views are small, the brand CSS carries over unchanged, and npm disappears
   from the build. (b) Keep Svelte with a Node build step only — fails the
   stated goal. (c) `iced`/`egui` Rust-native — removes the Linux webview
   dependency and makes every binary fully static, at the cost of rebuilding
   the UI and losing the CSS design. Recommend (a) now; (c) stays an option
   because the daemon contract makes the GUI replaceable.
2. **"Encrypted with `ObsidianSweepKey`" claim.** The README promises wallet
   state is encrypted under a static, public password. With no Dexie there is
   nothing to encrypt except the scan cache, and `sources.json` was never
   encrypted. Recommend dropping the claim and the constant, and saying
   plainly that the app-data directory is sensitive until `purge`. If the
   claim must stay, encrypt `wallets/*.json` with `aes-gcm` under the same
   constant — it is theatre either way.
3. **Bootstrap cache** — embed or drop (above).
4. **Binary shape.** Two binaries (`ntr`, `ntr-gui`) sharing one core —
   recommended. A single binary with `ntr gui` would make the CLI fail to
   load on Linux hosts without webkit2gtk, which is exactly the headless case
   the CLI exists for.
5. **New dependencies** — the crate list in the mapping table.

## Phases

Each phase has an exit criterion that is observable, not "code written".
Phases 1–3 need no network and are where the risk lives; do them first.

### 0. Test vectors from the JS (before touching anything)

A throwaway Node script under `fixtures/gen/` drives `navcoin-js` and
writes JSON:

- For each mnemonic type and a fixed test phrase: first 20 receive + 5
  change addresses with WIFs, the xNAV view/spend scalars, 10 subaddresses
  with hashIds. Plus WIF import for `0x96` and `0xB5` forms.
- Transcript and `HashG1Element` outputs for a handful of inputs.
- Real mainnet transactions containing xNAV outputs owned by the test
  wallet: raw hex → expected `hashId` and recovered amount per output.
- Deterministic `RangeProve` output for fixed `(nonce, values, memo)`.
- A NAV transaction: fixed inputs, keys, `nTime` → exact serialized hex and
  sighash per input.
- A full xNAV transaction with `bk` patched to fixed values → exact hex.
- The `Gens` generator table and `H` as compressed points.

Exit: fixtures committed; generator script kept until phase 9.

### 1. Workspace + `ntr-core::keys`, `address`

Root `Cargo.toml` workspace; move `src-tauri` to `crates/ntr-gui`. Implement
every wallet type, WIF, and every address type. Exit: fixture parity tests
green for all five wallet types; `cargo clippy --all-targets -- -D warnings`,
`cargo fmt --all`, `cargo test` on the workspace (the project's standing
rule).

### 2. `ntr-core::blsct` read side

EIP-2333, transcript, `HashG1Element`, `DeriveMasterKeys`,
`DerivePublicKeys`, `GetHashId`, `RecoverBLSCTOutput`; output and
bulletproof deserialization. Exit: every fixture xNAV output recovers to the
JS amount; EIP-2333 spec vectors pass.

### 3. `ntr-core::tx` + blsct write side

NavCoin tx (de)serialization, sighash, ECDSA signing, cold-staking script
building; `RangeProve` over the embedded generators; `CreateBLSCTOutput`,
input/balance signatures, aggregation. Exit: byte-exact fixture parity for
the NAV tx and the fixed-`bk` xNAV tx; a round-trip test deserializes every
fixture tx and re-serializes it identically.

### 4. Electrum client + scan engine

Async JSON-RPC client with id multiplexing, notifications, ping keepalive,
server rotation and the `NTR_ELECTRUM_NODES` override; a TCP stub server for
tests replacing the WebSocket stub in `test/test-helpers.js`. Port
`rescue-scan.js` phase for phase (receive/change gap walk, stake-discover,
stake, xnav-history, xnav, xnav-claim, reap) with the same progress events
and the same "no reap after failures" rule. Port `computeBalance`. Exit:
side-by-side run against the current JS daemon on the same test wallet
reports identical confirmed/pending NAV, xNAV and staked balances to the
satoshi; scan tests from `test/rescue-scan.test.js` and
`test/wallet-manager.test.js` ported.

### 5. Daemon

`appdata`, `registry`, `wallet` state machine (open/connect/reconnect
watchdog/rescan/close), `axum` server with the existing routes, CORS and
cookie auth, `daemon.json` lifecycle, log file, detach logic. Exit:
`test/daemon.test.js` ported and green; the JS CLI, unchanged, works against
the Rust daemon end to end.

### 6. Sweep

`prepareSweep`/`executeSweep` with the same gating (all synced, no errors,
exact destination re-entry, `SEND MY COINS`). Exit: a real small-amount
sweep on mainnet from a test wallet, NAV and xNAV legs, confirmed on chain —
the automated suite cannot cover broadcast. This is the release gate.

### 7. CLI + TUI

`ntr` with the same subcommands and output; `ratatui` TUI with the same
commands, tab completion, history, palette switch on terminal background.
Exit: manual walkthrough of every README command; `ntr start` detaches on
all three platforms.

### 8. GUI

Static frontend replacing the Svelte views; Tauri commands unchanged in
shape (`daemon_auth`, `ensure_daemon`, `read_log_tail`); `ensure_daemon`
runs the in-process daemon when the port is closed. Exit: `cargo tauri
build` on all targets; `ntr-gui --daemon-check` smoke passes on the shipped
binaries.

### 9. Remove Node, ship

Delete `src/`, `test/`, `package.json`, lockfiles, `gui/package.json`,
`svelte.config.js`, `vite.config.js`, `fixtures/gen/`. Rewrite
`.github/workflows/`: `cargo test` matrix, release matrix building `ntr`
(musl on Linux) and `ntr-gui`, archives containing the two binaries and a
README. Add `windows-arm64` and `macos-x86_64` back. Update `README.md`,
`DEVELOPMENT.md`, `PLAN.md` (platform limitations section goes away),
`CHANGELOG.md`. Cut the release per the usual BCTP flow and watch the run.

Relative size: phases 2–3 are the bulk (the crypto port and its fixtures),
phase 4 next (the scan engine is subtle and stateful), phases 5–8 are
mechanical ports, 0 and 9 are small.

## Verification strategy

- Parity fixtures are the primary check for everything cryptographic. A
  fixture test that passes before the code is written is not a test — each
  one is shown red first by corrupting one byte of expected output.
- The side-by-side balance run in phase 4 and the real sweep in phase 6 are
  the two checks that touch the network; both are recorded in `docs/backlog.md`
  as coverage gaps until run, with the wallet and block heights used.
- The daemon HTTP contract is asserted by the ported `daemon.test.js`, which
  is what lets the frontends be swapped independently.
- Platform-gated code (detach, console hiding, app-data paths) only gets its
  verdict from CI; local runs say nothing about it.

## Risks

- **Silent zero balances.** Any mismatch in transcript bytes, scalar
  endianness, or the `xprv`-ASCII trap makes ownership checks fail quietly.
  Mitigated by real-mainnet fixtures for xNAV outputs in phase 0.
- **Broadcast rejection.** A malformed range proof or signature only fails at
  broadcast. Mitigated by byte-exact fixture parity and by verifying our own
  proof and signatures locally (pairing check) before sending.
- **Electrum server drift.** Only `electrum2.nav.community` answered during
  the probe on 2026-08-27; the others were closed from here. The probe-and-
  rotate logic must survive a mostly-dead server list.
- **Pure-Rust BLS performance.** `bls12_381` is slower than `mcl`; the scan
  does one scalar multiplication per xNAV output candidate and the prover
  does a 1024-point multi-exponentiation per output. Both are well within a
  second on any target; measure in phase 2 and switch to `blst` only if it
  is not.
- **Tauri on Linux** is unchanged: the webview is still a system library.

## Out of scope

Same as `PLAN.md`: `wallet.dat`, tokens, NFTs, dotNav, testnet, memo
decoding, the P2P pool. Nothing in the migration adds features; the sweep
remains non-atomic across legs unless that is taken up separately.
