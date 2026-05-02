<script>
  import { rescanDaemon, fetchDaemonStatus } from '../lib/daemon.js';

  let busy = $state(false);
  let error = $state(null);
  let started = $state(null);
  let sourceCount = $state(null);

  $effect(() => {
    fetchDaemonStatus()
      .then((s) => (sourceCount = s?.sourceCount ?? 0))
      .catch(() => (sourceCount = null));
  });

  async function submit() {
    busy = true;
    error = null;
    started = null;
    try {
      const res = await rescanDaemon();
      started = res?.started ?? [];
    } catch (err) {
      error = err.message ?? String(err);
    } finally {
      busy = false;
    }
  }
</script>

<h2>Rescan</h2>

<p class="muted">
  Wipes UTXO + transaction state for every imported source and rebuilds it
  from the chain. Keys, mnemonic, and master wallet data are preserved.
</p>

<p class="warn">
  Useful after a sweep, or when reconciliation drifts from
  <code>navcoin-cli</code>. Each rescan re-runs the full receive / change /
  staking / xNAV scan — expect minutes per source.
</p>

<div class="actions">
  <button onclick={submit} disabled={busy || sourceCount === 0}>
    {busy ? 'Starting…' : 'Start rescan'}
  </button>
  {#if sourceCount === 0}
    <p class="muted">No imported sources to rescan.</p>
  {/if}
</div>

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
  h2 {
    margin: 0 0 16px;
  }

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

  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
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
