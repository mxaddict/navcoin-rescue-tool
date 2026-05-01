# navcoin-rescue-tool

Recovery-first tooling for legacy NavCoin wallets.

`navcoin-rescue-tool` is building toward a simple workflow for importing legacy
recovery material, inspecting recoverable balances, and sweeping funds to a new
destination address. The CLI command is `ntr`, and the long-term architecture is
one shared daemon backend for CLI, TUI, and GUI clients.

## Status

This repository is still early-stage and is not ready for real funds yet.

What works now:

- daemon lifecycle commands: `ntr start`, `ntr status`, `ntr stop`
- daemon-backed local source registry in `sources.json`
- `navcoin-js`-backed wallet container creation for mnemonic and private-key
  imports
- source removal and duplicate-source rejection
- live Electrum sync with per-source address and balance reporting in `status`

What does not work yet:

- no sweep transaction creation or broadcast
- no TUI or GUI implementation yet

## Safety Warning

- Do not use this tool with real recovery material or real coins yet.
- Current imports now create local wallet DB files and should still be treated as
  sensitive state.
- The recovery workflow is intended for one-time rescue and sweep, not daily
  wallet use.
- The current MVP plan uses a static wallet password for imported wallet state:
  `ObsidianSweepKey`.

Project plan lives in [`PLAN.md`](./PLAN.md).

## Development Setup

Requirements:

- Node.js with built-in `fetch` and `node:test`
- npm

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Format files:

```bash
npm run format
```

## CLI Usage

Start daemon:

```bash
ntr start
```

Show daemon and source status:

```bash
ntr status
```

Stop daemon:

```bash
ntr stop
```

Import mnemonic source:

```bash
ntr import mnemonic \
  --wallet-type navcoin-js-v1 \
  --label "Main wallet" \
  --phrase "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
```

Supported mnemonic wallet types:

- `navcoin-core`
- `navcash`
- `next`
- `navpay`
- `navcoin-js-v1`

Import private-key source metadata:

```bash
ntr import private-key --label "Loose keys" --key <wif> [--key <wif>]
```

Remove imported source metadata:

```bash
ntr remove <source-id>
```

## App Data Layout

Default app-data root:

- Linux: `~/.local/share/navcoin-rescue-tool/`
- macOS: `~/Library/Application Support/navcoin-rescue-tool/`
- Windows: `%APPDATA%\navcoin-rescue-tool\`

Current layout:

```text
<app-data>/
  daemon.json
  auth.cookie
  sources.json
  wallets/
  logs/
    daemon.log
```

Files:

- `daemon.json`: daemon runtime metadata
- `auth.cookie`: local API auth token for daemon clients
- `sources.json`: imported source registry
- `wallets/`: per-source `navcoin-js` wallet databases
- `logs/daemon.log`: daemon log output

## Architecture

- daemon listens on `127.0.0.1:46117`
- daemon owns local state and persistence
- daemon API currently exposes:
  - `GET /status`
  - `POST /import`
  - `POST /remove`
  - `POST /daemon/stop`
- CLI, planned TUI, and planned GUI all share the same daemon backend

## Roadmap

Near-term work:

1. sweep prepare and confirm flow (`ntr sweep <address>`)
2. TUI default `ntr` flow
3. Electron GUI client

Longer-term direction:

1. add TUI as default `ntr` flow
2. add sweep preparation and confirmation flow
3. add Electron GUI client over the same daemon API

## Contributing Notes

- keep changes small and incremental
- run formatting and tests before committing
- commit and push at major milestones
