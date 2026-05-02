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
import { DAEMON_HOST, DAEMON_PORT } from './constants.js';
import {
  createImportedWallet,
  getNavWallet,
  resetNavcoinJs,
} from './navcoin-js-adapter.js';
import {
  importSource,
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
  function log(msg) {
    const timestamp = new Date().toISOString();
    logStream.write(`${timestamp} ${msg}\n`);
    console.log(`[daemon] ${msg}`);
  }

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
          liveError: live?.error ?? null,
        };
      });

      sendJson(response, 200, {
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
        const source = await importSource(body, root, {
          createImportedWallet: async () => ({}),
        });
        console.log(
          `[daemon] imported ${source.id} (${source.walletType}), creating wallet in background...`,
        );

        // Create wallet in background (non-blocking).
        createImportedWallet(source, root)
          .then(() => {
            console.log(
              `[daemon] wallet created (deriving addresses...), opening...`,
            );
            return getNavWallet(root);
          })
          .then((navWallet) => {
            console.log(`[daemon] opening wallet and syncing...`);
            openSourceWallet(source, root, navWallet).catch((err) => {
              console.log(`[daemon] failed to open wallet: ${err.message}`);
            });
          })
          .catch((err) => {
            console.log(
              `[daemon] background wallet creation failed: ${err.message}`,
            );
          });

        sendJson(response, 200, { source });
      } catch (error) {
        console.log(`[daemon] import failed: ${error.message}`);
        sendJson(response, 400, { error: error.message });
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
            ? 'Port 46117 already in use'
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
      `${new Date().toISOString()} daemon started pid=${process.pid}\n`,
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
