<script>
  import { onMount, onDestroy } from 'svelte';
  import { rescanDaemon, fetchDaemonStatus } from '../lib/daemon.js';

  let busy = $state(false);
  let error = $state(null);
  let started = $state(null);
  let sourceCount = $state(null);
  let anyScanning = $state(false);
  let timer;

  // States that mean the daemon is actively scanning and a new rescan
  // would be ignored / queued. Mirrors rescanAllSources skip rules in
  // src/wallet-manager.js.
  const SCANNING = new Set(['syncing', 'connecting', 'opening']);

  async function refresh() {
    try {
      const s = await fetchDaemonStatus();
      sourceCount = s?.sourceCount ?? 0;
      anyScanning = (s?.sources ?? []).some((src) =>
        SCANNING.has(src.syncStatus),
      );
    } catch {
      sourceCount = null;
      anyScanning = false;
    }
  }

  onMount(() => {
    refresh();
    timer = setInterval(refresh, 2000);
  });

  onDestroy(() => clearInterval(timer));

  async function submit() {
    busy = true;
    error = null;
    started = null;
    try {
      const res = await rescanDaemon();
      started = res?.started ?? [];
      // Refresh immediately so the button reflects the new syncing state.
      await refresh();
    } catch (err) {
      error = err.message ?? String(err);
    } finally {
      busy = false;
    }
  }
</script>

<header class="page-header">
  <h2>Rescan</h2>
  <div class="actions">
    <button
      onclick={submit}
      disabled={busy || sourceCount === 0 || anyScanning}
    >
      {busy ? 'Starting…' : anyScanning ? 'Scanning…' : 'Start rescan'}
    </button>
  </div>
</header>

<p class="muted">
  Wipes UTXO + transaction state for every imported source and rebuilds it
  from the chain. Keys, mnemonic, and master wallet data are preserved.
</p>

<p class="warn">
  Useful after a sweep, or when reconciliation drifts from
  <code>navcoin-cli</code>. Each rescan re-runs the full receive / change /
  staking / xNAV scan — expect minutes per source.
</p>

{#if sourceCount === 0}
  <p class="muted">No imported sources to rescan.</p>
{:else if anyScanning}
  <p class="muted">A scan is already in progress — see Status for progress.</p>
{/if}

{#if error}
  <p class="error">Rescan failed: {error}</p>
{/if}

{#if started}
  {#if started.length === 0}
    <p class="muted">
      No sources were eligible — they may already be syncing or in error state.
    </p>
  {:else}
    <p class="ok">Rescan started for {started.length} source(s):</p>
    <ul class="mono">
      {#each started as id}
        <li>{id}</li>
      {/each}
    </ul>
    <p class="muted">Watch the Status view for per-source progress.</p>
  {/if}
{/if}

<style>
  .muted {
    color: var(--muted);
  }

  .warn {
    background: var(--panel);
    border-left: 3px solid var(--warn);
    padding: 12px;
    border-radius: 6px;
  }

  code {
    background: var(--deep);
    padding: 1px 6px;
    border-radius: 4px;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .error {
    color: var(--pink);
  }

  .ok {
    color: var(--teal);
  }

  ul.mono {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    font-size: 13px;
  }

  ul.mono li {
    padding: 4px 0;
    color: var(--text);
  }
</style>
