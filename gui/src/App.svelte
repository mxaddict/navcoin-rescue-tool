<script>
  import Status from './views/Status.svelte';

  let view = $state('status');
</script>

<div class="layout">
  <aside class="sidebar">
    <h1 class="brand">navcoin-rescue-tool</h1>
    <nav>
      <button class="nav-btn" class:active={view === 'status'} onclick={() => (view = 'status')}>
        Status
      </button>
    </nav>
  </aside>

  <main class="main">
    {#if view === 'status'}
      <Status />
    {/if}
  </main>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 220px 1fr;
    height: 100%;
  }

  .sidebar {
    background: var(--panel);
    padding: 16px;
    border-right: 1px solid #1f2937;
  }

  .brand {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 16px;
    background: linear-gradient(135deg, var(--fuchsia), var(--cyan));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .nav-btn {
    background: transparent;
    color: var(--muted);
    text-align: left;
    padding: 8px 10px;
    border-radius: 6px;
    font-weight: 500;
  }

  .nav-btn.active {
    background: var(--deep);
    color: var(--text);
  }

  .main {
    padding: 20px;
    overflow: auto;
  }
</style>
