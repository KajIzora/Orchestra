const ACTIVE_GENERATION_STALE_MS = 15 * 60 * 1000;

function parseTimeMs(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  return Date.parse(value) || 0;
}

function toIso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function activeGenerationStaleMs(options = {}) {
  return Number.isFinite(options.activeStaleMs) && options.activeStaleMs >= 0
    ? options.activeStaleMs
    : ACTIVE_GENERATION_STALE_MS;
}

function applyActiveGenerationStaleCutoff(result, options = {}) {
  const out = {
    generating: !!result?.generating,
    start_signal_at: result?.start_signal_at || '',
    last_activity_at: result?.last_activity_at || '',
    inactive_reason: result?.inactive_reason || '',
  };
  if (!out.generating) {
    if (!out.inactive_reason) out.inactive_reason = 'no_start_signal';
    return out;
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const lastMs =
    parseTimeMs(out.last_activity_at) ||
    parseTimeMs(out.start_signal_at) ||
    (Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0);
  if (!out.last_activity_at && lastMs) out.last_activity_at = toIso(lastMs);
  if (!out.start_signal_at && parseTimeMs(out.last_activity_at)) {
    out.start_signal_at = out.last_activity_at;
  }
  const staleMs = activeGenerationStaleMs(options);
  if (lastMs && nowMs - lastMs > staleMs) {
    return {
      ...out,
      generating: false,
      inactive_reason: 'stale',
    };
  }
  out.inactive_reason = '';
  return out;
}

module.exports = {
  ACTIVE_GENERATION_STALE_MS,
  activeGenerationStaleMs,
  applyActiveGenerationStaleCutoff,
  parseTimeMs,
  toIso,
};
