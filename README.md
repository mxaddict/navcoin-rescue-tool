# navcoin-rescue-tool

Recovery-first tooling for legacy NavCoin wallets.

`navcoin-rescue-tool` imports legacy recovery material, inspects recoverable
balances, and sweeps funds to a new destination address. The CLI command is
`ntr`.

## Status

This repository is still early-stage and is not ready for real funds yet.

What works now:

- daemon lifecycle: `ntr start`, `ntr status`, `ntr stop`
- mnemonic and private-key import backed by `navcoin-js`
- source removal and duplicate-source rejection
- live Electrum sync with per-source address and balance reporting
- sweep to a destination address with two-step confirmation (`ntr sweep <address>`)

What does not work yet:

- no TUI or GUI yet

## Safety Warning

- Do not use this tool with real recovery material or real coins yet.
- Importing a source creates local wallet DB files that should be treated as
  sensitive state.
- The recovery workflow is intended for one-time rescue and sweep, not daily
  wallet use.
- All imported wallet state is encrypted with the static password
  `ObsidianSweepKey`.

## CLI Usage

Start the daemon:

```bash
ntr start
```

Show daemon and source status:

```bash
ntr status
```

Stop the daemon:

```bash
ntr stop
```

Import a mnemonic source:

```bash
ntr import mnemonic \
  --wallet-type navcoin-js-v1 \
  --label "Main wallet" \
  --phrase "word1 word2 ... word12"
```

Supported mnemonic wallet types:

- `navcoin-core`
- `navcash`
- `next`
- `navpay`
- `navcoin-js-v1`

Import private-key source:

```bash
ntr import private-key --label "Loose keys" --key <wif> [--key <wif>]
```

Remove an imported source:

```bash
ntr remove <source-id>
```

Sweep all confirmed NAV to a destination address:

```bash
ntr sweep <destination-address>
```

The sweep flow requires:

1. All sources to be fully synced
2. Re-entry of the exact destination address
3. Typing `SEND MY COINS` to confirm broadcast

## App Data

Default location:

- Linux: `~/.local/share/navcoin-rescue-tool/`
- macOS: `~/Library/Application Support/navcoin-rescue-tool/`
- Windows: `%APPDATA%\navcoin-rescue-tool\`

Layout:

```text
<app-data>/
  daemon.json       daemon runtime metadata
  auth.cookie       local API auth token
  sources.json      imported source registry
  wallets/          per-source navcoin-js wallet databases
  logs/
    daemon.log      daemon log output
```

## Roadmap

Near-term:

1. TUI default `ntr` flow
2. Electron GUI client

Longer-term:

1. cross-platform release artifacts
2. broader wallet-type fixture coverage
