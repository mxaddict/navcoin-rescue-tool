// Wallet databases as the indexeddb shim stores them: one sqlite file per
// database, plus a registry file every database in the directory shares.
//
// The shim keeps each sqlite database it opens cached and open for the
// life of the process; an IndexedDB close() leaves the file open. Two
// consequences: on Windows the file cannot be deleted while that process
// lives, and a process that opens the same database name again after the
// file was deleted and recreated gets its cached handle to the deleted
// file back, which sqlite then refuses to write to (SQLITE_READONLY).

// How long sqlite waits for a lock another process holds before giving
// up. The registry and the ___tx___ cache are files every process shares
// — the daemon and each wallet-creation worker — and a phrase's
// derivations are created in parallel. At node-sqlite3's default wait, a
// creation that ran into another's write under load failed with
// UnknownError, the wallet half-created ("Dexie-encrypted can't find its
// encryption table") and the derivation lost.
const SQLITE_BUSY_TIMEOUT_MS = 30_000;

// The shim configuration for a wallets directory. Every process that opens
// wallets uses this, so they all wait for each other the same way.
export function shimConfig(walletsDir) {
  return {
    checkOrigin: false,
    databaseBasePath: walletsDir,
    sysDatabaseBasePath: walletsDir,
    sqlBusyTimeout: SQLITE_BUSY_TIMEOUT_MS,
  };
}

// Remove one database from the shim's registry and drop its stores.
//
// The registry is one file shared by every wallet in the directory, so it
// cannot be deleted to forget a single wallet: that takes every sibling's
// version with it and leaves each of them unopenable.
export function forgetDatabase(indexedDB, databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);

    // Fires while another connection still holds the database. Callers
    // close the wallet first, so waiting here would just hang.
    request.onblocked = () =>
      reject(new Error(`${databaseName} is still open elsewhere`));
    request.onerror = () =>
      reject(request.error ?? new Error(`could not remove ${databaseName}`));
    request.onsuccess = () => resolve();
  });
}

function openDatabase(indexedDB, databaseName, version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error(`could not open ${databaseName}`));
  });
}

function closeSqlite(handle) {
  return new Promise((resolve, reject) => {
    handle.close((err) => (err ? reject(err) : resolve()));
  });
}

// Delete a database this process may have open, through this process's
// own shim — the only way to close the file and drop the cached handle.
// Callers close every wallet using the database first.
//
// Opening the name at its registered version hands back the shim's cached
// instance, so its sqlite handle is the one holding the file. The handle
// is reached through the shim's internals (its WebSQL database, then the
// SQLite wrapper) because nothing public closes it; a shape that does not
// match fails loudly instead of leaving the file held.
export async function destroyDatabase(indexedDB, databaseName) {
  const registered = (await indexedDB.databases()).find(
    (entry) => entry.name === databaseName,
  );
  if (!registered) return;

  const connection = await openDatabase(
    indexedDB,
    databaseName,
    registered.version,
  );
  const handle = connection.__db?._db?._db;
  connection.close();
  if (typeof handle?.close !== 'function') {
    throw new Error(
      `${databaseName} is not the shape wallet-database.js closes ` +
        '(indexeddbshim 16 over node-sqlite3); its file stays open',
    );
  }

  await closeSqlite(handle);
  await forgetDatabase(indexedDB, databaseName);
}

// Destroy every database registered in this process's shim, the shared
// transaction cache (___tx___) included.
export async function destroyAllDatabases(indexedDB) {
  for (const { name } of await indexedDB.databases()) {
    await destroyDatabase(indexedDB, name);
  }
}
