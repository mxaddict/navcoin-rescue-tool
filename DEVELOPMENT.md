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
- CLI, TUI, and planned GUI all share the same daemon backend via HTTP

Daemon API:

- `GET /status`
- `POST /import`
- `POST /remove`
- `POST /sweep/prepare`
- `POST /sweep/confirm`
- `POST /daemon/stop`

Source layout:

```text
src/
  constants.js          shared constants (port, password, wallet types)
  app-data.js           platform paths, bootstrap, auth cookie, daemon state
  daemon.js             HTTP daemon entrypoint
  daemon-client.js      typed client wrappers for the daemon API
  navcoin-js-adapter.js isolated navcoin-js boundary (wallet DB creation/deletion)
  wallet-manager.js     in-memory per-source sync state, sweep logic
  source-registry.js    source CRUD, fingerprinting, dedup, sources.json
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

## Contributing

- Keep changes small and incremental.
- Run `npm run format` and `npm test` before committing.
- Follow Conventional Commits: `type(scope): message`.
- Commit and push at major milestones.
- Do not add `wallet.dat` ingestion — use `navcoin-core` mnemonic extraction
  instead.
