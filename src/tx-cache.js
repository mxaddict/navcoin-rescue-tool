// navcoin-js caches every transaction it fetches in ___tx___, one table
// keyed by hash that every wallet in the process shares. A lookup checks
// the cache, fetches on a miss, then inserts — so two lookups of one
// transaction in flight together both miss, and the second insert hits
// the key the first just wrote. navcoin-js then logs
// "AddTx error: SQLITE_CONSTRAINT: UNIQUE constraint failed: S_txs.key"
// and carries on. A first sync does exactly that: navcoin-js's own sync on
// connect and the rescue scan look up the same history, and every
// derivation of a phrase looks up the xNAV transactions they share.
//
// The row that won is the one wanted — a transaction never changes — so
// the cache insert is made idempotent instead: a key already present is
// the expected outcome, and any other failure still surfaces as before.

// Replace this wallet's insert into the transaction cache with one that
// treats "already cached" as done.
export function cacheTransactionsOnce(wallet) {
  const store = wallet.db;
  // Nothing to change on a wallet that caches no transactions.
  if (typeof store?.AddTx !== 'function') return;
  if (!store.dbTx?.txs) {
    throw new Error(
      'wallet has no transaction cache of the shape tx-cache.js expects ' +
        '(navcoin-js 1.1 dexie store with a ___tx___ txs table)',
    );
  }

  // Mirrors navcoin-js's AddTx field for field, so the stored row is what
  // it would have stored; only the duplicate-key outcome differs.
  store.AddTx = async function addTxOnce(tx) {
    if (!this.dbTx) return undefined;
    tx.hash = tx.txid;
    delete tx.tx;

    try {
      await this.dbTx.txs.add(tx);
    } catch (err) {
      if (err?.name !== 'ConstraintError') throw err;
    }
    return true;
  };
}
