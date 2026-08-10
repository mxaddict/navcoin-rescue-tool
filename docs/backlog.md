# Backlog

Work raised but not finished, and what was deliberately left alone. Delete an
entry when it ships — `git log` is the history.

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
