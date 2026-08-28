<script>
  import { importSource, fetchDaemonStatus } from '../lib/daemon.js';
  import { getStorageWarningLines } from '../lib/storage-warning.js';
  import { isWaivableMnemonicError } from '../lib/mnemonic-error.js';

  const WALLET_TYPES = [
    'navcoin-core',
    'navcash',
    'next',
    'navpay',
    'navcoin-js-v1',
    'coinomi',
  ];

  let kind = $state('mnemonic');
  let phrase = $state('');
  let keysText = $state('');
  let busy = $state(false);
  let error = $state(null);
  // Set when the daemon rejected the phrase for a checksum the user is
  // allowed to waive. Offering the checkbox only then keeps it out of the
  // way of everyone whose phrase is fine.
  let checksumWaivable = $state(false);
  let allowUncheckedMnemonic = $state(false);
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
        payload = {
          type: 'mnemonic',
          phrase: phrase.trim(),
          allowUncheckedMnemonic,
        };
      } else {
        const keys = keysText
          .split(/\s+/)
          .map((k) => k.trim())
          .filter(Boolean);
        if (keys.length === 0) throw new Error('Enter at least one WIF key.');
        payload = { type: 'private-key', keys };
      }

      const res = await importSource(payload);
      result = res;

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
      allowUncheckedMnemonic = false;
      checksumWaivable = false;
    } catch (err) {
      error = err.message ?? String(err);
      checksumWaivable = isWaivableMnemonicError(err);
      if (!checksumWaivable) allowUncheckedMnemonic = false;
    } finally {
      busy = false;
    }
  }
</script>

<header class="page-header">
  <h2>Import</h2>
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
      <span class="field-label">Wallet types</span>
      <div class="type-list">
        {#each WALLET_TYPES as t}
          <span class="type">{t}</span>
        {/each}
      </div>
      <p class="hint">
        No need to know which app produced the phrase — it is imported for
        every one of these it can belong to, and Status reports which
        actually holds funds. Coinomi derives exactly as navcoin-js-v1
        does, so it is covered by that source rather than one of its own.
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

    {#if checksumWaivable}
      <div class="field">
        <label class="checkbox">
          <input
            type="checkbox"
            bind:checked={allowUncheckedMnemonic}
            disabled={busy}
          />
          Import without the checksum check
        </label>
        <p class="hint">
          Only for a wallet that really was created from a phrase failing
          BIP39. A mistyped word derives a different wallet, which will
          look empty.
        </p>
      </div>
    {/if}
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

  <div class="actions">
    <button onclick={submit} disabled={busy}>
      {busy ? 'Importing…' : 'Import'}
    </button>
  </div>
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
        <dt>Import ID</dt>
        <dd class="mono">{result.importId}</dd>
      </div>
      {#each result.sources as source}
        <div>
          <dt>{source.walletType ?? source.type}</dt>
          <dd class="mono">{source.id}</dd>
        </div>
      {/each}
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

  /* The types are a statement of what gets imported, not a choice, so
     they are labels rather than buttons. */
  .type-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .type {
    background: var(--deep);
    border-radius: 6px;
    padding: 4px 10px;
    color: var(--muted);
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

  .field label,
  .field .field-label {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  /* The waiver opt-in reads as a sentence, not as a field label. */
  .field label.checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: none;
    letter-spacing: normal;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
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
    grid-template-columns: 130px 1fr;
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
