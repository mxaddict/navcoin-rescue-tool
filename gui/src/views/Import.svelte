<script>
  import { importSource, fetchDaemonStatus } from '../lib/daemon.js';
  import { getStorageWarningLines } from '../lib/storage-warning.js';

  const WALLET_TYPES = [
    'navcoin-core',
    'navcash',
    'next',
    'navpay',
    'navcoin-js-v1',
  ];

  let kind = $state('mnemonic');
  let walletType = $state('navcoin-core');
  let phrase = $state('');
  let keysText = $state('');
  let busy = $state(false);
  let error = $state(null);
  let result = $state(null);
  let warningLines = $state([]);

  async function submit() {
    busy = true;
    error = null;
    result = null;
    warningLines = [];
    try {
      let payload;
      if (kind === 'mnemonic') {
        if (!phrase.trim()) throw new Error('Mnemonic phrase required.');
        payload = { type: 'mnemonic', walletType, phrase: phrase.trim() };
      } else {
        const keys = keysText
          .split(/\s+/)
          .map((k) => k.trim())
          .filter(Boolean);
        if (keys.length === 0) throw new Error('Enter at least one WIF key.');
        payload = { type: 'private-key', keys };
      }

      const res = await importSource(payload);
      result = res.source;

      try {
        const status = await fetchDaemonStatus();
        if (status?.appData) {
          warningLines = getStorageWarningLines(`${status.appData}/wallets`);
        }
      } catch {
        // Non-fatal: skip warning if status read fails.
      }

      phrase = '';
      keysText = '';
    } catch (err) {
      error = err.message ?? String(err);
    } finally {
      busy = false;
    }
  }
</script>

<header class="page-header">
  <h2>Import</h2>
  <div class="actions">
    <button onclick={submit} disabled={busy}>
      {busy ? 'Importing…' : 'Import'}
    </button>
  </div>
</header>

<div class="callout warn">
  <p>
    Recovery material lives only on this machine. After a successful sweep,
    visit Purge to wipe imported wallets from disk.
  </p>
</div>

<section class="card">
  <div class="kind-toggle" role="tablist" aria-label="Source type">
    <button
      type="button"
      role="tab"
      class:active={kind === 'mnemonic'}
      aria-selected={kind === 'mnemonic'}
      onclick={() => (kind = 'mnemonic')}
      disabled={busy}
    >
      Mnemonic
    </button>
    <button
      type="button"
      role="tab"
      class:active={kind === 'private-key'}
      aria-selected={kind === 'private-key'}
      onclick={() => (kind = 'private-key')}
      disabled={busy}
    >
      Private Key
    </button>
  </div>

  {#if kind === 'mnemonic'}
    <div class="field">
      <label>Wallet type</label>
      <div class="kind-toggle wallet-toggle" role="tablist">
        {#each WALLET_TYPES as t}
          <button
            type="button"
            role="tab"
            class:active={walletType === t}
            aria-selected={walletType === t}
            onclick={() => (walletType = t)}
            disabled={busy}
          >
            {t}
          </button>
        {/each}
      </div>
      <p class="hint">
        Pick the source app that originally generated this mnemonic.
      </p>
    </div>

    <div class="field">
      <label for="phrase">Mnemonic phrase</label>
      <textarea
        id="phrase"
        rows="3"
        bind:value={phrase}
        placeholder="word1 word2 ... word12"
        disabled={busy}
      ></textarea>
      <p class="hint">12 or 24 words, separated by spaces.</p>
    </div>
  {:else}
    <div class="field">
      <label for="keys">WIF private keys</label>
      <textarea
        id="keys"
        rows="5"
        bind:value={keysText}
        placeholder={'L1...\n5K...'}
        disabled={busy}
      ></textarea>
      <p class="hint">One key per line. Imports together as a single source.</p>
    </div>
  {/if}
</section>

{#if error}
  <div class="callout error">
    <p>Import failed: {error}</p>
  </div>
{/if}

{#if result}
  <section class="card result">
    <h3>Imported</h3>
    <dl class="meta">
      <div>
        <dt>Source ID</dt>
        <dd class="mono">{result.id}</dd>
      </div>
      {#if result.walletType}
        <div>
          <dt>Wallet type</dt>
          <dd>{result.walletType}</dd>
        </div>
      {/if}
    </dl>
    <p class="muted">Syncing in the background — see Status for progress.</p>

    {#if warningLines.length > 0}
      <pre class="warning">{warningLines.join('\n')}</pre>
    {/if}
  </section>
{/if}

<style>
  .card {
    background: var(--panel);
    border-radius: 10px;
    padding: 18px 20px;
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .kind-toggle {
    display: inline-flex;
    background: var(--deep);
    border-radius: 8px;
    padding: 4px;
    align-self: flex-start;
    gap: 2px;
  }

  .kind-toggle button {
    background: transparent;
    color: var(--muted);
    padding: 6px 16px;
    border-radius: 6px;
    font-weight: 500;
    min-width: 120px;
  }

  .wallet-toggle {
    flex-wrap: wrap;
  }

  .wallet-toggle button {
    min-width: 0;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    font-size: 12px;
  }

  .kind-toggle button:hover {
    color: var(--text);
  }

  .kind-toggle button.active {
    background: linear-gradient(135deg, var(--indigo), var(--fuchsia));
    color: white;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field label {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .field textarea,
  .field select {
    width: 100%;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .field textarea {
    resize: vertical;
    min-height: 70px;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .result h3 {
    margin: 0;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--teal);
  }

  .meta {
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .meta > div {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: baseline;
    gap: 12px;
  }

  .meta dt {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .meta dd {
    margin: 0;
    color: var(--text);
  }

  .muted {
    color: var(--muted);
    margin: 0;
  }

  .mono {
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .warning {
    margin: 4px 0 0;
    padding: 12px 14px;
    background: var(--deep);
    border-left: 3px solid var(--warn);
    border-radius: 6px;
    color: var(--warn);
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
