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
  let walletType = $state('navcoin-js-v1');
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

      // Pull walletsDir from /status — it returns appData root.
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

<h2>Import</h2>

<div class="form">
  <label class="row">
    <span>Type</span>
    <select bind:value={kind} disabled={busy}>
      <option value="mnemonic">mnemonic</option>
      <option value="private-key">private-key</option>
    </select>
  </label>

  {#if kind === 'mnemonic'}
    <label class="row">
      <span>Wallet type</span>
      <select bind:value={walletType} disabled={busy}>
        {#each WALLET_TYPES as t}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>
    <label class="row col">
      <span>Mnemonic phrase</span>
      <textarea
        rows="3"
        bind:value={phrase}
        placeholder="word1 word2 ... word12"
        disabled={busy}
      ></textarea>
    </label>
  {:else}
    <label class="row col">
      <span>WIF private keys (one per line)</span>
      <textarea
        rows="4"
        bind:value={keysText}
        placeholder="L1...&#10;5K..."
        disabled={busy}
      ></textarea>
    </label>
  {/if}

  <div class="actions">
    <button onclick={submit} disabled={busy}>
      {busy ? 'Importing…' : 'Import'}
    </button>
  </div>
</div>

{#if error}
  <p class="error">Import failed: {error}</p>
{/if}

{#if result}
  <div class="result">
    <p class="ok">Imported source: <span class="mono">{result.id}</span></p>
    {#if result.walletType}
      <p class="muted">Wallet type: {result.walletType}</p>
    {/if}
    <p class="muted">Syncing in the background — see Status for progress.</p>

    {#if warningLines.length > 0}
      <pre class="warning">{warningLines.join('\n')}</pre>
    {/if}
  </div>
{/if}

<style>
  h2 {
    margin: 0 0 16px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 560px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .row.col {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }

  .row > span {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    width: 110px;
    flex-shrink: 0;
  }

  .row.col > span {
    width: auto;
  }

  textarea,
  select {
    flex: 1;
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  .error {
    color: var(--pink);
  }

  .ok {
    color: var(--teal);
  }

  .muted {
    color: var(--muted);
  }

  .mono {
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .result {
    margin-top: 20px;
    padding: 16px;
    background: var(--panel);
    border-radius: 8px;
    max-width: 560px;
  }

  .warning {
    margin: 12px 0 0;
    padding: 12px;
    background: var(--deep);
    border-left: 3px solid var(--pink);
    color: var(--pink);
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
