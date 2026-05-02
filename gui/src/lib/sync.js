// Mirrors src/constants.js SYNC_PHASES + formatSyncPhase. Keep wording
// in sync with the node-side helper used by CLI/TUI.
export const SYNC_PHASES = {
  receive: { label: 'scanning receive', unit: 'addr' },
  change: { label: 'scanning change', unit: 'addr' },
  'stake-discover': { label: 'discovering stake partners', unit: 'addr' },
  stake: { label: 'scanning stake', unit: 'script' },
  'xnav-history': { label: 'fetching xNAV history', unit: '' },
  xnav: { label: 'scanning xNAV', unit: 'tx' },
  'xnav-claim': { label: 'claiming xNAV', unit: 'tx' },
};

export function formatSyncPhase(phase, current, total) {
  const meta = SYNC_PHASES[phase];
  if (!meta) return phase ?? 'syncing';
  if (total > 0) {
    const unit = meta.unit ? ` ${meta.unit}` : '';
    return `${meta.label} (${current ?? 0}/${total}${unit})`;
  }
  return meta.label;
}

export function syncLabel(source) {
  if (source.syncStatus === 'syncing') {
    return formatSyncPhase(
      source.syncPhase,
      source.syncCurrent,
      source.syncTotal,
    );
  }
  return source.syncStatus;
}
