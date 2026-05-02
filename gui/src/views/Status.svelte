<script>
  import { onMount, onDestroy } from 'svelte';
  import { fetchDaemonStatus, rescanDaemon } from '../lib/daemon.js';
  import { syncLabel } from '../lib/sync.js';

  let status = $state(null);
  let error = $state(null);
  let loading = $state(true);
  let timer;

  let rescanBusy = $state(false);
  let rescanError = $state(null);
  let rescanStarted = $state(null);

  // States that mean a scan is in flight; while any source is in one,
  // the rescan button is disabled to match wallet-manager skip rules.
  const SCANNING = new Set(['syncing', 'connecting', 'opening']);

  let sources = $derived(status?.sources ?? []);
  let anyScanning = $derived(sources.some((s) => SCANNING.has(s.syncStatus)));

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

  async function triggerRescan() {
    rescanBusy = true;
    rescanError = null;
    rescanStarted = null;
    try {
      const res = await rescanDaemon();
      rescanStarted = res?.started ?? [];
      await refresh();
    } catch (err) {
      rescanError = err.message ?? String(err);
    } finally {
      rescanBusy = false;
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
  <div class="actions">
    <button
      onclick={triggerRescan}
      disabled={rescanBusy || sources.length === 0 || anyScanning}
    >
      {rescanBusy
        ? 'Starting…'
        : anyScanning
          ? 'Scanning…'
          : 'Start rescan'}
    </button>
  </div>
</header>

{#if rescanError}
  <div class="callout error">
    <p>Rescan failed: {rescanError}</p>
  </div>
{/if}

{#if rescanStarted}
  {#if rescanStarted.length === 0}
    <div class="callout warn">
      <p>
        No sources were eligible — they may already be syncing or in error
        state.
      </p>
    </div>
  {:else}
    <div class="callout success">
      <p>Rescan started for {rescanStarted.length} source(s).</p>
    </div>
  {/if}
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error">Daemon unreachable: {error}</p>
{:else if sources.length === 0}
  <p class="muted">No imported sources yet.</p>
{:else}
  {@const t = totals(sources)}

  <div class="cards">
    {#each sources as s}
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
            <dt>NAV</dt>
            <dd class="totals-line">
              <span class="num cyan mono">{fmt(navConf)}</span>
              <span class="dim">(+{fmt(navPend)} pending)</span>
            </dd>
          </div>
          <div class="row">
            <dt>xNAV</dt>
            <dd class="totals-line">
              <span class="num indigo mono">{fmt(xnavConf)}</span>
              <span class="dim">(+{fmt(xnavPend)} pending)</span>
            </dd>
          </div>
          <div class="row">
            <dt>Total</dt>
            <dd class="totals-line">
              <span class="num strong mono">{fmt(total)}</span>
            </dd>
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
          <dd class="totals-line">
            <span class="num cyan mono">{fmt(t.navConf)}</span>
            <span class="dim">(+{fmt(t.navPend)} pending)</span>
          </dd>
        </div>
        <div class="row">
          <dt>xNAV</dt>
          <dd class="totals-line">
            <span class="num indigo mono">{fmt(t.xnavConf)}</span>
            <span class="dim">(+{fmt(t.xnavPend)} pending)</span>
          </dd>
        </div>
        <div class="row">
          <dt>Total</dt>
          <dd class="totals-line">
            <span class="num strong mono">{fmt(t.total)}</span>
          </dd>
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
    border-left-color: var(--pink-soft);
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

  /* Source balance lines: flex packed to the left so there's no
     stretched whitespace between NAV and xNAV. Numbers get a fixed
     min-width with right alignment so decimals stack vertically
     across Confirmed / Pending / Total rows. */
  .amounts {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .amounts .num {
    min-width: 130px;
    text-align: right;
  }

  .amounts .unit {
    color: var(--muted);
    font-size: 12px;
  }

  .amounts .plus {
    color: var(--muted);
    margin: 0 4px;
  }

  /* Totals card has only one number per row plus an optional dim
     trailing note — flex with right-aligned number, free-flowing
     trailing text, no wrapping mid-clause. */
  .totals-line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  .totals-line .num {
    min-width: 130px;
    text-align: right;
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
