<script>
  import { purgeDaemon } from '../lib/daemon.js';

  let confirmText = $state('');
  let busy = $state(false);
  let error = $state(null);
  let done = $state(false);

  const REQUIRED = 'DELETE EVERYTHING';

  async function submit() {
    if (confirmText.trim() !== REQUIRED) return;
    busy = true;
    error = null;
    done = false;
    try {
      await purgeDaemon();
      done = true;
      confirmText = '';
    } catch (err) {
      error = err.message ?? String(err);
    } finally {
      busy = false;
    }
  }
</script>

<header class="page-header">
  <h2>Purge</h2>
  <div class="actions">
    <button
      class="danger"
      onclick={submit}
      disabled={busy || confirmText.trim() !== REQUIRED}
    >
      {busy ? 'Purging…' : 'Purge all data'}
    </button>
  </div>
</header>

<div class="callout error">
  <p>
    This deletes <strong>every</strong> imported wallet from disk: keys,
    address history, balances. Use this after a successful sweep, or when
    starting fresh.
  </p>
  <p>
    This is irreversible. Recovery material (mnemonic / WIF) is your only
    fallback.
  </p>
</div>

<section class="card">
  <div class="field">
    <label for="confirm">
      Type <code>{REQUIRED}</code> to confirm
    </label>
    <input
      id="confirm"
      type="text"
      bind:value={confirmText}
      placeholder={REQUIRED}
      disabled={busy}
    />
    <p class="hint">
      Match the phrase exactly to enable the purge button.
    </p>
  </div>
</section>

{#if error}
  <p class="error">Purge failed: {error}</p>
{/if}

{#if done}
  <p class="ok">All wallet data deleted. Daemon restarting in the background.</p>
{/if}

<style>
  .card {
    background: var(--panel);
    border-radius: 10px;
    padding: 18px 20px;
    margin-top: 14px;
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

  .field input {
    width: 100%;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
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
    color: var(--pink);
  }

  button.danger {
    background: var(--pink);
  }

  .error {
    color: var(--pink);
  }

  .ok {
    color: var(--teal);
  }
</style>
