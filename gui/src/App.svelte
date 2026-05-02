<script>
  import Status from './views/Status.svelte';
  import Import from './views/Import.svelte';
  import Rescan from './views/Rescan.svelte';
  import Purge from './views/Purge.svelte';
  import navioLogo from './assets/navio-icon.svg';

  const VIEWS = [
    { id: 'status', label: 'Status' },
    { id: 'import', label: 'Import' },
    { id: 'rescan', label: 'Rescan' },
    { id: 'purge', label: 'Purge' },
  ];

  let view = $state('status');
</script>

<div class="layout">
  <aside class="sidebar">
    <div class="bar-inner">
      <div class="brand">
        <img src={navioLogo} alt="Navio" class="logo" />
        <span class="brand-suffix">Navcoin Rescue Tool</span>
      </div>
      <nav>
        {#each VIEWS as v}
          <button
            class="nav-btn"
            class:active={view === v.id}
            onclick={() => (view = v.id)}
          >
            {v.label}
          </button>
        {/each}
      </nav>
    </div>
  </aside>

  <main class="main">
    <div class="container">
      {#if view === 'status'}
        <Status />
      {:else if view === 'import'}
        <Import />
      {:else if view === 'rescan'}
        <Rescan />
      {:else if view === 'purge'}
        <Purge />
      {/if}
    </div>
  </main>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    height: 100%;
  }

  .sidebar {
    background: linear-gradient(135deg, var(--magenta), var(--blue));
    padding: 10px 14px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.25);
  }

  .bar-inner {
    display: flex;
    align-items: center;
    gap: 16px;
    max-width: 900px;
    margin: 0 auto;
    flex-wrap: wrap;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .logo {
    height: 24px;
    /* Browser-computed width from viewBox can be flaky in WebKitGTK
       when the SVG has no intrinsic size; the explicit ratio guarantees
       the right edge of the logo isn't clipped against the chip's
       right padding. */
    width: calc(24px * (817 / 664));
    display: block;
    background: var(--deep);
    padding: 8px 10px;
    border-radius: 8px;
    box-sizing: content-box;
  }

  .brand-suffix {
    font-size: 14px;
    font-weight: 600;
    color: white;
  }

  nav {
    display: flex;
    flex-direction: row;
    gap: 4px;
    flex-wrap: wrap;
  }

  .nav-btn {
    background: transparent;
    color: rgba(255, 255, 255, 0.75);
    text-align: center;
    padding: 6px 12px;
    border-radius: 6px;
    font-weight: 500;
  }

  .nav-btn:hover {
    color: white;
    background: rgba(255, 255, 255, 0.1);
  }

  .nav-btn.active {
    background: rgba(0, 0, 0, 0.25);
    color: white;
  }

  .main {
    padding: 16px;
    overflow: auto;
    min-width: 0;
  }

  .container {
    max-width: 900px;
    margin: 0 auto;
  }
</style>
