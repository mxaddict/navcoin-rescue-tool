# navcoin-rescue-tool

Recovery-first tooling for legacy NavCoin wallets.

`navcoin-rescue-tool` imports legacy recovery material, inspects recoverable
balances, and sweeps funds to a new destination address. The CLI command is
`ntr`; the GUI command is `ntr-gui`.

## Status

The CLI/TUI/GUI/daemon path is functional and has reconciled real wallet
balances against `navcoin-cli` to the satoshi. Treat as beta — verify on a
test wallet before sweeping anything irreplaceable.

What works now:

- TUI: run `ntr` with no arguments for a full terminal UI
- GUI: run `ntr-gui` for a Tauri desktop app over the same daemon
- daemon lifecycle: `ntr start`, `ntr status`, `ntr stop`
- mnemonic and private-key import backed by `navcoin-js`
- source removal and duplicate-source rejection
- live Electrum sync with per-source phase progress and balance updates
- adaptive BIP44 gap-walk discovery (no fixed address cap)
- xNAV recovery via OP_TRUE anchor + bundled `xNavBootstrap` cache
- staking-partner discovery for cold-stake outputs
- `status` (per-source confirmed/pending/total + aggregate)
- `show` (addresses with non-zero balance, sorted)
- `sweep` claiming both NAV and xNAV in one flow with two-step confirmation
- `rescan` to wipe wallet state and re-discover from chain
- `purge` to delete all imported wallet data
- daemon skips re-scan on restart for sources already marked synced

What does not work yet:

- non-atomic sweep — partial broadcast failure leaves earlier legs on chain

## Safety Warning

- Verify against a test wallet before sweeping anything irreplaceable.
- Importing a source creates local wallet DB files that should be treated as
  sensitive state.
- The recovery workflow is intended for one-time rescue and sweep, not daily
  wallet use.
- All imported wallet state is encrypted with the static password
  `ObsidianSweepKey`.
- The sweep broadcast loop is **not atomic**: if a later broadcast fails,
  earlier ones are already on chain.

## After Sweeping — Purge Your Wallet Data

**Once your sweep is complete, run `purge` immediately.**

Imported wallet data remains on disk until explicitly deleted. This includes
derived private keys and address history. Leaving it on disk after a successful
sweep is a security risk.

```bash
ntr purge
```

Or use the `purge` command in the TUI.

This deletes all imported wallet databases from disk and resets the source
registry. It does not affect the daemon configuration or auth state — you can
still run `ntr start` afterwards.

**If you do not purge:**

- Your recovery material remains locally accessible in encrypted form under
  `ObsidianSweepKey`
- Anyone with access to your disk and the static password can read the wallet
  data
- The wallet files persist across daemon restarts until explicitly removed

## TUI

Run `ntr` with no arguments to launch the terminal UI:

```bash
ntr
```

The TUI auto-starts the daemon if it is not already running. Commands:

| Command  | Description                                                  |
| -------- | ------------------------------------------------------------ |
| `status` | Daemon and per-source confirmed/pending balance + sync phase |
| `show`   | Addresses with non-zero balance, sorted                      |
| `import` | Interactive import (chooses mnemonic / private-key)          |
| `remove` | Remove an imported source                                    |
| `rescan` | Wipe wallet state and re-scan all sources from chain         |
| `sweep`  | Sweep NAV + xNAV to a destination address                    |
| `purge`  | Delete all imported wallet data from disk                    |
| `stop`   | Stop the daemon and exit the TUI                             |
| `help`   | Show command reference                                       |
| `quit`   | Exit the TUI (daemon keeps running)                          |

- Tab auto-completes commands.
- ↑/↓ recall previous commands; PgUp/PgDn scroll output.
- Press Ctrl+C twice to quit.
- Adapts to dark and light terminal backgrounds automatically.

## GUI

Run `ntr-gui` to launch the Tauri desktop app:

```bash
ntr-gui
```

The GUI auto-starts the daemon if it is not already running and is a thin
client over the same `127.0.0.1:46117` API as `ntr` and the TUI. Views:
Status, Import, Sweep, Logs, Purge.

### Window decorations

GTK on Wayland always draws client-side titlebars, which look foreign on
tiling compositors. The GUI strips its titlebar automatically when launched
under Hyprland, Sway, niri, river, or Wayfire. Override:

- `NTR_DECORATIONS=0` — force-strip the titlebar
- `NTR_DECORATIONS=1` — force-keep the titlebar

## CLI Usage

Start the daemon:

```bash
ntr start
```

Show daemon and source status:

```bash
ntr status
```

Show addresses with non-zero balance per source:

```bash
ntr show
```

Re-scan all sources (wipes wallet state and rebuilds from chain — keeps
mnemonic/keys):

```bash
ntr rescan
```

Stop the daemon:

```bash
ntr stop
```

Import a mnemonic source:

```bash
ntr import mnemonic \
  --wallet-type navcoin-js-v1 \
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
ntr import private-key --key <wif> [--key <wif>]
```

Remove an imported source:

```bash
ntr remove <source-id>
```

Sweep both NAV and xNAV to a destination address:

```bash
ntr sweep <destination-address>
```

Per source, the tool broadcasts up to two legs: a NAV leg via
`NavCreateTransaction` (when nav.confirmed > 0) and an xNAV leg via
`xNavCreateTransaction` (when xnav.confirmed > 0). Fees are subtracted
from the swept amount.

The sweep flow requires:

1. All sources to be fully synced
2. Re-entry of the exact destination address
3. Typing `SEND MY COINS` to confirm broadcast

Note: the broadcast loop is not atomic across sources or legs. If a later
broadcast fails, earlier ones are already on chain and cannot be undone.

Purge all imported wallet data after sweeping:

```bash
ntr purge
```

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

1. Atomic / per-source-result sweep so partial broadcast failure is visible
2. CI release pipeline + cross-platform archives (Linux/macOS/Windows × x86_64/arm64)

Longer-term:

1. Broader wallet-type fixture coverage in the test suite
2. Code-signing for macOS/Windows release artifacts
