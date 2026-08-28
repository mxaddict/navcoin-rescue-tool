import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const projectRoot = path.join(import.meta.dirname, '..');
const projectTmpDir = path.join(projectRoot, 'tmp');

export async function makeProjectTempDir(prefix) {
  await fs.mkdir(projectTmpDir, { recursive: true });
  return fs.mkdtemp(path.join(projectTmpDir, `${prefix}-`));
}

export function getProjectRoot() {
  return projectRoot;
}

/**
 * Build method-aware JSON-RPC reply for a navcoin-js electrum request.
 *
 * @param {object} msg  - parsed JSON-RPC request {id, method, params}
 * @param {object|null} fixture - optional fixture loaded from mainnet-fake.json
 * @returns {object} JSON-RPC result object (result field, no error)
 *                   or null to fall back to the generic error reply.
 */
function buildElectrumReply(msg, fixture) {
  const method = msg.method;
  const params = Array.isArray(msg.params) ? msg.params : [];

  switch (method) {
    case 'server.version':
      return ['StubElectrum 1.0', '1.4'];

    case 'server.banner':
      return '';

    case 'server.ping':
      return null;

    case 'blockchain.relayfee':
      return 0.00001;

    case 'blockchain.headers.subscribe':
      if (fixture) {
        return { height: fixture.header.height, hex: fixture.header.hex };
      }
      return { height: 5000000, hex: '00'.repeat(80) };

    case 'blockchain.consensus.subscribe':
      // Return minimal consensus params so the wallet doesn't crash.
      return {};

    case 'blockchain.dao.subscribe':
      return [];

    case 'blockchain.outpoint.subscribe':
    case 'blockchain.outpoint.unsubscribe':
      return null;

    case 'blockchain.staking.get_keys':
      return [];

    case 'blockchain.scripthash.subscribe': {
      const sh = params[0];
      if (fixture && fixture.scripthashes[sh]) {
        const entry = fixture.scripthashes[sh];
        // Return non-null status when there is history so the wallet
        // knows to fetch it; return null when empty (no activity).
        return entry.history.length > 0 ? 'stub-status-known' : null;
      }
      return null;
    }

    case 'blockchain.scripthash.get_history': {
      const sh = params[0];
      if (fixture && fixture.scripthashes[sh]) {
        return {
          history: fixture.scripthashes[sh].history,
          to_height: -1,
        };
      }
      return { history: [], to_height: -1 };
    }

    case 'blockchain.scripthash.listunspent': {
      const sh = params[0];
      if (fixture && fixture.scripthashes[sh]) {
        return fixture.scripthashes[sh].unspent;
      }
      return [];
    }

    case 'blockchain.transaction.get': {
      const txid = params[0];
      if (fixture && fixture.transactions[txid]) {
        return fixture.transactions[txid];
      }
      // Unknown tx — fall through to error reply.
      return null;
    }

    case 'blockchain.transaction.get_merkle': {
      // Return a plausible merkle proof so wallet.GetTx can set tx.height.
      const txid = params[0];
      if (fixture) {
        // Find the height from whichever scripthash entry references this txid.
        let txHeight = fixture.header.height - 100;
        for (const entry of Object.values(fixture.scripthashes)) {
          const hist = entry.history.find((h) => h.tx_hash === txid);
          if (hist) {
            txHeight = hist.height;
            break;
          }
        }
        return {
          block_height: txHeight,
          pos: 0,
          merkle: [],
        };
      }
      return { block_height: 4999900, pos: 0, merkle: [] };
    }

    case 'blockchain.transaction.get_keys': {
      const txid = params[0];
      // If the fixture has per-tx output keys for this txid, return them so
      // hasOwnedXNavOutput can identify owned CT outputs.  For all other txids
      // return a safe empty object (the wallet crashes if it receives null
      // because it does txKeys.txidkeys = hash unconditionally).
      if (fixture?.txKeys?.[txid]) {
        return fixture.txKeys[txid];
      }
      return { vin: [], vout: [] };
    }

    case 'blockchain.stakervote.subscribe':
      return null;

    default:
      // Unknown method — signal caller to send the generic error reply.
      return undefined;
  }
}

/**
 * Start a minimal WebSocket stub server that accepts any connection, performs
 * the RFC-6455 handshake, and responds to every JSON-RPC message with a
 * generic error reply.  No external dependencies — uses only Node.js built-ins.
 *
 * When `fixture` is provided the stub becomes method-aware and serves
 * real data (scripthash history, unspent outputs, transactions) so that
 * navcoin-js can complete a full wallet sync against it.
 *
 * @param {object|null} fixture - optional fixture object (from mainnet-fake.json)
 * Returns { port, close } where close() returns a Promise that resolves when
 * the server is fully shut down.
 */
export function startStubElectrumServer(fixture = null) {
  return new Promise((resolve) => {
    const sockets = new Set();

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));

      let upgraded = false;
      let headerBuf = Buffer.alloc(0);
      let frameBuf = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        if (!upgraded) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const str = headerBuf.toString('latin1');
          const headerEnd = str.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;

          const keyMatch = str.match(/Sec-WebSocket-Key: ([^\r\n]+)/);
          if (!keyMatch) {
            socket.destroy();
            return;
          }

          const key = keyMatch[1].trim();
          const accept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');

          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );

          upgraded = true;
          // Any bytes after the HTTP headers are the start of WS frames.
          const remaining = headerBuf.slice(headerEnd + 4);
          headerBuf = Buffer.alloc(0);
          if (remaining.length > 0) processFrames(remaining);
        } else {
          processFrames(chunk);
        }
      });

      function processFrames(data) {
        frameBuf = Buffer.concat([frameBuf, data]);

        while (frameBuf.length >= 2) {
          let offset = 0;
          const b1 = frameBuf[offset + 1];
          const masked = (b1 & 0x80) !== 0;
          let payloadLen = b1 & 0x7f;
          offset += 2;

          if (payloadLen === 126) {
            if (frameBuf.length < offset + 2) break;
            payloadLen = frameBuf.readUInt16BE(offset);
            offset += 2;
          } else if (payloadLen === 127) {
            if (frameBuf.length < offset + 8) break;
            payloadLen = Number(frameBuf.readBigUInt64BE(offset));
            offset += 8;
          }

          const maskSize = masked ? 4 : 0;
          const frameEnd = offset + maskSize + payloadLen;
          if (frameBuf.length < frameEnd) break;

          let payload = frameBuf.slice(offset + maskSize, frameEnd);
          if (masked) {
            const maskKey = frameBuf.slice(offset, offset + 4);
            payload = Buffer.from(payload);
            for (let i = 0; i < payload.length; i++) {
              payload[i] ^= maskKey[i % 4];
            }
          }

          frameBuf = frameBuf.slice(frameEnd);

          try {
            const msg = JSON.parse(payload.toString('utf8'));
            let result = buildElectrumReply(msg, fixture);
            let replyObj;
            if (result === undefined) {
              // Unknown method — generic error fallback.
              replyObj = {
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32601, message: 'stub' },
              };
            } else {
              replyObj = { jsonrpc: '2.0', id: msg.id, result };
            }
            const reply = JSON.stringify(replyObj);
            const replyBuf = Buffer.from(reply, 'utf8');
            // Build an unmasked server text frame.
            let header;
            if (replyBuf.length < 126) {
              header = Buffer.alloc(2);
              header[0] = 0x81;
              header[1] = replyBuf.length;
            } else if (replyBuf.length < 65536) {
              header = Buffer.alloc(4);
              header[0] = 0x81;
              header[1] = 126;
              header.writeUInt16BE(replyBuf.length, 2);
            } else {
              header = Buffer.alloc(10);
              header[0] = 0x81;
              header[1] = 127;
              header.writeBigUInt64BE(BigInt(replyBuf.length), 2);
            }
            socket.write(Buffer.concat([header, replyBuf]));
          } catch {
            // Non-JSON or control frames (ping/close) — ignore.
          }
        }
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;

      const close = () =>
        new Promise((res) => {
          // Destroy open sockets so server.close() doesn't hang.
          for (const s of sockets) s.destroy();
          sockets.clear();
          server.close(() => res());
        });

      resolve({ port, close });
    });
  });
}

// Daemon process lifecycle, shared by every test that needs a live daemon
// rather than a stub. Booting one pulls in navcoin-js and its native
// dependencies, which is why the ready wait is generous — the test still
// fails if 'ready' never arrives, this only bounds how long it waits.
// Every test that needs a live daemon binds this one port, and
// daemon-client.js reads its port from the environment once at import, so
// they cannot be given one each. `npm test` therefore runs test files
// serially (--test-concurrency=1); dropping that makes two files race for
// the port and fail in whichever one loses.
export const TEST_DAEMON_PORT = 46199;
const DAEMON_READY_TIMEOUT_MS = 30_000;

// Kill anything still holding the test daemon port from a previous run
// (interrupted test, leaked process, stale local worker). lsof isn't
// available on Windows and isn't needed on a fresh CI worker — skip
// silently when it's missing.
export function killPortHolders(port = TEST_DAEMON_PORT) {
  const result = spawnSync('lsof', ['-ti', `tcp:${port}`], {
    encoding: 'utf8',
  });
  if (result.error) return;

  for (const pid of result.stdout.trim().split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export function spawnDaemon({
  root,
  stubPort,
  port = TEST_DAEMON_PORT,
  projectRoot: cwd = getProjectRoot(),
}) {
  return spawn(process.execPath, ['src/daemon.js'], {
    cwd,
    env: {
      ...process.env,
      NTR_APP_DATA: root,
      NTR_DAEMON_PORT: String(port),
      NTR_ELECTRUM_NODES: `127.0.0.1:${stubPort}:ws`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function waitForDaemonReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(
      () => reject(new Error('daemon ready timeout')),
      DAEMON_READY_TIMEOUT_MS,
    );

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`daemon exited early: ${code}`));
    });
  });
}

export function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', resolve));
}
