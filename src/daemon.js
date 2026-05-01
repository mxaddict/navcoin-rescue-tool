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
import { importSource, removeSource } from './source-registry.js';

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

  const logStream = fs.createWriteStream(layout.daemonLogFile, { flags: 'a' });
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== authCookie) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }

    if (request.method === 'GET' && request.url === '/status') {
      const status = await readStatus(root);
      sendJson(response, 200, {
        daemon: status.daemon,
        sourceCount: status.sources.sources.length,
        appData: status.layout.root,
        sources: status.sources.sources,
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/import') {
      try {
        const source = await importSource(await readJsonBody(request), root);
        sendJson(response, 200, { source });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/remove') {
      try {
        const body = await readJsonBody(request);
        const result = await removeSource(body.sourceId, root);
        sendJson(response, 200, result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/daemon/stop') {
      sendJson(response, 200, { ok: true });
      server.close(async () => {
        await writeDaemonState({ status: 'stopped', pid: null }, root);
        process.exit(0);
      });
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
      root
    );
    logStream.write(
      `${new Date().toISOString()} ${error.stack || error.message}\n`
    );
    process.exit(1);
  });

  server.listen(DAEMON_PORT, DAEMON_HOST, async () => {
    await writeDaemonState(
      {
        status: 'running',
        pid: process.pid,
        error: null,
        startedAt: new Date().toISOString(),
      },
      root
    );
    logStream.write(
      `${new Date().toISOString()} daemon started pid=${process.pid}\n`
    );
    process.stdout.write('ready\n');
  });

  const shutdown = async (signal) => {
    logStream.write(
      `${new Date().toISOString()} daemon stopping signal=${signal}\n`
    );
    server.close(async () => {
      await writeDaemonState({ status: 'stopped', pid: null }, root);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
