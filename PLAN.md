# navcoin-rescue-tool Plan

## Summary

Build a recovery-first CLI tool for legacy NavCoin wallets that can inspect
recoverable funds and sweep them to a new destination address. The first
implementation should use `navcoin-js` as the wallet and network backend
wherever possible.

CLI invocation should be `ntr` for short, frequent use.

## CLI Identity

- Repository/package name: `navcoin-rescue-tool`
- Executable command: `ntr`
- GUI executable command: `ntr-gui`

## Goals

- Accept legacy recovery material from users.
- Detect recoverable NAV balances for derived or imported addresses.
- Create and broadcast a sweep transaction to a user-supplied destination
  address.
- Keep the workflow simple, explicit, and safe for one-time recovery use.
- Support a daemon mode that keeps imported wallets in sync with the network.
- Provide a simple GUI for non-CLI users without duplicating wallet logic.
- Support Linux, macOS, and Windows.

## Platform Support

- MVP target platforms:
  - Ubuntu 22.04 or newer
  - macOS 12 or newer
  - Windows 10 or newer
- CLI, TUI, daemon, and GUI behavior should be planned so core workflows work on
  all three platforms.

## Expected Inputs

- Mnemonic phrases supported by `navcoin-js` wallet types:
  - `navcoin-js-v1`
  - `navcash`
  - `next`
  - `navcoin-core`
  - `navpay`
- Private keys that can be imported into `navcoin-js`

## MVP Scope

- MVP should only support recovery formats already supported by `navcoin-js`.
- That means mnemonic import for supported wallet types and private-key import.
- `wallet.dat` support is explicitly deferred until after MVP.

## Initial Non-Goals

- In-place modification of old wallet files
- Broad wallet format support beyond known NavCoin legacy flows
- xNAV, token, NFT, and dotNav recovery in the first recovery pass unless
  required later

## Proposed Phases

1. Create project skeleton and CLI entrypoint.
2. Add TUI entrypoint for default `ntr` invocation.
3. Wrap `navcoin-js` wallet creation for mnemonic-based recovery.
4. Add persistent wallet profile storage and naming.
5. Add daemon mode to keep imported wallets synced in the background.
6. Add private-key import recovery flow.
7. Add balance discovery and address reporting.
8. Add sweep transaction creation and broadcast.
9. Add safety checks:

- destination validation
- explicit two-step confirmation before broadcast

10. Add shared local daemon API for TUI and GUI clients.
11. Add simple GUI client for non-CLI users.
12. Add CI pipelines for cross-platform builds and artifacts.
13. Test against known legacy wallet samples and edge cases.

## Current Progress

- Completed: initial phase 1 scaffold.
- Implemented in repo:
  - Node project with `ntr` and `ntr-gui` executables
  - app-data path resolution for Linux, macOS, and Windows
  - initial on-disk layout bootstrap for `daemon.json`, `auth.cookie`,
    `sources.json`, `wallets/`, and `logs/`
  - long-lived localhost daemon bound to `127.0.0.1:46117`
  - auth-cookie protected `GET /status`
  - auth-cookie protected `POST /import`
  - auth-cookie protected `POST /remove`
  - auth-cookie protected `POST /daemon/stop`
  - `ntr start`, `ntr status`, and `ntr stop` wired to daemon lifecycle
  - `ntr import mnemonic` and `ntr import private-key` metadata flows
  - `ntr remove <source-id>` source removal flow
  - per-source persisted registry with fingerprint-based duplicate detection
  - richer `status` output with source ids, labels, types, and sync placeholders
  - repo `.gitignore` for dependencies, local artifacts, and scratch app data
- Verified:
  - unit tests for app-data path resolution and bootstrap
  - daemon auth and stop lifecycle test
  - daemon import persistence, duplicate rejection, and remove test
  - CLI smoke test for `ntr start`, `ntr status`, and `ntr stop`
  - CLI smoke test for `ntr import`, `ntr remove`, and per-source `status`
  - initial GitHub Actions CI workflow for format and test checks
- Next slice:
  - connect imported sources to per-source wallet database creation
  - define `navcoin-js` integration boundary for mnemonic and private-key
    imports
  - replace sync placeholders with real daemon-managed sync state
- Deferred to later slices:
  - TUI default flow
  - sweep implementation
  - full daemon HTTP API surface

## CI And Releases

- Use GitHub Actions for CI.
- CI should run automated tests on every relevant push and pull request.
- Initial CI scaffold now exists in `.github/workflows/ci.yml` and currently:
  - runs on push to `main`
  - runs on pull requests
  - runs on tags matching `v*`
  - checks formatting with `npm run format:check`
  - runs tests with `npm test`
  - uses workflow concurrency to cancel older runs for the same ref
- CI should build cross-platform artifacts for supported targets.
- CI should upload build artifacts for normal pipeline runs so they can be
  downloaded from the workflow.
- CI should use concurrency controls so a newer run cancels any older
  in-progress run for the same branch or version tag.
- If a git tag is pushed, CI should:
  - trigger on version tags matching `v*`
  - run the test suite first
  - build release artifacts after tests pass
  - create or update a GitHub release named from that tag
  - upload archive artifacts for macOS, Windows, and Linux to that release
- Release publication must only happen after the tagged build passes tests.

Example:

- Pushing tag `v0.0.1` should trigger CI.
- If CI passes, it should create a `v0.0.1` GitHub release.
- That release should contain archive artifacts for macOS, Windows, and Linux.

## Open Questions

- Which exact legacy wallet types do we need to support first?
- Do we need read-only balance inspection before requiring any spending
  password?
- Do we sweep only NAV first, or also support xNAV later?
- Should daemon mode track one wallet per process or all imported wallets in one
  process?
- Should daemon state be controlled with pid files, a local socket, or a small
  status file?

## First Implementation Direction

Start with the smallest useful persistent path:

1. daemon process with persistent local state
2. default `ntr` launches a TUI connected to daemon state
3. mnemonic import into daemon-managed wallet state
4. status command with full source, sync, address, and balance reporting
5. sweep NAV to a destination address with strict confirmation

After that, expand import coverage where needed, then solve `wallet.dat`
ingestion later.

## Shared Architecture

- Wallet logic should live in one core service layer backed by the daemon.
- `ntr`, the `ntr` TUI, and `ntr-gui` should all use the same daemon-managed
  state and command paths.
- The daemon should own:
  - imported sources
  - sync state
  - address discovery
  - balances
  - sweep creation
  - broadcast
  - persistence
- UI layers should only:
  - render state
  - collect user input
  - invoke daemon commands
  - display confirmations, progress, and errors

## Persistence Direction

- Use `navcoin-js` persistence internals for wallet state instead of replacing
  them.
- For Node-based operation, this means using the `navcoin-js` database backend
  it already uses for persistent wallet data.
- Store each imported source in its own `navcoin-js` wallet database.
- The daemon should aggregate state across those per-source wallets.
- Keep `ntr`-specific persistence separate and limited to daemon/app metadata.

### Wallet State Stored By `navcoin-js`

- imported mnemonic or private-key material
- derived addresses and keys
- sync cache and script-history state
- wallet transaction history
- UTXOs and spend state
- wallet settings and counters

### Daemon/App Metadata Stored By `ntr`

- source registry
- source ids and labels
- mapping from source ids to wallet database names
- daemon runtime metadata
- daemon auth cookie metadata
- local API or lock metadata if needed
- UI preferences if added later
- On-disk daemon/app metadata should use a simple JSON format.

### On-Disk Layout

- Use a simple app-data directory layout like:

```text
<navcoin-rescue-tool app data>/
  daemon.json
  auth.cookie
  sources.json
  wallets/
    <source-id>.db
  logs/
    daemon.log
```

- `daemon.json` should store daemon runtime and discovery metadata.
- `auth.cookie` should store the daemon-generated local API auth cookie.
- `auth.cookie` should use `0600` permissions on platforms that support those
  file permissions.
- `sources.json` should store the source registry and source-to-wallet mapping.
- `wallets/` should store one `navcoin-js` wallet database per source.
- `logs/` should store daemon logs.

### Source Model

- One imported source should map to one `navcoin-js` wallet database.
- The daemon should not merge all imports into one shared `navcoin-js` wallet.
- Aggregation should happen at the daemon/service layer instead.
- This keeps source removal, source reporting, and source-level sync status
  cleaner and safer.
- Source ids should be fingerprint-based so importing the same source again can
  be detected as a duplicate.
- Use the fingerprint-derived source id for source tracking, duplicate
  detection, and wallet database naming.
- Source fingerprints should be derived by hashing normalized source details
  with SHA-256.
- For mnemonic or private-key imports, the fingerprint should be based on the
  normalized imported details, not transient UI or file metadata.
- Mnemonic normalization should split into words and then re-join using
  `.join("\n")` so the canonical mnemonic representation is consistent.
- If multiple private keys are imported together, they should be sorted by value
  before fingerprinting so the fingerprint is stable.
- Wallet type should be included in the fingerprint input so the same mnemonic
  can be imported and tested against multiple wallet types without colliding.
- For future `wallet.dat` support, fingerprinting should hash the extracted
  wallet details, not the raw wallet file bytes.
- If an imported source fingerprint already exists, import should stop with a
  duplicate-source error.

### Corruption And Partial-Failure Handling

- If one imported source wallet becomes unreadable or corrupted, the daemon
  should continue operating with the remaining healthy sources.
- `status` should clearly show the broken source and its error state.
- `remove` should still allow removing a broken source.
- `import` should still be allowed while another source is broken.
- `sweep` must be blocked if any imported source is broken, unreadable, or not
  fully available.

### Wallet Encryption Policy

- `navcoin-js` wallet persistence should use one static password for all
  imported sources in this tool.
- This tool is recovery/sweep focused, so the static password is meant to keep
  implementation simple and consistent across imported sources.
- Static wallet password for MVP: `ObsidianSweepKey`

### Local Storage Warning

- After every successful import, show a warning that the imported wallet is now
  stored locally.
- Default local storage location should use the platform app-data directory:
  - Linux: `~/.local/share/navcoin-rescue-tool/`
  - macOS: `~/Library/Application Support/navcoin-rescue-tool/`
  - Windows: `%APPDATA%\navcoin-rescue-tool\`
- The warning should explicitly show:
  - the local storage path for that imported source
  - the static wallet password in use
- Import warning text should make it clear that the user should treat local disk
  access as sensitive until the sweep is complete and local wallet data is
  removed.
- The tool is recovery-focused and does not need a strict log-redaction policy
  for post-recovery secrecy assumptions.

## Local API Direction

- Add a local-only IPC/API between the daemon and user interfaces.
- Prefer a localhost-only HTTP API for simplicity and shared use across CLI,
  TUI, and GUI.
- Do not depend on Unix-only IPC assumptions so the same model works on Windows.
- Use JSON request and response payloads.
- Keep the API REST-ish, with resource-style endpoints.
- Exact request and response schemas can be finalized during implementation.
- Bind the local API to `127.0.0.1` only so it is not reachable from the
  network.
- Use fixed daemon port `46117`.
- If port `46117` is already in use, daemon startup should fail with a clear
  error telling the user that something is already using the port.
- On daemon start, generate a local auth cookie and write it to `auth.cookie` in
  the app data directory.
- `ntr`, the TUI, and `ntr-gui` should read that cookie file and use it when
  calling the daemon API.
- The daemon should require the auth cookie for local API access.
- Clients should send the auth cookie as `Authorization: <cookie>`.
- Daemon discovery should use a simple HTTP request to the local daemon
  endpoint.
- The daemon should expose a status endpoint that clients can call to confirm it
  is running and get current daemon status.
- Initial API shape should cover:
  - `GET /status`
  - `POST /import`
  - `POST /remove`
  - `POST /sweep/prepare`
  - `POST /sweep/confirm`
  - `POST /daemon/stop`

## Initial CLI Shape

```bash
ntr
ntr start
ntr stop
ntr import
ntr remove
ntr status
ntr sweep <address>
```

Notes:

- Running `ntr` with no arguments should launch a TUI.
- The TUI should support the same user actions as the top-level commands:
  - import
  - remove
  - status
  - sweep
- The TUI input should support command auto-complete while typing.
- Pressing `Tab` should select the top matching completion.
- The TUI layout should stay minimal:
  - main window for rendered output
  - bottom line for command input
- If a daemon is running, the TUI should connect to it and show current state.
- If no daemon is running, `ntr` should start it automatically and then connect
  the TUI to it.
- `ntr start` runs the long-lived daemon.
- Daemon start/stop/status behavior must work consistently on Linux, macOS, and
  Windows.
- The tool is mainnet-only for now because NavCoin testnet is not currently
  reliable enough to support the intended workflow.
- `ntr import`, `ntr remove`, `ntr status`, and `ntr sweep` require the daemon
  to already be running and should error clearly if it is not.
- `ntr import` should support mnemonic first, with wallet type selection for
  `navcoin-core`, `navcash`, `next`, `navpay`, or `navcoin-js-v1`.
- `ntr remove` should remove one imported source from daemon-managed state.
- `ntr status` should be the full human-readable report and include:
  - every imported source
  - every derived or imported address
  - every address balance
  - addresses shown regardless of whether balance is zero
  - per-source sync state
  - whether each source is caught up to current known network head
  - total confirmed, unconfirmed, staked, and sweepable balances
  - current connected server and last sync information
- `ntr sweep <address>` should always require interactive confirmation.

## GUI Shape

```bash
ntr-gui
```

Notes:

- `ntr-gui` should be a thin client over the same daemon/API used by `ntr`.
- Build `ntr-gui` with Electron.
- `ntr-gui` should auto-start the daemon if it is not already running, then
  connect to it.
- Plan packaging and launch behavior for Linux, macOS, and Windows.
- The GUI should preserve the same recovery and safety model as the CLI and TUI.
- Do not implement separate wallet logic in the GUI.
- The GUI should use normal desktop controls like buttons, forms, and tables,
  not a terminal-emulation view.
- The GUI should match the TUI workflow and safety rules, but not copy the TUI
  visual presentation.

### Packaging Direction

- Produce cross-platform builds for:
  - Linux
  - macOS
  - Windows
- Target architectures for release artifacts:
  - `x86_64`
  - `arm64`
- Package `ntr-gui` with Electron build tooling for those targets.
- Release outputs should be simple archives, not installers.
- Release archives should be standalone and contain everything needed to run the
  app on the target platform.
- End users should not need Node.js installed to run the packaged app.
- Release archives should bundle the required runtime and production
  dependencies needed to run `ntr-gui`, `ntr`, and the daemon.
- Ensure `ntr` and daemon launch paths work correctly when installed from GUI
  bundles and from CLI-oriented distributions.
- macOS release archives should include a README with instructions for removing
  quarantine attributes if macOS blocks the app after download.

### Artifact Naming

- Use this artifact naming pattern:
  - `navcoin-rescue-tool-${version}-${platform}-${arch}.${ext}`
- Examples:
  - `navcoin-rescue-tool-v0.0.1-linux-x86_64.tar.gz`
  - `navcoin-rescue-tool-v0.0.1-linux-arm64.tar.gz`
  - `navcoin-rescue-tool-v0.0.1-macos-x86_64.zip`
  - `navcoin-rescue-tool-v0.0.1-macos-arm64.zip`
  - `navcoin-rescue-tool-v0.0.1-windows-x86_64.zip`
  - `navcoin-rescue-tool-v0.0.1-windows-arm64.zip`
- Use platform names:
  - `linux`
  - `macos`
  - `windows`
- Use architecture names:
  - `x86_64`
  - `arm64`
- Publish one checksum file per artifact instead of one combined checksum file.
- Checksum file naming should mirror the artifact name, for example:
  - `navcoin-rescue-tool-v0.0.1-linux-x86_64.tar.gz.sha256`
- Archive layout should place `ntr`, `ntr-gui`, and `README` at the top level of
  the extracted archive.

### GUI Layout

- Keep the GUI simple and close in spirit to the TUI.
- Suggested layout:
  - left sidebar for main actions/views
  - main panel for rendered content
  - bottom status bar for daemon and sync state

### GUI Views

- `Status`
  - overall totals
  - daemon status
  - connected server
  - network head and sync progress
  - imported sources list
  - addresses and balances table
- `Import`
  - source type selector
  - mnemonic/private key input
  - wallet type selector for mnemonic import
  - import action and result output
- `Remove`
  - source list
  - remove preview
  - confirmation action
- `Sweep`
  - destination entry
  - exact destination re-entry
  - final sweep preview
  - required final phrase confirmation

### GUI Safety Rules

- The GUI must preserve the exact same sweep confirmation guarantees as the CLI.
- A GUI sweep should still require:
  - exact destination re-entry
  - explicit `SEND MY COINS` confirmation
- The GUI should disable final sweep submission until all confirmations are
  satisfied.

## Sweep Confirmation

- Step 1: user runs `ntr sweep <address>`.
- Sweep should only be allowed when all imported sources are fully synced to the
  current known network head.
- Sweep behavior should be simple: attempt to send the full movable balance.
- The only balance left behind should be dust or funds that cannot be moved
  because they are insufficient to cover fees.
- Step 2: tool requires the user to enter the exact same destination address on
  standard input.
- Step 3: tool shows final sweep overview:
  - destination address
  - total coins to be sent
  - fee
  - final net amount
- Step 4: tool requires the user to type `SEND MY COINS` exactly before
  broadcasting.

## Testing Strategy

Automated tests should use mocked wallet and network behavior only. Do not
depend on public mainnet or live Electrum infrastructure in the automated test
suite.

### Core Automated Flow Tests

1. Single input wallet full flow:
   - mocked source import
   - import source
   - wait for scan to complete
   - verify `status` shows funded addresses and synced state
   - sweep to destination
2. Two input sources full flow:
   - mocked multi-source import
   - import both
   - wait for both scans to complete
   - verify multi-source reporting and total aggregation
   - sweep combined balance to destination

### Additional High-Priority Tests

1. Empty wallet import:
   - scan completes
   - no balances found
   - sweep blocked with clear message
2. Wrong network:
   - source and daemon networks do not match
   - no false balances reported
   - mismatch is visible in status or import handling
3. Duplicate import:
   - same mnemonic or private key imported twice
   - no duplicate balance counting
   - explicit rejection or dedupe behavior verified
4. Remove source:
   - import multiple sources
   - remove one source
   - balances and address reporting update correctly
5. Restart persistence:
   - import and sync source
   - stop daemon
   - start daemon again
   - state and sync progress restore correctly
6. Sweep confirmation safety:
   - wrong destination re-entry aborts sweep
   - wrong final phrase aborts sweep
   - nothing is broadcast on aborted confirmation
7. Sweep amount and fee handling:
   - final sent amount equals total minus fee
   - no unexpected leftover spendable balance remains
8. Multi-source sweep correctness:
   - sweep consumes funds from all imported sources correctly
   - no source is omitted or double counted
9. Sync state reporting:
   - status before sync complete
   - status during sync
   - status after sync
   - fully synced indicator only flips when caught up to network head
10. Address reporting:
    - status lists every derived or imported address
    - balances are attached to correct addresses
    - totals equal sum of per-address balances
11. Import validation:
    - invalid mnemonic
    - unsupported type
    - malformed private key
    - no broken persisted state after failure
12. Daemon required commands:
    - `import`, `remove`, `status`, and `sweep` without daemon
    - each returns a clear error
13. Source isolation:
    - status identifies which addresses belong to which source
    - remove and sweep logic respect source boundaries
14. Idempotent status:
    - repeated `status` calls do not mutate state
    - no duplicate addresses or sources appear over time
15. Staked or non-sweepable funds:
    - status reports them distinctly
    - sweep either excludes them correctly or explains why it cannot proceed

### Test Layers

- Unit tests for:
  - source parsing and validation
  - dedupe logic
  - balance aggregation
  - sync-state aggregation
  - sweep confirmation flow
  - daemon state transitions
- Mock-driven command and daemon tests for:
  - daemon lifecycle
  - import and sync flows
  - status rendering inputs
  - sweep behavior
  - persistence across restart

### Mock Design

- Mock the `navcoin-js` boundary instead of mocking internal application logic.
- Feed deterministic wallet snapshots, address discovery results, sync progress,
  network head updates, and transaction creation results into tests.
- Use fixtures to represent:
  - empty wallets
  - single-source funded wallets
  - multi-source funded wallets
  - duplicate imports
  - wrong-network imports
  - partially synced wallets
  - staked and non-sweepable balances
  - sweep transaction success and failure cases

### Manual Post-MVP Testing

- After MVP is complete, do manual end-to-end testing with real coins.
- Keep this outside the automated test suite.
- Use manual live-fund testing to validate real network sync, balance discovery,
  and final sweep behavior.

### Wallet-Type Coverage

Add mocked fixture coverage over time for mnemonic types supported by
`navcoin-js`:

- `navcoin-core`
- `navcash`
- `next`
- `navpay`
- `navcoin-js-v1`
