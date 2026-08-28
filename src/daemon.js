#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import process from 'node:process';

import {
  bootstrapAppData,
  ensureAuthCookie,
  getAppDataRoot,
  getLayout,
  readStatus,
  writeDaemonState,
} from './app-data.js';
import { APP_VERSION, DAEMON_HOST, DAEMON_PORT } from './constants.js';
import {
  createImportedWallet,
  getNavWallet,
  resetNavcoinJs,
} from './navcoin-js-adapter.js';
import {
  importSources,
  markSourceFailed,
  removeSource,
  readSources,
  purgeAllSources,
} from './source-registry.js';
import {
  openSourceWallet,
  closeSourceWallet,
  closeAllWallets,
  getSourceState,
  prepareSweep,
  executeSweep,
  purgeAllWallets,
  rescanAllSources,
} from './wallet-manager.js';

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const root = process.env.NTR_APP_DATA || getAppDataRoot();
  const layout = getLayout(root);

  await bootstrapAppData(root);
  const authCookie = await ensureAuthCookie(root);

  // Open existing imported source wallets in background (non-blocking).
  getNavWallet(root)
    .then(async (navWallet) => {
      const stored = await readSources(root);
      console.log(`[daemon] opening ${stored.sources.length} source(s)...`);
      for (const source of stored.sources) {
        console.log(`[daemon] opening source: ${source.id} (${source.type})`);
        openSourceWallet(source, root, navWallet).catch((err) => {
          console.log(
            `[daemon] failed to open wallet ${source.id}: ${err.message}`,
          );
        });
      }
    })
    .catch(() => {});

  const logStream = fs.createWriteStream(layout.daemonLogFile, { flags: 'a' });

  console.log(`[daemon] log file: ${layout.daemonLogFile}`);

  let shuttingDown = false;
  let shutdownPromise = null;
  const sockets = new Set();

  async function performShutdown() {
    if (shutdownPromise) return shutdownPromise;

    shuttingDown = true;
    shutdownPromise = (async () => {
      const forceExitTimer = setTimeout(() => {
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {}
        }
        process.exit(0);
      }, 5000);
      forceExitTimer.unref();

      try {
        await closeAllWallets();
      } catch {}

      try {
        await writeDaemonState({ status: 'stopped', pid: null }, root);
      } catch {}

      clearTimeout(forceExitTimer);
      process.exit(0);
    })();

    try {
      server.close(() => {
        shutdownPromise.catch(() => {});
      });
      server.closeIdleConnections?.();
    } catch {}

    return shutdownPromise;
  }

  const server = http.createServer(async (request, response) => {
    // Permissive CORS so the Tauri GUI webview (origin
    // http://localhost:1420 in dev, tauri://localhost in prod) can fetch
    // the daemon directly. Auth still gates every request — without the
    // cookie file (mode 0600 in the user's app-data dir) any caller
    // gets a 401 regardless of origin.
    //
    // WebKitGTK (Linux Tauri webview) won't send the Authorization header
    // on a cross-origin request unless the response advertises
    // Access-Control-Allow-Credentials: true; that header in turn
    // forbids a wildcard Allow-Origin, so we echo the request origin.
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Vary', 'Origin');
    } else {
      response.setHeader('Access-Control-Allow-Origin', '*');
    }
    response.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (shuttingDown && request.url !== '/daemon/stop') {
      sendJson(response, 503, { error: 'Daemon is shutting down' });
      return;
    }

    if (request.headers.authorization !== authCookie) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    if (request.method === 'GET' && request.url === '/status') {
      const status = await readStatus(root);

      const sources = status.sources.sources.map((source) => {
        const live = getSourceState(source.id);
        return {
          ...source,
          syncStatus: live?.syncStatus ?? source.syncStatus,
          syncPhase: live?.syncPhase ?? null,
          syncProgress: live?.syncProgress ?? 0,
          syncCurrent: live?.syncCurrent ?? 0,
          syncTotal: live?.syncTotal ?? 0,
          connected: live?.connected ?? false,
          server: live?.server ?? null,
          addresses: live?.addresses ?? [],
          balance: live?.balance ?? {
            nav: { confirmed: 0, pending: 0 },
            xnav: { confirmed: 0, pending: 0 },
            staked: { confirmed: 0, pending: 0 },
          },
          // Falls back to the persisted error so a wallet that failed
          // to build in the background — and so has no live state at
          // all — still reports why instead of looking empty.
          liveError: live?.error ?? source.error ?? null,
        };
      });

      sendJson(response, 200, {
        version: APP_VERSION,
        daemon: status.daemon,
        sourceCount: sources.length,
        appData: status.layout.root,
        sources,
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/import') {
      try {
        const body = await readJsonBody(request);
        console.log(`[daemon] importing ${body.type} source...`);

        // Import source metadata only (non-blocking - skip wallet creation).
        const { importId, sources } = await importSources(body, root, {
          createImportedWallet: async () => ({}),
        });
        console.log(
          `[daemon] imported ${importId} as ${sources.length} source(s): ` +
            `${sources.map((s) => s.walletType ?? s.type).join(', ')}; ` +
            `creating wallets in background...`,
        );

        // Create wallets in background (non-blocking). Each derivation is
        // independent, so one failing must not stop the others — the whole
        // point of deriving several is that only some of them are real.
        for (const source of sources) {
          createImportedWallet(source, root)
            .then(() => {
              console.log(
                `[daemon] wallet created for ${source.id} ` +
                  `(${source.walletType ?? source.type}), opening...`,
              );
              return getNavWallet(root);
            })
            .then((navWallet) => {
              console.log(`[daemon] opening wallet and syncing...`);
              openSourceWallet(source, root, navWallet).catch((err) => {
                console.log(
                  `[daemon] failed to open wallet ${source.id}: ${err.message}`,
                );
              });
            })
            .catch(async (err) => {
              console.log(
                `[daemon] background wallet creation failed for ` +
                  `${source.id}: ${err.message}`,
              );
              // Persisted so /status can report it. Without this the
              // source reads as a wallet that synced to zero.
              await markSourceFailed(source.id, err.message, root).catch(
                (writeError) => {
                  console.log(
                    `[daemon] could not record the failure of ` +
                      `${source.id}: ${writeError.message}`,
                  );
                },
              );
            });
        }

        sendJson(response, 200, { importId, sources });
      } catch (error) {
        console.log(`[daemon] import failed: ${error.message}`);
        // `code` lets a client recognise a checksum rejection it may offer
        // to override without matching on the message text.
        sendJson(response, 400, {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.waivable === true ? { waivable: true } : {}),
        });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/remove') {
      try {
        const body = await readJsonBody(request);
        await closeSourceWallet(body.sourceId);
        const result = await removeSource(body.sourceId, root);
        resetNavcoinJs();
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/purge') {
      try {
        await closeAllWallets();
        await purgeAllWallets();
        const result = await purgeAllSources(root);
        resetNavcoinJs();
        sendJson(response, 200, result);
        response.on('finish', () => {
          void performShutdown();
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/rescan') {
      try {
        const result = await rescanAllSources();
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/sweep/prepare') {
      try {
        const preview = prepareSweep();
        sendJson(response, 200, { preview });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/sweep/confirm') {
      try {
        const body = await readJsonBody(request);

        if (!body.destination) {
          throw new Error('destination is required');
        }

        if (body.confirmPhrase !== 'SEND MY COINS') {
          throw new Error(
            'confirmPhrase must be exactly "SEND MY COINS" to proceed',
          );
        }

        // Re-validate sync state at confirm time.
        prepareSweep();

        const result = await executeSweep(body.destination);
        sendJson(response, 200, { result });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/daemon/stop') {
      sendJson(response, 200, { ok: true });
      void performShutdown();
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  });

  server.on('error', async (error) => {
    await writeDaemonState(
      {
        status: 'error',
        pid: null,
        error:
          error.code === 'EADDRINUSE'
            ? `Port ${DAEMON_PORT} already in use`
            : error.message,
      },
      root,
    );
    logStream.write(
      `${new Date().toISOString()} ${error.stack || error.message}\n`,
    );
    process.exit(1);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  server.listen(DAEMON_PORT, DAEMON_HOST, async () => {
    await writeDaemonState(
      {
        status: 'running',
        pid: process.pid,
        error: null,
        startedAt: new Date().toISOString(),
      },
      root,
    );
    logStream.write(
      `${new Date().toISOString()} daemon started pid=${process.pid} version=${APP_VERSION}\n`,
    );
    process.stdout.write('ready\n');
  });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    logStream.write(
      `${new Date().toISOString()} daemon stopping signal=${signal}\n`,
    );
    void performShutdown();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
