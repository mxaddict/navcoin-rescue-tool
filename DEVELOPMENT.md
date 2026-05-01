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
- CLI, planned TUI, and planned GUI share the same daemon backend via HTTP

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
  gui.js                ntr-gui placeholder
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

## Contributing

- Keep changes small and incremental.
- Run `npm run format` and `npm test` before committing.
- Follow Conventional Commits: `type(scope): message`.
- Commit and push at major milestones.
- Do not add `wallet.dat` ingestion — use `navcoin-core` mnemonic extraction
  instead.
