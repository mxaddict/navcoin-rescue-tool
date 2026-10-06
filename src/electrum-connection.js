const DEFAULT_MAINNET_ELECTRUM_NODES = [
  { host: 'electrum4.nav.community', port: 40004, proto: 'wss' },
  { host: 'electrum.nextwallet.org', port: 40004, proto: 'wss' },
  { host: 'electrum2.nav.community', port: 40004, proto: 'wss' },
  { host: 'electrum3.nav.community', port: 40004, proto: 'wss' },
  { host: 'electrum.nav.community', port: 40004, proto: 'wss' },
];

// Parse NTR_ELECTRUM_NODES env var (format: "host:port:proto,...").
// When set, use those nodes verbatim and skip probing.
function getConfiguredElectrumNodes() {
  const raw = process.env.NTR_ELECTRUM_NODES;
  if (!raw) return null;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(':');
      return { host: parts[0], port: Number(parts[1]), proto: parts[2] };
    });
}

const ELECTRUM_PROBE_TIMEOUT_MS = 5_000;
// How long one node gets to answer before the next one is tried. A node
// that drops the connection fails at once; this bounds the ones that
// accept the socket and then never reply, or never accept it at all.
export const CONNECT_ATTEMPT_TIMEOUT_MS = 15_000;

let electrumNodeCache = null;
let electrumNodeCacheAt = 0;
let electrumNodeProbePromise = null;
// Which node the next wallet opened should start on. One phrase opens a
// wallet per derivation, so pointing them all at the same server is a
// self-inflicted thundering herd: they connect, scan and reconnect in
// lockstep until the server stops answering their keepalives.
let nextElectrumNodeOffset = 0;

export function resetElectrumNodeSelectionCache() {
  electrumNodeCache = null;
  electrumNodeCacheAt = 0;
  electrumNodeProbePromise = null;
  nextElectrumNodeOffset = 0;
}

function probeElectrumNode(node) {
  return new Promise((resolve) => {
    const url = `${node.proto}://${node.host}:${node.port}`;
    const ws = new WebSocket(url);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // Ignore close errors during probe.
      }
      resolve(ok);
    };

    const timeout = setTimeout(() => finish(false), ELECTRUM_PROBE_TIMEOUT_MS);

    ws.addEventListener('open', () => finish(true), { once: true });
    ws.addEventListener('error', () => finish(false), { once: true });
    ws.addEventListener('close', () => finish(false), { once: true });
  });
}

async function selectElectrumNodes() {
  // When NTR_ELECTRUM_NODES is set, skip probing and use the configured list
  // directly. This allows tests (and CI) to point the daemon at a local stub
  // without requiring WSS or live mainnet access.
  const configured = getConfiguredElectrumNodes();
  if (configured) return { nodes: configured, healthyCount: configured.length };

  const now = Date.now();
  if (electrumNodeCache && now - electrumNodeCacheAt < 60_000) {
    return electrumNodeCache;
  }

  if (!electrumNodeProbePromise) {
    electrumNodeProbePromise = (async () => {
      const results = await Promise.all(
        DEFAULT_MAINNET_ELECTRUM_NODES.map(async (node) => ({
          node,
          ok: await probeElectrumNode(node),
        })),
      );

      const healthy = results.filter((r) => r.ok).map((r) => r.node);
      const unhealthy = results.filter((r) => !r.ok).map((r) => r.node);
      // Unhealthy nodes stay on the list, last, as failover targets: a
      // probe is one moment, and a node down then may be the only one up
      // later. With none healthy the probe told us nothing, so every node
      // counts as a starting point again.
      const selected =
        healthy.length > 0
          ? { nodes: [...healthy, ...unhealthy], healthyCount: healthy.length }
          : {
              nodes: DEFAULT_MAINNET_ELECTRUM_NODES,
              healthyCount: DEFAULT_MAINNET_ELECTRUM_NODES.length,
            };

      electrumNodeCache = selected;
      electrumNodeCacheAt = Date.now();
      return selected;
    })();
  }

  try {
    return await electrumNodeProbePromise;
  } finally {
    electrumNodeProbePromise = null;
  }
}

export async function configureElectrumNodes(wallet) {
  const { nodes, healthyCount } = await selectElectrumNodes();

  wallet.ClearNodeList();
  for (const node of nodes) {
    wallet.AddNode(node.host, node.port, node.proto);
  }

  superviseConnects(wallet);

  // navcoin-js picks a random starting node of its own, which rebuilding
  // the list here discards. Spread the wallets across the healthy nodes
  // instead of handing every one of them the same server. Healthiest
  // first, so the first wallet opened still gets the best node, and never
  // a node the probe already found dead.
  if (healthyCount === 0) {
    wallet.electrumNodeIndex = 0;
    return;
  }

  wallet.electrumNodeIndex = nextElectrumNodeOffset % healthyCount;
  nextElectrumNodeOffset = (nextElectrumNodeOffset + 1) % healthyCount;
}

export function describeElectrumNode(wallet) {
  const node = wallet.electrumNodes?.[wallet.electrumNodeIndex];
  return node ? `${node.host}:${node.port}` : 'no node';
}

export function advanceElectrumNode(wallet) {
  const count = wallet.electrumNodes?.length ?? 0;
  if (count === 0) return;
  const current = Number.isInteger(wallet.electrumNodeIndex)
    ? wallet.electrumNodeIndex
    : 0;
  wallet.electrumNodeIndex = (current + 1) % count;
}

// Try each node once, starting at the wallet's current one. Resolves true
// once one connects, false when every node failed; the wallet is left
// pointing at the node that answered, or back where it started.
export async function connectWithFailover(
  wallet,
  { shouldStop = () => false } = {},
) {
  const count = wallet.electrumNodes?.length ?? 0;

  for (let tried = 0; tried < count; tried++) {
    if (shouldStop()) return false;
    if (await attemptConnect(wallet, CONNECT_ATTEMPT_TIMEOUT_MS)) return true;
    if (shouldStop()) return false;

    const failed = describeElectrumNode(wallet);
    advanceElectrumNode(wallet);
    console.error(
      `[electrum] ${failed} unreachable, trying ${describeElectrumNode(wallet)}`,
    );
  }

  return false;
}

function attemptConnect(wallet, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wallet.off('connected', onConnected);
      wallet.off('connection_failed', onFailed);
      fn(value);
    };
    const onConnected = () => settle(resolve, true);
    const onFailed = () => settle(resolve, false);

    wallet.on('connected', onConnected);
    wallet.on('connection_failed', onFailed);

    // Connect() never settles when the socket fails — the events above are
    // the only signal of that — so it matters here only when it throws or
    // rejects outright: no nodes, or a client that cannot be supervised.
    try {
      Promise.resolve(wallet.Connect()).catch((err) => settle(reject, err));
    } catch (err) {
      settle(reject, err);
    }

    // Started after Connect() because that can already have settled this.
    if (!settled) timer = setTimeout(() => settle(resolve, false), timeoutMs);
  });
}

// What navcoin-js and @aguycalled/electrum-client-js do with a dropped
// connection, and why every client is taken over here:
//
// - The client reconnects to the same host on its own, forever, about
//   once a second, because navcoin-js never passes it a persistence
//   policy. That loop never moves to another node, and the events it fires
//   kept pushing back the timer that would have.
// - navcoin-js only rotates nodes for a few exact error strings, and a
//   websocket close is not one of them.
// - navcoin-js also calls Connect() itself (Sync, on a dropped socket), so
//   wrapping only our own calls would leave its clients unsupervised.
//
// So Connect() is wrapped on the instance: the previous client is retired
// — its listeners removed, its socket closed — and the new one has its
// reconnect loop switched off. Which node comes next is then decided in
// one place, connectWithFailover.
//
// Requests pending on a dead client are deliberately left pending, as the
// client leaves them: navcoin-js awaits its own without handling errors,
// so failing them turns into unhandled rejections that end the process.
// A scan caught by a drop is abandoned through its abort signal instead.
const supervisedWallets = new WeakSet();

function superviseConnects(wallet) {
  if (supervisedWallets.has(wallet)) return;
  supervisedWallets.add(wallet);

  const connect = wallet.Connect;
  wallet.Connect = function supervisedConnect(...args) {
    retireElectrumClient(this);
    const result = connect.apply(this, args);
    superviseClient(this.client);
    return result;
  };
}

// persistencePolicy is assigned by the client's connect(), which Connect()
// has already called by the time a client is supervised; a client without
// it has no reconnect loop this module knows how to switch off.
function assertClientShape(client) {
  if (
    typeof client.close !== 'function' ||
    typeof client.subscribe?.removeAllListeners !== 'function' ||
    !('persistencePolicy' in client)
  ) {
    throw new Error(
      'electrum client is not the shape electrum-connection.js supervises ' +
        '(@aguycalled/electrum-client-js 0.1.x); failover cannot work with it',
    );
  }
}

function superviseClient(client) {
  if (!client) return;
  assertClientShape(client);

  // Read when the socket closes: no retries left plus a callback means the
  // client hands the decision back instead of reconnecting by itself.
  client.persistencePolicy = { maxRetry: 0, callback: () => {} };
}

// Detach the wallet's current client for good: nothing it does afterwards
// reaches the wallet, and it does not reconnect.
export function retireElectrumClient(wallet) {
  const client = wallet.client;
  if (!client) return;
  assertClientShape(client);

  client.subscribe.removeAllListeners();
  client.close();
}
