# Backlog

Work raised but not finished, and what was deliberately left alone. Delete an
entry when it ships — `git log` is the history.

## Rust migration

- Full plan in `docs/rust-migration.md` (2026-08-27). Open decisions it needs
  before phase 1: GUI frontend (static JS vs Rust-native), whether to keep the
  `ObsidianSweepKey` encryption claim, embed vs drop the xNAV bootstrap cache,
  and sign-off on the proposed crate list. Not started.

## Stale daemon after upgrade, CLI and TUI halves

- The GUI half shipped: `/status` reports `version` and `ensure_daemon`
  replaces a daemon that reports a different one. `daemon-client.js` and the
  TUI's `ensureDaemonRunning` still reuse whatever is on the port without
  looking at the version, so `ntr` run from a checkout that has moved on keeps
  driving the old daemon. Same fix shape: compare against `APP_VERSION` from
  `src/constants.js` and offer a restart. Left out of the GUI change to keep it
  reviewable — the CLI can prompt, which the GUI's headless `--daemon-check`
  path cannot.

## Coverage gaps

- The release smoke tests drive daemon start/stop through the CLI wrappers and
  `ntr-gui --daemon-check`. They do not import a wallet, sync, or sweep, so a
  break in the wallet path still only shows up in the unit tests and manual
  runs.
- `ntr-gui --daemon-check` exercises `ensure_daemon`; it never opens a window,
  so nothing in CI proves the webview loads on any platform.
- Reviewed for correctness in this pass: `daemon.js`, `app-data.js`,
  `source-registry.js`, `daemon-client.js`, `navcoin-js-adapter.js`,
  `wallet-worker.js`, `wallet-manager.js`, `rescue-scan.js`, `cli.js`,
  `src-tauri/src/lib.rs`. Skimmed only: `tui.js` rendering internals and the
  Svelte views under `gui/src` — their daemon wiring was read, their UI logic
  was not.

## Mnemonic checksum is never validated at import

Investigated 2026-08-27 after a 24-word phrase failed with
`navcoin-js import failed: Mnemonic string is invalid: <phrase>`.

What was verified:

- The phrase's BIP39 checksum is genuinely wrong. Recomputing it by hand
  from the wordlist indices gives an expected checksum byte that does not
  match the one the words encode. All 24 words are in the English list, so
  the failure is a checksum, not an unknown word.
- Exactly one word is off: swapping the last word for its neighbour two
  entries along in the wordlist makes `Mnemonic.isValid` return true. Eight
  of the 2048 words complete that 23-word prefix validly; the one adjacent
  to the typed word is the obvious candidate. A single-letter transcription
  slip fits.
- Which types reject it and which do not, read from `wallet.js` in
  navcoin-js and confirmed by running them: `navcoin-js-v1`, `coinomi`,
  `navpay` and `next` all go through `new Mnemonic(phrase)`, whose
  constructor calls `Mnemonic.isValid` and throws. `navcoin-core` goes
  through `Mnemonic.mnemonicToData`, which slices the checksum bits off and
  never compares them, so it accepts any wordlist-valid phrase.
  `navcash` uses Electrum's own scheme and never sees a BIP39 checksum.
- That is why the same phrase "works" in navio-core and in this tool's
  `navcoin-core` type: neither validates. It is not evidence the phrase is
  right.
- The types do not derive the same keys. Loading one 24-word phrase under
  `navcoin-js-v1`, `navpay` and `navcoin-core` gives three different sets of
  receiving addresses. Importing under `navcoin-core` to get past the
  checksum error therefore scans the wrong wallet and will report no funds,
  which reads as "the phrase is wrong" rather than "the type is wrong".

Not fixed, needs a decision:

- `validateImportInput` in `source-registry.js` checks the source type, the
  wallet type and a word count of at least 12. It does not check the BIP39
  checksum, so a bad phrase is accepted, written to `sources.json`, and only
  fails later in the background worker. Validating at the boundary would
  catch the typo at the point the user can still fix it — but it has to be
  conditional on the wallet type, because `navcoin-core` and `navcash`
  legitimately accept phrases that fail a BIP39 check. A blanket check would
  lock out the Core users this tool exists for.
- Worth considering alongside it: when a phrase fails the checksum, the
  words are all valid and usually only one is wrong, so the single-word
  correction can be computed and offered.

## The daemon log records mnemonics in cleartext

- `createImportedWallet` in `navcoin-js-adapter.js` translates the
  "cannot read properties of undefined" failure into a wallet-type hint, but
  every other failure falls through to
  `navcoin-js import failed: ${raw}`. bitcore-mnemonic's `InvalidMnemonic`
  puts the whole phrase in its message, so `daemon.js` writes the user's
  seed phrase into `logs/daemon.log`.
- The log file is created mode 644, unlike `sources.json` and `auth.cookie`
  which are 600. Confirmed on this machine 2026-08-27: the log was
  world-readable and held the phrase on 12 lines.
- Two separate fixes: redact the phrase before logging (the adapter knows it
  is handling a mnemonic), and create the log 600 like the other files.
  Neither is done. Existing logs stay readable until wiped by hand, so the
  fix does not clean up after itself.

## Findings not fixed

- `rescueScan` accepts a `skipXNav` option that no caller sets. Either wire it
  to something or drop it; leaving it means an untested path.
- `tui.js` carries dead code: `tabComplete` has no caller, `createRequire` is
  imported and unused, and several `break` statements sit after
  `process.exit(0)`. Left alone to keep the daemon-launch fix reviewable.
- The daemon compares the auth cookie with `!==`, which is not constant-time.
  It listens on loopback only and the cookie file is `0600`, so this is a
  hardening item rather than a live hole.
- `handleStatus`/`handleShow` in `cli.js` and several TUI commands report any
  failure as "No running daemon found", including real errors from a daemon
  that is running. Misleading when the daemon answers but the request fails.
- Balance reporting treats anything with one confirmation as spendable
  (`computeBalance`), deliberately diverging from navcoin-js. Documented in the
  function's comment; noted here because it surprises anyone comparing against
  `navcoin-cli` output.

## Windows CI is pinned to the VS2022 image

The npm jobs and the Windows release build run on `windows-2022`, not
`windows-latest`. `windows-latest` is now `windows-2025-vs2026`, and the
toolchain fails there in two independent ways:

- The node-gyp npm bundles (11.5.0) calls the installed Visual Studio an
  "unknown version" — it finds VS18 in Program Files and does not recognise
  it. Only node-gyp 12+ recognises VS2026, and
  node-pre-gyp (sqlite3's installer) ignores `npm_config_node_gyp` and runs
  npm's bundled copy, so the only way to change it is to upgrade npm.
- npm 12, which bundles node-gyp 13, then installs nested copies of native
  packages without running their build scripts: `bcrypto` under
  `@aguycalled/bitcore-lib` and `sqlite3` under `websql-configurable` both
  end up without bindings, and every wallet test fails on load.

A third npm 12 change matters for anyone who upgrades locally: it refuses
git-protocol dependencies by default (`EALLOWGIT`), and indexeddbshim pulls
sync-promise from GitHub. `allow-git=all` in `.npmrc` fixes that, but npm 11
warns about the unknown key on every command, so it is not committed.

Re-check when npm ships a fix for the nested build scripts, or when the
image gains a node-gyp-compatible VS. Until then `windows-2022` retiring is
the thing that will force this open. The Rust `daemon-launch` job and the
release archive smoke test do run on `windows-latest`, so the artifact
users actually run is still covered on the current OS.

## Decisions

- Daemon-launch logic lives in its own crate (`src-tauri/daemon-launch`) with
  no Tauri dependency, so its tests run on any machine and in CI without a
  webview toolkit installed. The alternative — testing it inside `ntr-gui` —
  needs webkit2gtk on Linux just to compile.
- A tagless `workflow_dispatch` of `Release` builds and smoke-tests without
  publishing. Considered and rejected: running the full build + smoke matrix on
  every PR, which would add four platform builds of the Tauri app to every
  push.
