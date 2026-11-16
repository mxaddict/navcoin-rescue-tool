// Following a sweep whose reply was lost. A sweep can outlast the request
// that started it: building and broadcasting every batch can take longer
// than a client waits for a reply, and the daemon carries on regardless.
// The sweep is found again on /status by the id the client gave it.
//
// No imports: the CLI and TUI use this through daemon-client.js, and the
// GUI bundles it for the webview.

// How often the sweep is looked up again.
export const SWEEP_FOLLOW_INTERVAL_MS = 2_000;

const CHECK_BEFORE_SWEEPING_AGAIN =
  'Transactions may have gone out: check the [sweep] lines in the daemon ' +
  'log and the destination address on a block explorer before sweeping again.';

// Resolves with the result of sweep `sweepId` once the daemon reports it
// finished, and rejects with its error if it failed, if the daemon cannot
// be reached, or if the daemon has no record of that sweep. `getStatus`
// fetches the daemon's /status; `lost` is the error the reply was lost to.
export async function followSweep(sweepId, getStatus, lost) {
  for (;;) {
    let status;
    try {
      status = await getStatus();
    } catch (error) {
      throw new Error(
        `Lost the daemon's reply to the sweep (${lost.message}) and it ` +
          `cannot be reached now (${error.message}). ` +
          CHECK_BEFORE_SWEEPING_AGAIN,
      );
    }

    const sweep = status.sweep;
    if (sweep?.id !== sweepId) {
      throw new Error(
        `Lost the daemon's reply to the sweep (${lost.message}) and the ` +
          `daemon has no record of it, as after a restart. ` +
          CHECK_BEFORE_SWEEPING_AGAIN,
      );
    }
    if (sweep.state === 'finished') return sweep.result;
    if (sweep.state === 'failed') throw new Error(sweep.error);

    await new Promise((resolve) =>
      setTimeout(resolve, SWEEP_FOLLOW_INTERVAL_MS),
    );
  }
}
