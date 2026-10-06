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
  if (configured) return configured;

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
      const selected =
        healthy.length > 0
          ? [...healthy, ...unhealthy]
          : DEFAULT_MAINNET_ELECTRUM_NODES;

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
  const nodes = await selectElectrumNodes();

  wallet.ClearNodeList();
  for (const node of nodes) {
    wallet.AddNode(node.host, node.port, node.proto);
  }

  // navcoin-js picks a random starting node of its own, which rebuilding
  // the list here discards. Spread the wallets across the list instead of
  // handing every one of them the same server. Healthiest first, so the
  // first wallet opened still gets the best node.
  if (nodes.length === 0) {
    wallet.electrumNodeIndex = 0;
    return;
  }

  wallet.electrumNodeIndex = nextElectrumNodeOffset % nodes.length;
  nextElectrumNodeOffset = (nextElectrumNodeOffset + 1) % nodes.length;
}
