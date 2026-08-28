<script>
  import { tick } from 'svelte';
  import { sweepPrepare, sweepConfirm } from '../lib/daemon.js';

  const REQUIRED_PHRASE = 'SEND MY COINS';

  // Multi-step state machine for the sweep flow.
  //   entry   user types destination
  //   verify  user retypes destination; on match call prepare → preview
  //   review  preview rendered, user types confirmation phrase
  //   broadcasting + result
  let step = $state('entry');

  let destination = $state('');
  let destinationVerify = $state('');
  let phrase = $state('');

  let preview = $state(null);
  // Set when prepare refused because sources are not synced. The retry is
  // a deliberate second action: skipping a source means sweeping without
  // knowing what it holds.
  let blockedMessage = $state(null);
  let force = $state(false);
  let result = $state(null);
  let busy = $state(false);
  let error = $state(null);

  let verifyInput;
  let phraseInput;

  function fmt(sat) {
    return (Number(sat ?? 0) / 1e8).toFixed(8);
  }

  async function goToVerify() {
    if (!destination.trim()) {
      error = 'Enter a destination address.';
      return;
    }
    error = null;
    destinationVerify = '';
    step = 'verify';
    await tick();
    verifyInput?.focus();
  }

  async function goToReview() {
    if (destinationVerify.trim() !== destination.trim()) {
      error = 'Destination addresses do not match.';
      return;
    }
    await prepare(false);
  }

  async function prepare(forced) {
    busy = true;
    error = null;
    blockedMessage = null;
    try {
      const res = await sweepPrepare({ force: forced });
      preview = res?.preview ?? null;
      force = forced;
      step = 'review';
      phrase = '';
    } catch (err) {
      const message = err.message ?? String(err);
      error = message;
      // Only a sync block can be forced past. Anything else — no sources,
      // an unreachable daemon — must not offer a button that cannot help.
      if (!forced && /not ready to sweep/.test(message)) {
        blockedMessage = message;
      }
    } finally {
      busy = false;
      await tick();
      // Focus the input that's now live: phrase on review (success),
      // verify on the verify step (error path).
      if (step === 'review') phraseInput?.focus();
      else if (step === 'verify') verifyInput?.focus();
    }
  }

  async function broadcast() {
    if (phrase !== REQUIRED_PHRASE) return;
    busy = true;
    error = null;
    try {
      const res = await sweepConfirm({
        destination: destination.trim(),
        confirmPhrase: phrase,
        force,
      });
      result = res?.result ?? null;
      step = 'done';
    } catch (err) {
      error = err.message ?? String(err);
    } finally {
      busy = false;
      if (step === 'review') {
        await tick();
        phraseInput?.focus();
      }
    }
  }

  function back() {
    error = null;
    if (step === 'verify') step = 'entry';
    else if (step === 'review') step = 'verify';
  }
</script>

<header class="page-header">
  <h2>Sweep</h2>
</header>

<div class="callout error">
  <p>
    Sweep moves <strong>every</strong> spendable NAV and xNAV output from
    every imported source to the destination. Broadcast is non-atomic — a
    later leg failing leaves earlier legs already on chain.
  </p>
</div>

{#if error}
  <div class="callout error">
    <p class="pre">{error}</p>
    {#if blockedMessage}
      <div class="actions">
        <button class="danger" onclick={() => prepare(true)} disabled={busy}>
          {busy ? 'Preparing…' : 'Sweep anyway, skipping those sources'}
        </button>
      </div>
    {/if}
  </div>
{/if}

{#if step === 'entry'}
  <section class="card">
    <div class="field">
      <label for="dest">Destination address</label>
      <input
        id="dest"
        type="text"
        bind:value={destination}
        placeholder="N..."
        disabled={busy}
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Enter' && destination.trim()) goToVerify();
        }}
      />
      <p class="hint">A new wallet address you control. Verify carefully.</p>
    </div>
    <div class="actions">
      <button onclick={goToVerify} disabled={busy || !destination.trim()}>
        Continue
      </button>
    </div>
  </section>
{:else if step === 'verify'}
  <section class="card">
    <p class="muted small">Confirm the destination by typing it again.</p>
    <div class="field">
      <label class="muted small" for="dest-shown">Destination</label>
      <code class="dest-shown" id="dest-shown">{destination}</code>
    </div>
    <div class="field">
      <label for="dest-verify">Re-enter destination</label>
      <input
        id="dest-verify"
        type="text"
        bind:value={destinationVerify}
        bind:this={verifyInput}
        placeholder="paste again"
        readonly={busy}
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Enter' && !busy && destinationVerify.trim())
            goToReview();
        }}
      />
    </div>
    <div class="actions">
      <button class="ghost" onclick={back} disabled={busy}>Back</button>
      <button
        onclick={goToReview}
        disabled={busy || !destinationVerify.trim()}
      >
        {busy ? 'Preparing…' : 'Continue'}
      </button>
    </div>
  </section>
{:else if step === 'review' && preview}
  <section class="card">
    <h3>Preview</h3>
    <dl class="rows">
      <div class="row">
        <dt>Destination</dt>
        <dd class="mono break">{destination}</dd>
      </div>
      <div class="row">
        <dt>NAV</dt>
        <dd><span class="num cyan mono">{fmt(preview.totalNav)}</span></dd>
      </div>
      <div class="row">
        <dt>xNAV</dt>
        <dd><span class="num indigo mono">{fmt(preview.totalXNav)}</span></dd>
      </div>
      <div class="row">
        <dt>Combined</dt>
        <dd>
          <span class="num strong mono">{fmt(preview.totalCombined)}</span>
        </dd>
      </div>
      <div class="row">
        <dt>Sources</dt>
        <dd>{preview.sources?.length ?? 0}</dd>
      </div>
    </dl>

    {#if preview.skipped?.length}
      <div class="callout error">
        <p class="small">
          <strong>Skipped — balance unknown, NOT included:</strong>
        </p>
        <ul class="skipped">
          {#each preview.skipped as skip}
            <li>
              <span class="mono">{skip.sourceId}</span>{#if skip.walletType}
                ({skip.walletType}){/if} — {skip.reason}
            </li>
          {/each}
        </ul>
        <p class="small">
          Coins these sources hold stay where they are. Go back and wait for
          them to sync to sweep everything.
        </p>
      </div>
    {/if}

    <p class="muted small">
      Fees are subtracted from each leg's amount. Final on-chain amount may
      be slightly less than the totals shown.
    </p>

    <div class="field">
      <label for="phrase">
        Type <code>{REQUIRED_PHRASE}</code> to broadcast
      </label>
      <input
        id="phrase"
        type="text"
        bind:value={phrase}
        bind:this={phraseInput}
        placeholder={REQUIRED_PHRASE}
        readonly={busy}
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Enter' && !busy && phrase === REQUIRED_PHRASE)
            broadcast();
        }}
      />
    </div>

    <div class="actions">
      <button class="ghost" onclick={back} disabled={busy}>Back</button>
      <button
        class="danger"
        onclick={broadcast}
        disabled={busy || phrase !== REQUIRED_PHRASE}
      >
        {busy ? 'Broadcasting…' : 'Broadcast sweep'}
      </button>
    </div>
  </section>
{:else if step === 'done' && result}
  <div class="callout success">
    <p>
      Sweep broadcast. Sent
      <span class="num strong mono">{fmt(result.totalSent)}</span>
      across {result.hashes?.length ?? 0} transaction(s); fees
      <span class="mono">{fmt(result.totalFee)}</span>.
    </p>
  </div>

  {#if result.hashes?.length}
    <section class="card">
      <h3>Transaction IDs</h3>
      <ul class="hashes">
        {#each result.hashes as h}
          <li class="mono">{h}</li>
        {/each}
      </ul>
    </section>
  {/if}
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

  .card h3 {
    margin: 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--magenta);
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
    font-family:
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .small {
    font-size: 12px;
    margin: 0;
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

  .strong {
    font-weight: 600;
  }

  .break {
    word-break: break-all;
  }

  .dest-shown {
    background: var(--deep);
    padding: 8px 12px;
    border-radius: 6px;
    color: var(--text);
    word-break: break-all;
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
    color: var(--magenta);
  }

  .rows {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .row {
    display: grid;
    grid-template-columns: 130px 1fr;
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

  .cyan {
    color: var(--cyan);
  }

  .indigo {
    color: var(--indigo);
  }

  button.danger {
    background: var(--pink);
    color: white;
  }

  button.danger:hover:not(:disabled) {
    background: #9d164d;
  }

  button.ghost {
    background: transparent;
    color: var(--muted);
    border: 1px solid #374151;
  }

  button.ghost:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--muted);
  }

  .pre {
    white-space: pre-wrap;
  }

  .skipped {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  .skipped li {
    word-break: break-all;
  }

  .hashes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  .hashes li {
    color: var(--text);
    word-break: break-all;
  }
</style>
