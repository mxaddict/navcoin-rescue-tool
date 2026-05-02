# Development

## Requirements

- Node.js with built-in `fetch` and `node:test` (v18+)
- npm

## Setup

```bash
npm install
```

## Running Tests

```bash
npm test
```

## Formatting

```bash
npm run format
```

Check only (used in CI):

```bash
npm run format:check
```

## Architecture

- Daemon listens on `127.0.0.1:46117`
- Daemon owns all local state and persistence
- CLI, TUI, and planned Tauri GUI all share the same daemon backend via HTTP

Daemon API:

- `GET /status`
- `POST /import`
- `POST /remove`
- `POST /purge`
- `POST /rescan`
- `POST /sweep/prepare`
- `POST /sweep/confirm`
- `POST /daemon/stop`

Source layout:

```text
src/
  constants.js          shared constants (port, password, wallet types, phase labels)
  app-data.js           platform paths, bootstrap, auth cookie, daemon state
  daemon.js             HTTP daemon entrypoint
  daemon-client.js      typed client wrappers for the daemon API
  navcoin-js-adapter.js isolated navcoin-js boundary; patches WS frame size
  wallet-manager.js     in-memory per-source sync state, sweep logic, rescan
  rescue-scan.js        adaptive gap-walk + inline hydrate scan engine
  source-registry.js    source CRUD, fingerprinting, dedup, sources.json
  wallet-worker.js      child-process wallet creation (avoids blocking daemon)
  cli.js                ntr CLI entrypoint and command handlers
  tui.js                blessed TUI launched by ntr with no arguments
  gui.js                ntr-gui placeholder
```

## Testing the TUI

The TUI cannot be tested via `npm test` as it takes over the terminal. Test manually:

```bash
node src/cli.js
```

Or if installed globally:

```bash
ntr
```

## Key Implementation Notes

- `navcoin-js` requires a browser globals shim (`global.window = global`) and
  `indexeddbshim` for Node sqlite persistence.
- Per-source wallet DBs land as `D_<sourceId>.db.sqlite` under `wallets/`.
- Private-key wallets use a fixed anchor mnemonic to initialise the DB schema.
- Static wallet password for all sources: `ObsidianSweepKey`.
- Daemon binds to `127.0.0.1:46117` only.
- Auth cookie file uses `0600` permissions.
- All test temp files go under repo-local `tmp/` (gitignored). Never use
  `os.tmpdir()` — use `makeProjectTempDir()` from `test/test-helpers.js`.
- TUI uses `blessed` (CJS, via `createRequire`) and `chalk` (ESM, via dynamic
  `import()`). Both must be imported this way due to the mixed module system.
- TUI detects the terminal background via OSC 11 query before blessed
  initialises — reads raw stdin with a 200ms timeout, falls back to dark palette
  if unsupported. Uses WCAG relative luminance to decide dark vs light.
- `blessed` screen must set `terminal: 'xterm-256color'` to suppress terminfo
  parse errors on Alacritty and similar terminals.

### Rescue scan (`rescue-scan.js`)

- Replaces upstream `wallet.Sync` / `SyncUtxos` for the recovery-only
  workflow. Drops history sync; only finds spendable UTXOs.
- Phases (in order, each with named progress):
  - xNAV pool fill
  - `receive` — adaptive BIP44 gap walk + inline hydrate via `wallet.GetTx`
  - `change` — same walker on the change branch
  - `stake-discover` — explicit `blockchain_staking_getKeys` per derived addr
    so cold-stake partners beyond the default NavCash pool are found
  - `stake` — listunspent over (partner × addr) cold-stake scripthashes
  - `xnav-history` then `xnav` — anchor `getHistory` + txKeys-cache filter
  - `xnav-claim` — full tx fetch + blsct recovery for owned candidates
  - reap pass — marks any UTXO in db not seen this scan as spent so stake
    inputs consumed since the last scan stop counting toward confirmed
- Uses `wallet.GetTx(txid, undefined, height, false)` for all parent-tx
  fetches so `tx.height` and `tx.pos` are persisted via `getMerkle`.
  Without it, GetBalance categorises every UTXO as pending.
- `lastSyncedAt` per source persisted to `sources.json` via
  `markSourceSynced`. On daemon restart, sources with that field skip the
  auto-rescan and rely on the user-triggered `rescan` command instead.

### WebSocket frame size patch

- `navcoin-js-adapter.js` patches `websocket` package's `w3cwebsocket`
  before the dynamic `import('navcoin-js')` so electrum-client-js
  captures the patched constructor when it does
  `require('websocket').w3cwebsocket`.
- Default 64KB / 1MB limits cause connection close (code 1009) on big
  frames: consensus subscribe, dao subscribe, OP_TRUE anchor history.
  Bumped to 64MB.

## Contributing

- Keep changes small and incremental.
- Run `npm run format` and `npm test` before committing.
- Follow Conventional Commits: `type(scope): message`.
- Commit and push at major milestones.
- Do not add `wallet.dat` ingestion — use `navcoin-core` mnemonic extraction
  instead.
