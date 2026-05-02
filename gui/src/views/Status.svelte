<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchDaemonStatus } from '../lib/daemon.js';
  import { syncLabel } from '../lib/sync.js';

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

  function fmt(sat) {
    return (Number(sat ?? 0) / 1e8).toFixed(8);
  }

  function syncColor(status) {
    if (status === 'synced') return 'teal';
    if (
      status === 'syncing' ||
      status === 'connecting' ||
      status === 'connected' ||
      status === 'opening'
    )
      return 'blue';
    if (status === 'error' || status === 'no-servers') return 'pink';
    return 'muted';
  }

  function typeLabel(s) {
    return s.walletType ? `${s.type}:${s.walletType}` : s.type;
  }

  function totals(sources) {
    const t = {
      navConf: 0,
      navPend: 0,
      xnavConf: 0,
      xnavPend: 0,
    };
    for (const s of sources) {
      t.navConf += s.balance?.nav?.confirmed ?? 0;
      t.navPend += s.balance?.nav?.pending ?? 0;
      t.xnavConf += s.balance?.xnav?.confirmed ?? 0;
      t.xnavPend += s.balance?.xnav?.pending ?? 0;
    }
    t.total = t.navConf + t.navPend + t.xnavConf + t.xnavPend;
    return t;
  }
</script>

<header class="page-header">
  <h2>Status</h2>
</header>

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error">Daemon unreachable: {error}</p>
{:else if !status?.sources?.length}
  <p class="muted">No imported sources yet.</p>
{:else}
  {@const t = totals(status.sources)}

  <div class="cards">
    {#each status.sources as s}
      {@const navConf = s.balance?.nav?.confirmed ?? 0}
      {@const navPend = s.balance?.nav?.pending ?? 0}
      {@const xnavConf = s.balance?.xnav?.confirmed ?? 0}
      {@const xnavPend = s.balance?.xnav?.pending ?? 0}
      {@const total = navConf + navPend + xnavConf + xnavPend}

      <article class="card">
        <header class="card-header">
          <span class="card-title">Source</span>
          <span class="chip">{typeLabel(s)}</span>
          <span class="mono dim">{s.id}</span>
        </header>

        <dl class="rows">
          <div class="row">
            <dt>Sync</dt>
            <dd class={syncColor(s.syncStatus)}>
              {syncLabel(s)}{#if s.server}<span class="dim"
                  >&nbsp; via {s.server}</span
                >{/if}
            </dd>
          </div>

          {#if s.liveError}
            <div class="row">
              <dt class="pink">Error</dt>
              <dd class="pink">{s.liveError}</dd>
            </div>
          {/if}

          <div class="row">
            <dt>Confirmed</dt>
            <dd>
              <span class="cyan mono">{fmt(navConf)}</span> NAV &nbsp;+&nbsp;
              <span class="indigo mono">{fmt(xnavConf)}</span> xNAV
            </dd>
          </div>
          <div class="row">
            <dt>Pending</dt>
            <dd>
              <span class="cyan mono">{fmt(navPend)}</span> NAV &nbsp;+&nbsp;
              <span class="indigo mono">{fmt(xnavPend)}</span> xNAV
            </dd>
          </div>
          <div class="row">
            <dt>Total</dt>
            <dd class="strong mono">{fmt(total)}</dd>
          </div>
        </dl>
      </article>
    {/each}

    <article class="card totals">
      <header class="card-header">
        <span class="card-title gradient">Totals</span>
      </header>

      <dl class="rows">
        <div class="row">
          <dt>NAV</dt>
          <dd>
            <span class="cyan mono">{fmt(t.navConf)}</span>
            <span class="dim">(+{fmt(t.navPend)} pending)</span>
          </dd>
        </div>
        <div class="row">
          <dt>xNAV</dt>
          <dd>
            <span class="indigo mono">{fmt(t.xnavConf)}</span>
            <span class="dim">(+{fmt(t.xnavPend)} pending)</span>
          </dd>
        </div>
        <div class="row">
          <dt>Total</dt>
          <dd class="strong mono">{fmt(t.total)}</dd>
        </div>
      </dl>
    </article>
  </div>
{/if}

<style>
  .muted {
    color: var(--muted);
  }

  .error {
    color: var(--pink);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .card {
    background: var(--panel);
    border-radius: 8px;
    padding: 14px 16px;
    border-left: 3px solid var(--cyan);
  }

  .card.totals {
    background: var(--deep);
  }

  .card-header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 10px;
  }

  .card-title {
    font-weight: 600;
    color: var(--magenta);
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .card-title.gradient {
    background: linear-gradient(135deg, var(--fuchsia), var(--cyan));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .chip {
    background: var(--deep);
    color: var(--muted);
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .rows {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .row {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: baseline;
    gap: 12px;
  }

  dt {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  dd {
    margin: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .mono {
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .strong {
    font-weight: 600;
  }

  .dim {
    color: var(--muted);
  }

  .cyan {
    color: var(--cyan);
  }

  .indigo {
    color: var(--indigo);
  }

  .teal {
    color: var(--teal);
  }

  .blue {
    color: var(--blue);
  }

  .pink {
    color: var(--pink);
  }

  @media (max-width: 500px) {
    .row {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
</style>
