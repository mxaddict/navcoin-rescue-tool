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
- The import path was reviewed again after the group import landed:
  `source-registry.js`, `mnemonic.js`, `constants.js`, the `/import` and
  `/status` handlers, `navcoin-js-adapter.js`, `cli.js`, `tui.js` and
  `gui/src`. `wallet-manager.js` and `rescue-scan.js` were read only for
  how they behave with several sources per phrase, not reviewed as a
  whole.
- Reviewed for correctness in an earlier pass: `daemon.js`, `app-data.js`,
  `source-registry.js`, `daemon-client.js`, `navcoin-js-adapter.js`,
  `wallet-worker.js`, `wallet-manager.js`, `rescue-scan.js`, `cli.js`,
  `src-tauri/src/lib.rs`. Skimmed only: `tui.js` rendering internals and the
  Svelte views under `gui/src` — their daemon wiring was read, their UI logic
  was not.

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
- Partly fixed: import-time validation now rejects a bad phrase with a
  message that never contains it, so the reported case no longer reaches
  the log. Still open: any other failure from `createImportedWallet` falls
  through to `navcoin-js import failed: ${raw}`, and a waived
  `navcoin-core` import can still reach that path. The log is also still
  created 644 while `sources.json` and `auth.cookie` are 600. Existing logs
  stay readable until wiped by hand.

## Group import: known consequences

- Importing one mnemonic now builds a wallet per derivation (three for a
  valid 12-word BIP39 phrase, four for 24 words), each with its own
  `RECOVERY_MIN_POOL_SIZE` address pool and its own electrum sync. Import
  and first sync therefore take roughly N times as long and N times the
  disk as before. Measured only in the test suite, where the real-adapter
  case in `test/source-registry.test.js` builds three wallets; not
  measured against a real electrum server.
- Sources imported by an earlier build have a `walletType` that is a
  user-facing alias (`coinomi`) and no `importId`. `importSources` skips
  any prepared source whose fingerprint already exists, so re-importing
  such a phrase adds the derivations it is missing rather than failing —
  but the pre-existing source keeps its alias label and stays outside the
  group. Nothing migrates it; verified only by reading the code.
- `sources.json` now holds the same phrase once per derivation, in
  `normalizedDetails` on every source of the group. Same file, same 0600
  mode, more copies of the secret.
- Two `POST /import` calls for different phrases that overlap can lose
  one: `importSources` reads `sources.json`, awaits wallet creation, then
  writes the whole array back, so the later write wins. The daemon's
  import returns before the wallets are built, which keeps the window
  small. Not reproduced, and no client issues concurrent imports today.
- `explainNoEligibleWalletType` ends in a fallback that cannot be
  reached — navcash has no word-count rule and its check returns a
  boolean, so it always contributes a checksum error for a phrase no
  derivation accepted. Kept so the function is guaranteed to return an
  Error rather than `undefined`.

## Dependency majors not taken

- Held back on 2026-08-28 because each is a breaking change across build
  tooling that CI exercises on four platforms, and the Windows toolchain is
  already pinned (see below): `chalk` 5 -> 6, `cross-env` 7 -> 10,
  `@babel/runtime` 7 -> 8 (root), `vite` 5 -> 8 and
  `@sveltejs/vite-plugin-svelte` 4 -> 7 (gui). The two gui ones have to move
  together. Everything within range was updated.

## Findings not fixed

- `rescueScan` accepts a `skipXNav` option that no caller sets. Either wire it
  to something or drop it; leaving it means an untested path.
- `tui.js` carries dead code: `tabComplete` (around line 186) has no caller,
  and two `break` statements sit after `process.exit(0)`. Re-verified
  2026-08-28. The earlier claim here that `createRequire` was unused was
  wrong — it is what loads `blessed`.
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
