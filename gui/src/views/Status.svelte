<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchDaemonStatus } from '../lib/daemon.js';

  let status = $state(null);
  let error = $state(null);
  let loading = $state(true);
  let timer;

  async function refresh() {
    try {
      status = await fetchDaemonStatus();
      error = null;
    } catch (err) {
      error = err.message ?? String(err);
      status = null;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    refresh();
    timer = setInterval(refresh, 2000);
  });

  onDestroy(() => clearInterval(timer));

  function fmtNav(sat) {
    return (Number(sat ?? 0) / 1e8).toFixed(8);
  }

  function totalNav(s) {
    const c = s?.balance?.nav?.confirmed ?? 0;
    const x = s?.balance?.xnav?.confirmed ?? 0;
    return fmtNav(c + x);
  }
</script>

<h2>Status</h2>

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error">Daemon unreachable: {error}</p>
{:else if !status?.sources?.length}
  <p class="muted">No imported sources yet.</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>Source</th>
        <th>Sync</th>
        <th class="num">NAV</th>
        <th class="num">xNAV</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>
      {#each status.sources as s}
        <tr>
          <td class="mono">{s.id}</td>
          <td>{s.syncStatus}</td>
          <td class="num">{fmtNav(s.balance?.nav?.confirmed)}</td>
          <td class="num">{fmtNav(s.balance?.xnav?.confirmed)}</td>
          <td class="num">{totalNav(s)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  h2 {
    margin: 0 0 16px;
  }

  .muted {
    color: var(--muted);
  }

  .error {
    color: var(--pink);
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 8px 10px;
    border-bottom: 1px solid #1f2937;
    text-align: left;
  }

  th {
    color: var(--muted);
    font-weight: 500;
    font-size: 12px;
    text-transform: uppercase;
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
</style>
