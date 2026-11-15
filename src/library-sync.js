// navcoin-js is a full wallet, and on every connect it syncs like one: it
// subscribes to each address, fetches each address's whole history and
// queues a job for every transaction in it, to keep a transaction list and
// follow the chain live. A rescue needs none of that. The rescue scan
// finds the unspent outputs on its own, and for a wallet with a long
// history the library's sync was still running, on the same database and
// the same server, long after the scan had found everything there is to
// sweep.
//
// navcoin-js has no option to leave its sync out; every path that starts
// one goes through `wallet.Sync`. So that method is replaced on each
// wallet the tool opens. What goes with it: the address subscriptions,
// which `Sync` is what makes, so the wallet no longer hears of coins that
// arrive after a scan. A rescan finds them.

// Keep this wallet from running navcoin-js's own sync.
export function skipLibrarySync(wallet) {
  // Nothing to change on a wallet that has no sync of its own.
  if (typeof wallet.Sync !== 'function') return;
  wallet.Sync = async function skippedSync() {};
}
