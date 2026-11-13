# Backlog

Work raised but not finished, and what was deliberately left alone. Delete an
entry when it ships — `git log` is the history.

## Rust migration

- Full plan in `docs/rust-migration.md` (2026-08-27). Open decisions it needs
  before phase 1: GUI frontend (static JS vs Rust-native), whether to keep the
  `ObsidianSweepKey` encryption claim, embed vs drop the xNAV bootstrap cache,
  and sign-off on the proposed crate list. Not started.

## Stale daemon after upgrade: what is left

The TUI at startup and `ntr start` now stop a daemon whose `/status`
reports another version and start their own (`stopDaemonFromOtherVersion`
in `daemon-client.js`). Every other CLI command (`ntr status`, `ntr sweep`,
`ntr import`, …) still talks to whatever daemon holds the port without
looking at its version, and so does a TUI session that was already running
when the daemon was swapped. They need `ntr start` to have run first, which
is when the check happens; a warning on a mismatch would close the gap.

## Coverage gaps

- The release smoke tests drive daemon start/stop through the CLI wrappers and
  `ntr-gui --daemon-check`. They do not import a wallet, sync, or sweep, so a
  break in the wallet path still only shows up in the unit tests and manual
  runs.
- `ntr-gui --daemon-check` exercises `ensure_daemon`; it never opens a window,
  so nothing in CI proves the webview loads on any platform.
- The import path was reviewed again after the group import landed:
  `source-registry.js`, `mnemonic.js`, `constants.js`, the `/import` and
  `/status` handlers, `navcoin-js-adapter.js`, `cli.js`, `tui.js` and
  `gui/src`. `wallet-manager.js` and `rescue-scan.js` were read only for
  how they behave with several sources per phrase, not reviewed as a
  whole.
- Reviewed for correctness in an earlier pass: `daemon.js`, `app-data.js`,
  `source-registry.js`, `daemon-client.js`, `navcoin-js-adapter.js`,
  `wallet-worker.js`, `wallet-manager.js`, `rescue-scan.js`, `cli.js`,
  `src-tauri/src/lib.rs`. Skimmed only: `tui.js` rendering internals and the
  Svelte views under `gui/src` — their daemon wiring was read, their UI logic
  was not.

## The daemon log records mnemonics in cleartext

- `createImportedWallet` in `navcoin-js-adapter.js` translates the
  "cannot read properties of undefined" failure into a wallet-type hint, but
  every other failure falls through to
  `navcoin-js import failed: ${raw}`. bitcore-mnemonic's `InvalidMnemonic`
  puts the whole phrase in its message, so `daemon.js` writes the user's
  seed phrase into `logs/daemon.log`.
- The log file is created mode 644, unlike `sources.json` and `auth.cookie`
  which are 600. Confirmed on this machine 2026-08-27: the log was
  world-readable and held the phrase on 12 lines.
- Partly fixed: import-time validation now rejects a bad phrase with a
  message that never contains it, so the reported case no longer reaches
  the log. Still open: any other failure from `createImportedWallet` falls
  through to `navcoin-js import failed: ${raw}`, and a waived
  `navcoin-core` import can still reach that path. The log is also still
  created 644 while `sources.json` and `auth.cookie` are 600. Existing logs
  stay readable until wiped by hand.

## Large-wallet sync: what is fixed and what is not

The per-transaction snapshot rebuild and the single-server herding are
fixed (see the changelog). These remain, all from one user report on
2026-09-12: two phrases, eight derivations, a wallet large enough to OOM
the daemon at node's default heap.

- **Nothing caps how many wallets scan at once.** `main` in `daemon.js`
  opens every stored source in one loop, and the `/import` handler opens
  every derivation of a phrase the same way — eight full history scans in
  one process, each with its own electrum socket and sqlite traffic. The
  refresh fix removes the memory blowup, not the multiplier. A cap would
  have to gate `rescueScan` rather than `openSourceWallet`, because the
  scan is deliberately not awaited: the open resolves as soon as the
  wallet is connected. Sources waiting for a slot would sit in
  `connected`, which the sweep guard already treats as not ready.
- **The daemon runs on node's default heap** and is spawned with no
  `--max-old-space-size`. The crash was at roughly 4 GB. Raising it was
  considered and not done: the allocation was unbounded, so a larger heap
  only moves where it dies.
- **Not measured against a real large wallet.** The fix was found by
  reading the sync path and is covered by unit tests that count database
  reads per transaction event; nobody has re-run the reported wallet.
- **`balance_changed` is emitted nowhere in navcoin-js 1.1.182.** The
  handler is kept and now routes through the same coalescing, so a future
  version that starts emitting it cannot reintroduce the storm.

## Electrum failover: what is left

Failover was rebuilt in `electrum-connection.js` (2026-10-06) after a user
log showed a wallet retrying one dead server forever. What it leaves open:

- **Requests pending on a dropped connection are never settled.** The
  electrum client drops them on close. Rejecting them was tried and
  declined: navcoin-js awaits its own requests without handling errors, and
  the rejections ended the process. Each drop therefore strands whatever was
  in flight — our scan is abandoned through its abort signal, navcoin-js's
  own tasks just stay pending.
- **The supervision depends on electrum-client-js 0.1.x internals**
  (`persistencePolicy`, the `subscribe` emitter, `Connect()` creating the
  client synchronously). `assertClientShape` fails loudly if they change;
  re-run `test/electrum-failover.test.js` on any navcoin-js or
  electrum-client-js upgrade.
- **Considered: fixing it upstream instead** — have navcoin-js pass a
  persistence policy, rotate on a websocket close, and settle pending
  requests. Better long term, and it would make most of
  `electrum-connection.js` unnecessary; not done because it needs a
  navcoin-js release.
- **Coverage gap: only local `ws://` stub servers.** Refused, reset and
  silent servers are covered; TLS failures on the real `wss://` nodes and
  real mainnet servers are not.
- `test/electrum-failover.test.js` leaves `tmp/electrum-failover` behind on
  purpose: the indexeddb shim keeps its sqlite files open for the life of
  the test process, so it is cleared at the start of the next run instead.

- **Scan resume: what it does not cover.** A scan cut off by a drop now
  resumes from a checkpoint in the wallet's settings table (`openProgress`
  in `rescue-scan.js`, `scanCheckpointStore` in `wallet-manager.js`): the
  receive and change walks skip the addresses already looked up. Left open:
  - Staking-partner discovery (`discoverStakingPartners`) is recorded only
    as done or not. Cut off part-way, it asks about every address again,
    one request each, so on a large wallet behind servers that reset within
    seconds it may never finish. Not reproduced.
  - The staking scan (`scanStaking`) and the xNAV pass (`scanXNav`) always
    run again in full. The xNAV pass reads transaction keys it already
    fetched from the wallet's cache (`loadTxKeys`); the staking scan asks
    the server again for everything.
  - Private-key sources (`scanExistingNavAddrs`) are not checkpointed.
  - A resumed scan skips `reapStaleUtxos`, because it did not see the
    outpoints of the addresses it skipped. A UTXO that was in the wallet
    before the scan began and was spent since stays counted until the next
    scan that runs start to finish.
  - `SCAN_CHECKPOINT_MAX_AGE_MS` is a guess. An address finished early in
    a scan is not looked at again by it, so coins that arrive there later
    in the same scan are missed until the next one; that was already true
    of one long scan, and the limit bounds how long a resumed one can
    stretch it. Not measured against a real long scan.
  - `concurrency` in the scan config, the parallel lookups per wallet, is a
    likely contributor to servers dropping us and is untested against a
    real server.

## Remove and re-import: what is left

Fixed 2026-10-08 (see the changelog), from a user log full of `AddTx` errors
after removing and re-importing a phrase. Every case is now a test in
`test/remove-reimport.test.js`. What it leaves open:

- **Every derivation of the fixture phrase reports the xNAV balance.** In
  `test/fixtures/mainnet-fake.json` runs, `next`, `navpay` and
  `navcoin-js-v1` each show the same 3 xNAV, while the NAV sits on
  `navcoin-js-v1` alone. If that holds on mainnet, a sweep would try to
  spend the same xNAV once per derivation. Seen in the stub runs only; not
  investigated.
- **Purge leaves `__sysdb__.sqlite` behind.** It is the indexeddb shim's
  registry, opened through a variable private to the shim, so the daemon
  cannot close it, and Windows will not delete it while open. Purge empties
  it instead — every database is deleted through it — and it holds only
  database names.
- **Deleting depends on indexeddbshim 16 internals.** `destroyDatabase` in
  `wallet-database.js` closes the sqlite handle at `__db._db._db`, because
  nothing public does. It fails loudly if that shape changes; re-run
  `test/remove-reimport.test.js` on any indexeddbshim upgrade. indexeddbshim
  19 (dependabot's npm group, #11, 2026-10-28) moves `websql-configurable` to
  4.x, which swaps node-sqlite3 for `better-sqlite3`. That PR failed all six
  remove-then-reimport tests on every platform and was left open: each ran
  about five minutes, then its daemon request ended in `fetch failed`. Likely
  but unconfirmed cause: `better-sqlite3`'s `close()` is synchronous and takes
  no callback, so `closeSqlite`'s promise would never settle. Upgrading means
  rewriting `destroyDatabase` for the new handle and re-checking
  `SQLITE_BUSY_TIMEOUT_MS`, which is passed as the shim's `sqlBusyTimeout`.
- **A wallet whose creation failed is still forgotten through the worker**
  (`deleteWalletForSource` in `createImportedWallet`). That is right while
  the daemon never opens such a wallet, which holds again now that `main`
  skips sources recorded as failed; if it ever does, that path needs
  `deleteOpenedWallet` too.
- **The sqlite busy timeout has no test in the suite.** Parallel wallet
  creation under load (four processes each creating the fixture phrase's
  derivations, fourteen rounds) failed 13 of 168 creations at the default
  lock wait and 0 of 168 with `SQLITE_BUSY_TIMEOUT_MS` in
  `wallet-database.js`, measured 2026-10-08 on Windows. A test that reliably
  reproduces it needs minutes of load, so it was not added; a regression
  would show as an intermittent `Dexie-encrypted can't find its encryption
table` in a wallet-creation error.
- **`every derivation removed, then the phrase imported again` flaked once**
  (`test/remove-reimport.test.js`), locally on 2026-11-08 during a full
  `npm test` after the dependency refresh: `assertAllSynced` never saw
  every source synced within the test's timeout. The file passed alone
  twice right after, with the same dependencies. The machine was busy (load
  around 6), so a timeout under load is the likely reading; not
  investigated further.
- **Daemon tests flaked with `ENOTEMPTY` deleting their data directory.**
  `daemon survives purge then re-import of same private key` (PR #12,
  2026-11-07, `ubuntu-24.04-arm`) and, in the v0.2.10 release run on
  2026-11-13, the same test on `macos-15-intel` and `daemon survives an
electrum server answering busy` on `ubuntu-24.04-arm`. Mechanism, found by
  reading the code and not reproduced: `runWalletWorker` in
  `navcoin-js-adapter.js` spawns a wallet worker per import and tracks none
  of them, so a worker can still be writing into `wallets/` after the test
  has stopped the daemon and `waitForExit` returned. Tests that run a real
  daemon now delete through `removeDaemonDataDir` in `test/test-helpers.js`,
  which retries `fs.rm` on that error.
- **Stopping the daemon leaves its wallet workers running.** Same root as
  the flake above: `performShutdown` in `daemon.js` does not stop or wait for
  the workers `runWalletWorker` spawned, so a stop during an import leaves a
  worker writing the wallet database until it finishes or hits its own
  timeout (`WORKER_TIMEOUT_MS` in `wallet-worker.js`). A restart right after
  opens a wallet the worker is still writing. If its master key is not in
  yet the open now fails and the source is recorded as failed, which is
  safe but loses an import that was about to succeed. Not reproduced.
- Removing a source mid-setup now logs
  `[electrum] connection setup stopped by the wallet closing: …` — expected,
  not a fault.

## Group import: known consequences

- Importing one mnemonic now builds a wallet per derivation (three for a
  valid 12-word BIP39 phrase, four for 24 words), each with its own
  `RECOVERY_MIN_POOL_SIZE` address pool and its own electrum sync. Import
  and first sync therefore take roughly N times as long and N times the
  disk as before. Measured only in the test suite, where the real-adapter
  case in `test/source-registry.test.js` builds three wallets; not
  measured against a real electrum server.
- Sources imported by an earlier build have a `walletType` that is a
  user-facing alias (`coinomi`) and no `importId`. `importSources` skips
  any prepared source whose fingerprint already exists, so re-importing
  such a phrase adds the derivations it is missing rather than failing —
  but the pre-existing source keeps its alias label and stays outside the
  group. Nothing migrates it; verified only by reading the code.
- `sources.json` now holds the same phrase once per derivation, in
  `normalizedDetails` on every source of the group. Same file, same 0600
  mode, more copies of the secret.
- `explainNoEligibleWalletType` ends in a fallback that cannot be
  reached — navcash has no word-count rule and its check returns a
  boolean, so it always contributes a checksum error for a phrase no
  derivation accepted. Kept so the function is guaranteed to return an
  Error rather than `undefined`.

## Findings not fixed

- `rescueScan` accepts a `skipXNav` option that no caller sets. Either wire it
  to something or drop it; leaving it means an untested path.
- `tui.js` carries dead code: `tabComplete` (around line 186) has no caller,
  and two `break` statements sit after `process.exit(0)`. Re-verified
  2026-08-28. The earlier claim here that `createRequire` was unused was
  wrong — it is what loads `blessed`.
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

## Sweep guards: what is left

A user on v0.2.9 saw `Sweep failed: fetch failed` after "Broadcasting...",
from a sweep that hung on a broadcast the server never answered. `sweep.js`
now interrupts a leg when its source loses the connection or the server
stays silent past a timeout, refuses a second sweep while one runs, treats
a broadcast with no transaction id as not sent, lists the legs already
broadcast in the error of a sweep that then fails, and keeps the last
sweep's record for `/status`, which the CLI and TUI follow when the reply
to `/sweep/confirm` is lost. What that leaves open:

- **An interrupted broadcast is reported as outcome unknown, with no
  transaction id.** Considered and declined: computing the id locally from
  the signed transaction, so the user could look it up. It could not be
  verified here that `@aguycalled/bitcore-lib` yields the network's id for
  NavCoin transactions (the fixture transactions are fakes and need the
  BLS library initialised to parse), and a wrong id is worse than none.
  Worth doing if it can be checked against a real broadcast.
- **The timeouts are guesses.** `SWEEP_BUILD_TIMEOUT_MS` and
  `SWEEP_BROADCAST_TIMEOUT_MS` in `sweep.js` were not measured against a
  real xNAV build on slow hardware or a real server. A build that honestly
  takes longer than its timeout is reported as not broadcast, which is
  true, but that source cannot be swept until the constant is raised.
  Nothing was broadcast in that case, so raising it is safe.
- **The GUI does not follow a lost sweep.** `sweepConfirm` in
  `gui/src/lib/daemon.js` is its own client and sends no sweep id; it shows
  the error and stops. The record is on `/status` for it to use.
- **The sweep record is lost on a daemon restart.** It lives in memory in
  `sweep.js`. A client following a sweep then reports that the daemon has
  no record of it and to check the log, which does survive.
- **Coverage gap: the `/sweep/confirm` route's part is not run end to
  end.** `executeSweep`, `getSweepStatus` and the client's following are
  tested against mock wallets and a fake daemon; that `daemon.js` passes
  `sweepId` through and puts `code` on its error reply was read, not
  exercised by a test with a real daemon and a real sweep.
- **Coverage gap:** the 300 s after which fetch gives up waiting for the
  reply was read in the repo's undici 6.28, not in the Node 22.11 the
  release bundles.

## Codebase review 2026-11-13: findings not fixed

A correctness review of the whole tree: `rescue-scan.js`,
`wallet-manager.js`, `electrum-connection.js` and `sweep.js` were read in
full in-session; everything else by a read-only reviewer whose report was
then checked against the code where marked "re-checked". Ordered by how
badly each can cost a user coins. No test was written for any of them yet.

- **A source with no wallet database: what is left.** `openSourceWallet`
  now fails the open when navcoin-js reports it created a wallet
  (`new_mnemonic`), `openRegisteredSource` in `daemon.js` deletes that
  wallet and records the source as failed, and `main` no longer opens
  sources recorded as failed. Left open:
  - Nothing rebuilds such a source. The user has to remove it and import
    the phrase again, which the error says; a "wallet built" flag in the
    registry would let the daemon rebuild it from `normalizedDetails`.
  - A private-key source whose worker died after the container wallet was
    created but before its keys were imported has a master key, so it is
    not caught: it opens as an empty wallet. From the reviewer, inferred
    from the order of steps in `wallet-worker.js`, not reproduced.
  - A source the user removes while its database is already gone still
    goes through `removeSource`; not tested.
- **A scan that ends with failed lookups: what is left.** It now ends as
  incomplete (`ScanIncompleteError` in `rescue-scan.js`), `runScan` in
  `wallet-manager.js` runs it again after a pause, and the source goes into
  error when lookups still fail after the last attempt. Left open:
  - `SCAN_ATTEMPTS` and `SCAN_RETRY_DELAY_MS` are guesses, not measured
    against a server that answers "busy".
  - An output whose transaction the server returns empty, rather than
    failing, is still skipped without counting (`if (!tx?.hex) continue` in
    `scanAndHydrateAddr` and `scanStaking`). Whether a real server ever
    does that for an output it lists as unspent is not known.
  - A source that reached error this way stays there until a manual
    rescan; nothing retries it later by itself.
  - navcoin-js's own connect-time `sync_finished` still marks a source
    synced when no scan of ours ever ran or failed on it, which is how the
    test mocks without an electrum client become synced.
- **High: a sweep cannot see a source that has no open wallet.**
  `prepareSweep` and `executeSweep` in `sweep.js` look only at
  `listSourceStates()`, and a source has no live state until its wallet
  worker finishes. Sweeping while a just-imported phrase is still being
  built, or after a wallet failed to build, previews and sweeps the other
  sources and reports success, with the missing one neither blocking nor
  listed under `skipped`. From the reviewer, by reading; not run. Fix: in
  both sweep routes, treat every registered source without live state as
  blocked.
- **Medium: `/remove` or `/purge` during a background wallet creation.**
  The creation chain in the `/import` handler is not tracked, the two
  routes do not wait for it, and its `.then` opens the source without
  checking it is still registered. A removal in that window can leave a
  wallet open under an id no longer in `sources.json`: invisible on
  `/status`, but counted by the sweep guard. From the reviewer, control
  flow read, neither platform outcome run. Fix: track the creation promise
  per source, have the routes await it, and re-check the registry before
  opening.
- **Medium: a phrase with a capital letter is rejected as a checksum
  failure.** `normalizeMnemonic` in `source-registry.js` does not
  lowercase, so a correct phrase from an autocapitalising keyboard fails.
  For 24 words the failure is offered as waivable; waived, it imports only
  as `navcoin-core` and then fails in the worker, because
  `assertMnemonicAccepted` in `mnemonic.js` returns on the waiver before
  any wordlist check. The reviewer ran the validation; the worker failure
  is inferred. Fix: lowercase, and require a wordlist match under the
  waiver too.
- **Low-medium: an empty `auth.cookie` turns authentication off.**
  `ensureAuthCookie` in `app-data.js` accepts any existing file and writes
  it non-atomically; a zero-byte file gives an empty cookie, and a request
  with an empty `Authorization` header then matches. The comparison was
  run by the reviewer; that a web page can send it is inferred. Fix:
  regenerate a cookie that is not the expected length, and write it
  through a rename.
- **Low-medium: overlapping private-key imports hold one key twice.** The
  import fingerprint hashes the sorted key set, so `{A}` and then `{A, B}`
  are two sources both holding A. Balances double and the second sweep leg
  conflicts with the first. WIF format is also not checked at import, so a
  bad key is accepted and fails later. By reading; the broadcast rejection
  is inferred. Fix: reject a key another source already holds, and
  validate the format.
- **Low: purge reads the registry first and deletes wallets before
  emptying it** (`purgeAllSources` in `source-registry.js`): a corrupt
  `sources.json` makes `/purge` fail with nothing deleted, and a failure
  between the two steps leaves registered sources without databases, the
  first finding's precondition.
- **Low: the GUI log view fails on a multi-byte character at the tail
  boundary.** `read_log_tail` in `src-tauri/src/lib.rs` seeks into the
  file and calls `read_to_string`, which errors on a split character
  before the partial first line is dropped. Fix: read bytes and decode
  lossily.
- **Low: a scan that finds no electrum client ends without a result.**
  `rescueScan` returns false when `wallet.client` is missing and `runScan`
  then leaves the source neither synced nor in error, with no retry. Read
  in-session; the window between `waitForConnected` and the scan starting
  is small and it was not reproduced.
- **Low, from the reviewer, by reading:**
  - `main` in `daemon.js` ends the open-every-source chain with an empty
    catch, so a failure of `getNavWallet` or `readSources` at start logs
    nothing and every source shows `wallet-created` with no balance.
  - A second daemon that loses the port writes `status: 'error'` into the
    shared `daemon.json` while the first is running.
  - `/daemon/stop` does not wait for a running sweep, and both the GUI's
    `ensure_daemon` and `stopDaemonFromOtherVersion` send it on a version
    mismatch.
  - `stopDaemonFromOtherVersion` and the GUI's `wait_for_daemon_gone` take
    "port refused" for "gone", but `performShutdown` closes the listener
    before the wallets, so the replacement can start while the old process
    is still closing them.
  - The wallet worker's reply shares stdout with whatever navcoin-js
    prints there, so one stray line turns a successful creation into a
    failed one (`runWalletWorker` cannot parse the reply). Trigger
    inferred.
  - The header comment in `tx-cache.js` says a failed `AddTx` surfaces as
    before; `addTxOnce` rethrows where upstream logged and returned.
- **Not reviewed:** indexeddbshim internals behind `wallet-database.js`;
  key derivation per wallet type in `mnemonic.js` and `wallet-worker.js`;
  `tui.js` against blessed's real behaviour; `src-tauri/daemon-launch`
  tests, `build.rs` and the Tauri capability files; GUI styling; anything
  on a real daemon run on any platform.

## Codebase review 2026-11-08: findings not fixed

A read-only review, most severe first. "Re-checked" means the code path
was traced again after the review; the rest come from the review alone, by
reading, and no test was written or run for any of them.

- **High: a `.nav` destination is resolved by an electrum server and the
  result is never shown.** Re-checked. The `/sweep/confirm` handler in
  `daemon.js` only checks the destination is present, and the CLI, TUI and
  `gui/src/views/Sweep.svelte` only compare the two typed copies.
  navcoin-js's `NavCreateTransaction` and `xNavCreateTransaction` treat any
  string ending in `.nav` as a DotNav name and resolve it through
  `ResolveName`, which asks whichever public electrum node the source is
  connected to — once per source and leg. A hostile node answers with its
  own address; the user only ever saw `alice.nav`. Fix: reject anything
  that is not a valid mainnet NAV or xNAV address in the daemon before
  `executeSweep`.
- **Medium: a source below the fee aborts the sweep and hides what was
  already sent.** Re-checked. `executeSweep` in `sweep.js` spends
  any `nav > 0`, with subtract-fee on and navcoin-js's default fee. In
  `NavCreateTransaction`, `amount < fee` adds no destination output and,
  since inputs equal the amount, no change either; the signed transaction
  has inputs and no outputs, the broadcast fails, and `broadcastLeg`
  throws. Later sources are never swept, and the hashes of earlier legs are
  dropped, so the user sees "Sweep failed" after coins moved. A retry hits
  the same dust source every time. Balances just above the fee (a dust
  output) are suspected to fail the same way, not checked.
- **Medium: a failed read in `GET /status` never gets a reply.** The
  request handler passed to `http.createServer` is async and the `/status`
  branch awaits `readStatus` with no try/catch (every other route has one).
  Until the `unhandledRejection` handler in `daemon.js` (added for the
  server-busy crash) this ended the daemon; now the rejection is logged and
  the request is left open with no response. Not re-tested since.
  `readJsonFileWithRetry` in `app-data.js` rethrows non-`SyntaxError`
  errors (EPERM/EBUSY from antivirus on Windows, EMFILE) and a persistent
  `SyntaxError`. The GUI polls `/status` throughout a sweep.
- **Medium: `/status` and `/import` replies carry the phrase or WIF keys.**
  Re-checked for `/status`. It spreads each record from `sources.json`
  (`...source`), and `source-registry.js` stores `normalizedDetails` in that
  record. Only `wallet-worker.js` reads the field, so the replies could drop
  it. Today it reaches the webview on every poll and the Rust
  `probe_daemon` buffer.
- **Medium: the CLI takes secrets only as arguments.** `handleImport` /
  `parseOptions` in `cli.js`: `--phrase` and `--key` have no stdin or
  prompt fallback, so the secret lands in shell history and is readable in
  `/proc/<pid>/cmdline` while the request runs.
- **Medium: secrets go to whatever holds the daemon port.**
  `daemonRequest` in `daemon-client.js` sends the auth cookie and import
  bodies to the fixed loopback port, and `ensure_daemon` in
  `src-tauri/src/lib.rs` returns `Ok` for `DaemonProbe::Unidentified`. A
  local user who binds the port while the daemon is down receives the
  cookie and every phrase imported. `handleStart` notices a foreign
  listener; `import` and `sweep` do not.
- **Medium: wallet databases are readable by other local users.**
  `bootstrapAppData` creates the app-data and `wallets/` directories with
  default modes; the review saw `drwxr-xr-x` directories and a `-rw-r--r--`
  tx cache. Wallet files are inferred to match. Their encryption password is
  the public `ObsidianSweepKey`. Same root cause as the 644 log above.
- **Low: a rescan leaves the source `synced` for a moment.**
  `runFreshRescan` zeroes the balance while `syncStatus` stays `synced`
  until the first progress event, so a sweep in that window sends nothing
  for the source and reports success. Nothing serialises two
  `/sweep/confirm` calls, or a sweep against `/remove` or `/purge`, either.
- **Low, suspected: a broadcast can count as sent without a hash.**
  navcoin-js's `SendTransactionSingle` returns `undefined` when there is no
  client, which `broadcastLeg` would count as a sent leg. No reachable
  window was found; guarding on "every hash is a non-empty string" is
  cheap.
- Test gaps on these paths: `test/sweep.test.js` mocks transaction creation
  so it always succeeds. Nothing covers a balance below the fee, a later
  source failing after an earlier broadcast (and what the caller learns),
  destination validation, `normalizedDetails` in replies, or `/status`
  failing to read.
- Not reviewed in this pass: `rescue-scan.js`, `electrum-connection.js`,
  `wallet-database.js`, `tx-cache.js`, derivation correctness in
  `mnemonic.js`, change-output handling for private-key sources (which use
  the well-known container mnemonic), `xNavCreateTransaction`'s fee and
  change logic, `tui.js` beyond `cmdSweep`, GUI views other than Sweep and
  Import, `daemon-launch` spawning, the workflows, and Tauri's `csp: null`.

## A network blip in the release build skips the publish

The v0.2.2 run failed on 2026-09-13 with
`Invoke-WebRequest: Unable to write data to the transport connection: An
existing connection was forcibly closed by the remote host.` — the step
in `release.yml` that downloads the bundled node runtime from nodejs.org,
on the Windows job only. The other three platforms had already fetched
theirs. Nothing was retried, so the job failed, and `smoke` and `release`
skipped: a tag on the remote, a green-looking push, and nothing
published. `gh run rerun --failed` got it out.

Each platform downloads its runtime with a single unretried call
(`Invoke-WebRequest` on Windows, `curl` elsewhere). A retry with backoff
around each of them would turn a blip into a slower build instead of a
failed release. Not done here because it changes the release workflow,
which only a tag exercises — so it cannot be verified without cutting
one.

The v0.2.8 run hit the same shape on 2026-11-08 in a different download:
`canvas` (pulled in by indexeddbshim 16) fetches a prebuilt binary from
its GitHub release during `npm install`, and on `test (ubuntu-latest)`
and `test (windows-2022)` that fetch failed (`No prebuilt binaries
found` on Linux although the `linux-x64` asset exists, `Request timed
out` on Windows). It then falls back to compiling, which cannot work on
the runners: no `pixman-1`/`cairo` headers. The test jobs gate `build`,
so everything after them skipped. It surfaced at release time because
the version bump changes `package-lock.json`, which is the
`node_modules` cache key in `_test.yml`, so the tag's run installs from
scratch while the main runs before it hit the cache. Both workflows now
install through `.github/scripts/npm-install.sh`, which retries; v0.2.8
itself was built before that and does not have it, so the first tag to
exercise it is the one after. Installing the cairo/pixman dev packages
would also make the compile fallback work, but adds setup to every job.

Also worth knowing when checking a run: `gh run watch --exit-status`
exited 0 for that failed run. Enumerating the jobs is what caught it.

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

A third npm 12 change matters for anyone who upgrades locally: it refuses
git-protocol dependencies by default (`EALLOWGIT`), and indexeddbshim pulls
sync-promise from GitHub. `allow-git=all` in `.npmrc` fixes that, but npm 11
warns about the unknown key on every command, so it is not committed.

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
  every PR, which would add a Tauri app build per release platform to every
  push.
