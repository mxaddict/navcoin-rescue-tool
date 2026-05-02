# navcoin-rescue-tool Plan

Forward-looking work and reference spec. Implemented behavior lives in
`README.md` and `DEVELOPMENT.md`.

## Summary

Recovery-first tooling for legacy NavCoin wallets. Imports legacy material,
discovers recoverable funds, and sweeps to a new destination. CLI command is
`ntr`; GUI command is `ntr-gui`.

## Goals

- Accept legacy recovery material from users.
- Detect recoverable NAV and xNAV balances for derived or imported addresses.
- Create and broadcast a sweep transaction to a user-supplied destination.
- Keep the workflow simple, explicit, and safe for one-time recovery use.
- Support a daemon mode that keeps imported wallets in sync with the network.
- Provide a Tauri GUI for non-CLI users without duplicating wallet logic.
- Support Linux, macOS, and Windows.

## Platform Support

- MVP target platforms:
  - Ubuntu 22.04 or newer
  - macOS 12 or newer
  - Windows 10 or newer
- CLI, TUI, daemon, and GUI behavior should work on all three.

## Expected Inputs

- Mnemonic phrases for `navcoin-js` wallet types: `navcoin-js-v1`, `navcash`,
  `next`, `navcoin-core`, `navpay`.
- Private keys (WIF) imported into `navcoin-js`.

## Out Of Scope

- `wallet.dat` ingestion (use `navcoin-core` mnemonic extraction instead).
- In-place modification of old wallet files.
- Token, NFT, or dotNav recovery.

## Pending Work

1. **Tauri GUI** (`ntr-gui`) — primary next slice.
2. **CI release pipeline** — cross-platform artifact builds on version tags.
3. **Local-storage warning on import** — show platform path + static password +
   sensitivity disclaimer after every successful import (not yet wired up).
4. **Test coverage gaps** — see Testing Strategy below.
5. **Code-signing decision** — macOS notarization and Windows Authenticode are
   currently unsigned. Plan a budget/decision before public release.

## Recently Completed

- Replaced the patched `navcoin-js` SyncUtxos with `src/rescue-scan.js`
  (adaptive gap-walker + inline hydrate, named per-phase progress, stale-UTXO
  reap pass).
- xNAV recovery wired in (txKeys cache + bootstrap, OP_TRUE anchor scan).
- Sweep claims both NAV and xNAV in one flow.
- Manual `rescan` command (CLI + TUI + daemon `POST /rescan`) that wipes
  wallet UTXO state via `ZapWalletTxes` and rebuilds.
- Persisted `lastSyncedAt` per source so daemon restart skips the auto-rescan.
- Status display shows confirmed and pending separately, with totals.
- WebSocket frame-size patch (64MB) for large electrum responses.

## CI And Releases

- GitHub Actions for CI. Existing `.github/workflows/ci.yml` runs format and
  test checks on push, PR, and `v*` tags with concurrency cancellation.
- Release pipeline (not yet built):
  - Trigger on `v*` tags after the test job passes.
  - Build cross-platform artifacts for Linux / macOS / Windows × `x86_64` /
    `arm64`.
  - Create a GitHub release named after the tag.
  - Upload archives + per-artifact `.sha256` files.
  - Concurrency: a newer run cancels older in-progress runs for the same ref.

## Architecture (Reference)

- Wallet logic lives in the daemon. CLI, TUI, and GUI are thin clients.
- Daemon owns: imported sources, sync state, address discovery, balances, sweep
  creation, broadcast, persistence.
- UI layers only render state, collect input, invoke daemon commands, and show
  confirmations / progress / errors.
- Daemon binds `127.0.0.1:46117` only. Auth via `auth.cookie` file (`0600`)
  sent as `Authorization: <cookie>`.
- One imported source maps to one `navcoin-js` wallet database under
  `wallets/<source-id>.db`. The daemon aggregates across them rather than
  merging into a single shared wallet.
- Source ids are SHA-256 fingerprints of normalized source details (mnemonic
  words joined with `\n`, or sorted private keys, plus wallet type). Duplicate
  imports are rejected by fingerprint match.
- Static wallet password for all imported sources: `ObsidianSweepKey`.
- Mainnet only (testnet not currently reliable enough).

### On-Disk Layout

```text
<app-data>/
  daemon.json
  auth.cookie
  sources.json
  wallets/
    <source-id>.db
  logs/
    daemon.log
```

App-data location:

- Linux: `~/.local/share/navcoin-rescue-tool/`
- macOS: `~/Library/Application Support/navcoin-rescue-tool/`
- Windows: `%APPDATA%\navcoin-rescue-tool\`

### Corruption And Partial-Failure Handling

- One broken source must not break the daemon. Other sources continue.
- `status` shows broken sources in error state.
- `remove` works on broken sources.
- `import` is allowed while another source is broken.
- `sweep` is blocked if any source is broken or not fully synced.

### Local Storage Warning

After every successful import, the tool must display:

- The local storage path for that source.
- The static wallet password in use (`ObsidianSweepKey`).
- A sensitivity disclaimer: treat local disk access as sensitive until the
  sweep is complete and local wallet data has been purged.

## Brand Colors

All visual surfaces — TUI, Tauri GUI, and any future web UI — must use the
Navio brand palette sourced from nav.io.

### Core Palette

| Role            | Value                            | Notes                                  |
| --------------- | -------------------------------- | -------------------------------------- |
| Magenta primary | `#ec1ec6` / `hsl(310, 90%, 55%)` | Logo gradient start, main accent       |
| Blue primary    | `#1d8ff9` / `hsl(247, 90%, 55%)` | Logo gradient end, secondary accent    |
| Fuchsia accent  | `#d946ef`                        | Heading gradient start, CTA button end |
| Cyan accent     | `#06b6d4`                        | Heading gradient end                   |
| Indigo accent   | `#6366f1`                        | CTA button gradient start              |
| Dark background | `#111827`                        | Page/panel background (`gray-900`)     |
| Card background | `#1f2937`                        | Card/panel surface (`gray-800`)        |
| Dark navy       | `#121827`                        | Pattern background fill                |

### Glow / Animated Shades

| Role              | Value                            |
| ----------------- | -------------------------------- |
| Magenta dark      | `hsl(310, 90%, 25%)` → `#790665` |
| Magenta bright    | `hsl(310, 90%, 65%)` → `#f655db` |
| Magenta highlight | `hsl(310, 90%, 75%)` → `#f885e5` |
| Indigo dark       | `hsl(247, 90%, 25%)` → `#130679` |
| Indigo bright     | `hsl(247, 90%, 65%)` → `#6855f6` |
| Indigo highlight  | `hsl(247, 90%, 75%)` → `#9385f8` |

### Feature Accent Colors

Used for per-feature highlights, source type badges, or status indicators:

| Role   | Value     |
| ------ | --------- |
| Purple | `#7e22ce` |
| Teal   | `#0f766e` |
| Blue   | `#1d4ed8` |
| Sky    | `#0369a1` |
| Pink   | `#be185d` |

### Usage Rules

- Backgrounds: `#111827` (primary), `#1f2937` (panels/cards), `#121827` (deep)
- Primary accents: magenta `#ec1ec6` and blue `#1d8ff9`
- Gradient headings and key labels: fuchsia `#d946ef` → cyan `#06b6d4`
- Interactive elements (buttons, selected items): indigo `#6366f1` → fuchsia
  `#d946ef`
- Errors and warnings: pink `#be185d`
- Success / synced states: teal `#0f766e`
- Muted / inactive text: `gray-400` (`#9ca3af`)
- TUI must approximate these with the nearest terminal-safe equivalents using
  chalk and blessed color support.
- Tauri GUI must use exact hex values via CSS.

## GUI Shape

```bash
ntr-gui
```

Notes:

- `ntr-gui` should be a thin client over the same daemon/API used by `ntr`.
- Build `ntr-gui` with Tauri (Rust core + system webview frontend) for small
  archive size and reduced attack surface compared to Electron.
- `ntr-gui` should auto-start the daemon if it is not already running, then
  connect to it.
- The GUI must preserve the same recovery and safety model as the CLI and TUI.
- Do not implement separate wallet logic in the GUI.
- Use normal desktop controls (buttons, forms, tables), not a
  terminal-emulation view.
- Match the TUI workflow and safety rules, but not the TUI visual presentation.

### Packaging Direction

- Cross-platform builds for Linux, macOS, Windows × `x86_64`, `arm64`.
- Package with Tauri build tooling (`tauri build`).
- Release outputs are simple archives, not installers.
- Archives must be standalone — end users should not need Node.js installed.
- Bundle the runtime and production dependencies needed to run `ntr-gui`,
  `ntr`, and the daemon.
- macOS archives should ship a README with quarantine-removal instructions.
- Code-signing strategy is open. At minimum, document the unsigned-warning
  workaround for each platform until signing is in place.

### Artifact Naming

- Pattern: `navcoin-rescue-tool-${version}-${platform}-${arch}.${ext}`
- Examples:
  - `navcoin-rescue-tool-v0.0.1-linux-x86_64.tar.gz`
  - `navcoin-rescue-tool-v0.0.1-linux-arm64.tar.gz`
  - `navcoin-rescue-tool-v0.0.1-macos-x86_64.zip`
  - `navcoin-rescue-tool-v0.0.1-macos-arm64.zip`
  - `navcoin-rescue-tool-v0.0.1-windows-x86_64.zip`
  - `navcoin-rescue-tool-v0.0.1-windows-arm64.zip`
- Platform names: `linux`, `macos`, `windows`. Arch names: `x86_64`, `arm64`.
- One `.sha256` checksum file per artifact (not one combined file).
- Archive layout places `ntr`, `ntr-gui`, and `README` at the top level of the
  extracted archive.

### GUI Layout

- Keep the GUI simple and close in spirit to the TUI.
- Suggested layout:
  - left sidebar for main actions/views
  - main panel for rendered content
  - bottom status bar for daemon and sync state
- Use exact Navio palette hex values via CSS.
- Background `#111827`, panels `#1f2937`, accents magenta `#ec1ec6` and blue
  `#1d8ff9`, gradients fuchsia `#d946ef` → cyan `#06b6d4`.

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
  - mnemonic / private-key input
  - wallet type selector for mnemonic import
  - import action and result output
- `Remove`
  - source list
  - remove preview
  - confirmation action
- `Rescan`
  - trigger the daemon `/rescan` endpoint (wipes wallet UTXO state and
    rebuilds from chain — keys preserved)
  - per-source progress feedback while the scan runs
- `Sweep`
  - destination entry
  - exact destination re-entry
  - final sweep preview showing NAV and xNAV legs separately plus combined
    total
  - required final phrase confirmation
- `Logs`
  - tails `<app-data>/logs/daemon.log` directly from disk via the Tauri fs
    APIs — no daemon endpoint required
  - monospace scrollable area capped at a fixed line count (e.g. 5000)
  - auto-scrolls to the latest line with a pause toggle
  - copy-to-clipboard and save-to-file actions for support handoff
  - resilient to log rotation and daemon restarts (re-open the file when the
    inode changes)

### GUI Safety Rules

- The GUI must preserve the exact same sweep confirmation guarantees as the CLI.
- A GUI sweep must require:
  - exact destination re-entry
  - explicit `SEND MY COINS` confirmation
- Final sweep submission must be disabled until all confirmations are
  satisfied.
- The sweep must claim both NAV and xNAV outputs in the same flow. The GUI
  must clearly label which legs are being broadcast and surface per-source
  results so partial failures are visible.

## Sweep Confirmation

- Sweep is allowed only when all imported sources are fully synced to the
  current known network head.
- Sweep behavior is to send the full movable balance, including both
  transparent NAV and private xNAV outputs.
- Only dust or sub-fee balances should remain after sweep.
- Step 1: user runs `ntr sweep <address>`.
- Step 2: tool requires the user to enter the exact same destination address
  on standard input.
- Step 3: tool shows final sweep overview:
  - destination address
  - NAV leg total, xNAV leg total, combined total to be sent
  - fee per leg
  - final net amount
- Step 4: tool requires the user to type `SEND MY COINS` exactly before
  broadcasting.

## Testing Strategy

Automated tests use mocked wallet and network behavior only. Do not depend on
public mainnet or live Electrum infrastructure in the automated test suite.

### Coverage Gaps

The current suite covers daemon lifecycle, source registry, sweep
prepare/confirm, and wallet-manager state. The following high-priority cases
are not yet covered:

1. Empty wallet import — scan completes, no balances, sweep blocked.
2. Wrong network — source/daemon mismatch, no false balances reported.
3. Restart persistence — state and sync progress restore across daemon stop /
   start.
4. Sweep amount + fee handling — final sent equals total minus fee, no
   leftover spendable balance.
5. Multi-source sweep correctness — funds consumed from all sources, none
   omitted or double-counted.
6. xNAV sweep correctness (once implemented) — xNAV leg claimed, balances
   match expected.
7. Sync state reporting — pre-sync, mid-sync, post-sync indicators flip only
   when caught up to head.
8. Address reporting — every derived/imported address listed, balances
   attached correctly, totals match per-address sums.
9. Import validation — invalid mnemonic, unsupported type, malformed key,
   no broken persisted state after failure.
10. Source isolation — addresses identified per source, remove/sweep respect
    source boundaries.
11. Idempotent status — repeated calls do not mutate state.
12. Staked or non-sweepable funds — reported distinctly, sweep handles
    correctly or explains why not.

### Mock Design

- Mock the `navcoin-js` boundary, not internal application logic.
- Feed deterministic wallet snapshots, address discovery results, sync
  progress, network head updates, and transaction creation results.
- Fixtures should cover: empty wallets, single-source funded, multi-source
  funded, duplicate imports, wrong-network imports, partially synced wallets,
  staked balances, sweep success and failure cases.

### Manual Post-MVP Testing

- After MVP is complete, do manual end-to-end testing with real coins outside
  the automated test suite. Validates real network sync, balance discovery,
  and final sweep behavior.

### Wallet-Type Coverage

Add mocked fixture coverage over time for each mnemonic type supported by
`navcoin-js`: `navcoin-core`, `navcash`, `next`, `navpay`, `navcoin-js-v1`.
