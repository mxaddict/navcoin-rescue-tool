<script>
  import Status from './views/Status.svelte';
  import Import from './views/Import.svelte';

  const VIEWS = [
    { id: 'status', label: 'Status' },
    { id: 'import', label: 'Import' },
  ];

  let view = $state('status');
</script>

<div class="layout">
  <aside class="sidebar">
    <h1 class="brand">navcoin-rescue-tool</h1>
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
  </aside>

  <main class="main">
    {#if view === 'status'}
      <Status />
    {:else if view === 'import'}
      <Import />
    {/if}
  </main>
</div>

<style>
  /* Wide: sidebar on the left. Narrow: bar across the top.
     Threshold tuned so a single nav button + brand fits the bar
     without wrap on most laptop widths. */
  .layout {
    display: grid;
    grid-template-columns: 220px 1fr;
    grid-template-rows: 1fr;
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
    /* Without min-width: 0 a wide grid item (e.g. a long status table)
       expands the grid track past the viewport, which keeps the side-by-
       side layout visually wide even when the media query has fired. */
    min-width: 0;
  }

  @media (max-width: 900px) {
    .layout {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }

    .sidebar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 14px;
      border-right: 0;
      border-bottom: 1px solid #1f2937;
    }

    .brand {
      margin: 0;
      flex-shrink: 0;
    }

    nav {
      flex-direction: row;
      gap: 4px;
      flex-wrap: wrap;
    }

    .nav-btn {
      text-align: center;
      padding: 6px 12px;
    }
  }
</style>
