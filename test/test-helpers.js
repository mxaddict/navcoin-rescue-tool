import crypto from 'node:crypto';
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
 * Start a minimal WebSocket stub server that accepts any connection, performs
 * the RFC-6455 handshake, and responds to every JSON-RPC message with a
 * generic error reply.  No external dependencies — uses only Node.js built-ins.
 *
 * Returns { port, close } where close() returns a Promise that resolves when
 * the server is fully shut down.
 */
export function startStubElectrumServer() {
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
            const reply = JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32601, message: 'stub' },
            });
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
