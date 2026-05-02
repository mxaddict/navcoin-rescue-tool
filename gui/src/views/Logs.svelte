<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  let text = $state('');
  let error = $state(null);
  let timer;
  let pre;
  let autoScroll = $state(true);

  async function refresh() {
    try {
      const next = await invoke('read_log_tail');
      const changed = next !== text;
      text = next;
      error = null;
      if (changed && autoScroll) {
        await tick();
        if (pre) pre.scrollTop = pre.scrollHeight;
      }
    } catch (err) {
      error = err.message ?? String(err);
    }
  }

  // Switch off auto-scroll when the user scrolls up; re-enable when they
  // scroll back to the bottom.
  function onScroll() {
    if (!pre) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
    autoScroll = atBottom;
  }

  onMount(() => {
    refresh();
    timer = setInterval(refresh, 1000);
  });

  onDestroy(() => clearInterval(timer));
</script>

<header class="page-header">
  <h2>Logs</h2>
  <div class="actions">
    <button onclick={() => (autoScroll = true)} disabled={autoScroll}>
      Jump to end
    </button>
  </div>
</header>

{#if error}
  <div class="callout error">
    <p>Log read failed: {error}</p>
  </div>
{/if}

<pre class="log" bind:this={pre} onscroll={onScroll}>{text || '(no log output yet)'}</pre>

<style>
  .log {
    background: #0b101a;
    color: #cbd5e1;
    border-radius: 8px;
    padding: 14px 16px;
    margin: 0;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow: auto;
    /* Fill remaining viewport: bar (~50px) + page-header (~50px) +
       container padding (~32px) + a little slack. */
    height: calc(100vh - 170px);
  }
</style>
