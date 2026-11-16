// A source's registry record holds, in `normalizedDetails`, the phrase or
// private keys it was imported from, one word or key to a line. These keep
// that out of what leaves the daemon.

// A source as a reply may carry it: the record without the secret. Only
// the wallet worker needs it, and it is handed the record directly.
export function publicSource(source) {
  const { normalizedDetails: _secret, ...shown } = source;
  return shown;
}

const REDACTED = '[redacted]';

// `text` with the source's secret taken out, for a message on its way to
// the log or a client. Libraries quote what they were given when they
// reject it: bitcore-mnemonic's InvalidMnemonic carries the whole phrase.
// Removes the phrase as stored and as navcoin-js is given it, on one line,
// and every key by itself.
export function redactSourceSecret(text, source) {
  const secret = source?.normalizedDetails;
  if (typeof secret !== 'string' || secret === '') return text;

  const lines = secret.split('\n');
  const parts =
    source.type === 'mnemonic' ? [secret, lines.join(' ')] : [secret, ...lines];

  return parts.reduce(
    (redacted, part) => redacted.replaceAll(part, REDACTED),
    String(text),
  );
}
