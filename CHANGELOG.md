# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The daemon reports the version it was started from as `version` on `/status`,
  and writes it to the log on startup (`daemon started pid=… version=…`).

- Mnemonics are checked before they are accepted. `assertMnemonicAccepted`
  in the new `src/mnemonic.js` runs from `validateImportInput`, which every
  front end reaches through the daemon, so the CLI, TUI and GUI all reject
  the same phrases. Types that derive through a bitcore Mnemonic
  (`navcoin-js-v1`, `coinomi`, `navpay`, `next`) require a valid BIP39
  checksum; `navcash` is checked against the Electrum seed scheme instead.
  Previously a phrase with a mistyped word was accepted, written to
  `sources.json`, and only failed later in a background worker.
- `navcoin-core` requires the BIP39 checksum too, because it derives from
  the raw entropy without reading the checksum and so would silently derive
  a different wallet from a phrase with a wrong word. Because that is also
  the only type that can import a genuinely non-BIP39 phrase, the check is
  waivable there: `ntr import mnemonic --allow-unchecked-mnemonic`, a
  confirm prompt in the TUI, and a checkbox in the GUI shown only after a
  waivable rejection.
- `navcoin-core` also requires exactly 24 words. It uses the BIP39 entropy
  itself as the master key and a bitcore PrivateKey is 32 bytes, which only
  a 24-word phrase yields. A shorter phrase used to be accepted and then
  died deriving addresses in a background worker with "Cannot read
  properties of undefined". This one is never waivable.
- Import failures carry a `code` (and `waivable`) alongside the message, so
  a client can recognise a checksum rejection without matching on text.

### Changed

- Importing a mnemonic no longer asks which wallet it came from. One phrase
  now imports as a group: a single import id and one source per derivation
  the phrase can belong to, each with its own wallet, so Status reports which
  derivation actually holds funds. Nobody reliably remembers which app
  produced a phrase years ago, and picking wrong reported an empty wallet —
  indistinguishable from having no coins. `importSource` in
  `src/source-registry.js` is now `importSources` and returns
  `{ importId, sources }`; `POST /import` returns the same shape in place of
  `{ source }`. Removal, sync and sweep are unchanged: each derivation is an
  ordinary source.
- `ntr import mnemonic` no longer takes `--wallet-type`, the TUI no longer
  prompts for one, and the GUI's type picker is replaced by a note listing
  what the import covers. Aliases collapse into the type they alias, so a
  phrase is never derived twice at the same path: `coinomi` imports as
  `navcoin-js-v1`.
- The waiver still narrows the group rather than widening it. A 24-word
  phrase that fails its BIP39 checksum can only be a `navcoin-core` wallet,
  so `--allow-unchecked-mnemonic` (and its TUI prompt and GUI checkbox)
  imports that one derivation alone.
- Rejection messages no longer repeat the phrase. bitcore-mnemonic's
  `InvalidMnemonic` embeds the whole mnemonic in its message, which the
  daemon wrote to `logs/daemon.log`.

### Fixed

- GUI: a daemon left running from an older build is now replaced instead of
  reused. The daemon detaches and outlives the app that started it, so after an
  upgrade the port was still held by the previous version and the GUI kept
  talking to it — a wallet type added in the new release came back as
  "Unsupported wallet type" with nothing to say why. `ensure_daemon` now reads
  the daemon's version from `/status`, and on a mismatch stops it, waits for the
  port, and starts its own. A daemon that does not answer or that refuses the
  auth cookie is left alone rather than assumed stale.

## [0.1.2] - 2026-08-27

### Added

- `coinomi` mnemonic wallet type for `import` in the CLI, TUI, GUI and daemon.
  Coinomi derives NavCoin from a standard BIP39 seed at BIP44 `m/44'/130'/0'`,
  the same scheme as `navcoin-js-v1`, so the type is an alias:
  `getDerivationWalletType` in `src/constants.js` maps it before the wallet is
  created, and the source fingerprint uses the derivation type so the same
  phrase cannot be imported twice under both names.

## [0.1.1] - 2026-08-10

### Fixed

- GUI: released builds could not start the daemon. `ensure_daemon` tried `ntr`
  on PATH and then a checkout path baked in at compile time, which on a release
  build points at the CI runner's scratch directory — Windows users saw
  "failed to spawn daemon (ntr on PATH: program not found; node
  D:\a\navcoin-rescue-tool\...\src/cli.js: program not found)". The GUI now
  looks first for the Node runtime and CLI bundled beside its own binary, falls
  back to a build checkout only when that path exists on this machine, and
  finds `ntr` on PATH including npm's Windows `ntr.cmd` shim (which
  `CreateProcess` cannot run directly). Spawned processes no longer flash a
  console window on Windows.
- Scan: a failed Electrum lookup no longer causes live UTXOs to be marked
  spent. `reapStaleUtxos` treats "not seen this scan" as "spent on chain", so a
  transient `getHistory`/`listunspent` error used to hide coins from the sweep,
  and the db kept them marked spent. The reap is now skipped when any lookup in
  the scan failed.
- `ntr start` could hang forever. It held the detached daemon's handle on the
  failure path, so once readiness timed out the CLI printed its error and never
  exited — reproducible on any machine where the daemon takes more than a
  moment to boot. The handle is released up front now.
- `ntr start` and the TUI gave the daemon 3s and 5s respectively to come up,
  and the TUI killed it after that. Booting loads navcoin-js and its native
  dependencies, which regularly takes longer on a cold machine; both now wait
  `DAEMON_READY_TIMEOUT_MS` (60s).
- `sources.json`, which stores imported mnemonics and WIF keys verbatim, is now
  written `0600` like `auth.cookie` instead of inheriting the default umask.
- The daemon's `EADDRINUSE` message and the TUI's port-in-use hint print the
  configured port instead of a hardcoded `46117`, which was wrong whenever
  `NTR_DAEMON_PORT` was set.

### Added

- `ntr-gui --daemon-check`: start the daemon the way the window does and exit
  with the verdict instead of opening a UI. Used by the release smoke tests.
- Release smoke tests: every archive (Linux x86_64/arm64, macOS arm64, Windows
  x86_64) is unpacked on a runner with Node stripped from PATH, then driven
  through the CLI wrappers and `ntr-gui --daemon-check`, so a release that is
  not self-contained fails before it publishes.
- CI runs the daemon-launch tests on Linux, macOS and Windows.
- `Release` can be dispatched with no tag to build and smoke-test a ref without
  publishing anything.

[Unreleased]: https://github.com/mxaddict/navcoin-rescue-tool/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/mxaddict/navcoin-rescue-tool/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mxaddict/navcoin-rescue-tool/compare/v0.1.0...v0.1.1
