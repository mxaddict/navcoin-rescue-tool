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

## Goals

- Accept legacy recovery material from users.
- Detect recoverable NAV balances for derived or imported addresses.
- Create and broadcast a sweep transaction to a user-supplied destination
  address.
- Keep the workflow simple, explicit, and safe for one-time recovery use.
- Support a daemon mode that keeps imported wallets in sync with the network.

## Expected Inputs

- Mnemonic phrases supported by `navcoin-js` wallet types:
  - `navcoin-js-v1`
  - `navcash`
  - `next`
  - `navcoin-core`
  - `navpay`
- Private keys that can be imported into `navcoin-js`
- `wallet.dat` only through a separate extraction step, since `navcoin-js` does
  not appear to load Core `wallet.dat` files directly

## Initial Non-Goals

- Full GUI in the first version
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
7. Define `wallet.dat` strategy:
   - either external extractor step
   - or direct integration with a separate parser if one is viable
8. Add balance discovery and address reporting.
9. Add sweep transaction creation and broadcast.
10. Add safety checks:

- destination validation
- explicit two-step confirmation before broadcast

11. Test against known legacy wallet samples and edge cases.

## Open Questions

- Which exact legacy wallet types do we need to support first?
- Do we need read-only balance inspection before requiring any spending
  password?
- Should `wallet.dat` handling be built in, or should users extract keys with a
  companion command/tool?
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

After that, add private-key recovery, then solve `wallet.dat` ingestion.

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
  - per-source sync state
  - whether each source is caught up to current known network head
  - total confirmed, unconfirmed, staked, and sweepable balances
  - current connected server and last sync information
- `ntr sweep <address>` should always require interactive confirmation.

## Sweep Confirmation

- Step 1: user runs `ntr sweep <address>`.
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
