'use strict';

/*
 * cowork_live_adapter.js — Phase-2b Seam B pull adapter for claude-cowork.
 *
 * The Cowork audit.jsonl is T3-capable at the SOURCE (Lane D / cowork-browser-writeup.md §2) but
 * carries NO raw hook flow, so live_turn_normalizer.providerLogKey() returns '' and the base live
 * feed serves cowork lifecycle-only. This adapter closes that gap the sanctioned way (core-
 * implementation-notes.md §5 Seam B): read the audit off disk OUTSIDE the synchronous response
 * path, normalize it (claude_cowork_tracker.parseCoworkAuditRecords), and append LiveTurnEvents to
 * the task's ring — the ring assigns seq/t and owns turn/FIFO. The GET handler never blocks.
 *
 * RULES honored (§5):
 *   - poll_guard: each task's read is wrapped in wrapShortTtlMemo so the ~1–2s live-feed polls
 *     share one disk read (and concurrent polls share the in-flight promise, i.e. non-overlapping).
 *   - try/catch everywhere → FAIL SAFE: a missing / unlinked / unreadable audit appends NOTHING
 *     (the cell renders at its lower tier — the pre-campaign lifecycle-only behavior). Never throws
 *     into the endpoint, never blocks, never invents an event.
 *   - bounded incremental reads: the first read is TAIL-bounded (audit files grow during a
 *     session); subsequent reads resume from a byte offset and consume only complete lines.
 *   - CAPS clamping is applied by the parser (via live_turn_normalizer).
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { wrapShortTtlMemo } = require('./poll_guard');
const {
  DEFAULT_TAIL_BYTES,
  assertAllowedCoworkAuditPath,
  parseJsonlLines,
  parseCoworkAuditRecords,
} = require('./claude_cowork_tracker');

const DEFAULT_POLL_DEBOUNCE_MS = 750; // ≈ one live-feed poll: reads within the window are shared

function isCoworkAuditWatch(wt) {
  return !!(
    wt &&
    typeof wt === 'object' &&
    wt.kind === 'ide_agent' &&
    wt.provider === 'claude_cowork' &&
    typeof wt.audit_path === 'string' &&
    wt.audit_path.trim()
  );
}

/**
 * Read the audit forward from `offset` (or a tail-bounded start when `offset == null`), returning
 * the complete records read and the new byte offset (a clean line boundary). Leaves a trailing
 * partial line unconsumed for the next read. Throws only on genuine fs errors (caller catches).
 */
async function readAuditForward(auditPath, offset, maxBytes) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_TAIL_BYTES;
  const stat = await fsp.stat(auditPath);
  const size = stat.size;
  let start;
  let dropLeadingPartial = false;
  if (!Number.isFinite(offset) || offset == null) {
    start = Math.max(0, size - cap); // cold: bounded tail (reconstructs the current turn)
    dropLeadingPartial = start > 0;
  } else if (size < offset) {
    start = 0; // truncated / rotated: re-read from the top
  } else {
    start = offset;
  }
  if (size <= start) return { records: [], offset: size };

  const fh = await fsp.open(auditPath, 'r');
  let text;
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }

  if (dropLeadingPartial) {
    const nl = text.indexOf('\n');
    if (nl === -1) return { records: [], offset: size }; // one giant partial line — skip it
    start += Buffer.byteLength(text.slice(0, nl + 1), 'utf8');
    text = text.slice(nl + 1);
  }
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { records: [], offset: start }; // no complete line yet — wait
  const complete = text.slice(0, lastNl + 1);
  const newOffset = start + Buffer.byteLength(complete, 'utf8');
  return { records: parseJsonlLines(complete), offset: newOffset };
}

/**
 * Build the cowork audit-tail adapter. `ring` is the shared live_turn_ring (append target).
 *
 * @param {object} opts
 * @param {object} opts.ring         live_turn_ring instance (required to append)
 * @param {string} [opts.homeDir]    home dir for the cowork-root path guard (default os.homedir())
 * @param {number} [opts.maxBytes]   tail-read cap for the first fill (default 1 MiB)
 * @param {number} [opts.debounceMs] poll_guard TTL; 0 disables sharing (tests) (default 750ms)
 * @param {Function} [opts.readForward] injectable reader (tests) — (auditPath, offset, maxBytes)
 * @returns {{ prime(taskId, wt): Promise<{appended:number}|null>, drop(taskId): void, size(): number }}
 */
function createCoworkAuditTailAdapter(opts = {}) {
  const ring = opts.ring;
  const homeDir = typeof opts.homeDir === 'string' && opts.homeDir ? opts.homeDir : os.homedir();
  const maxBytes = opts.maxBytes;
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEFAULT_POLL_DEBOUNCE_MS;
  const readForward = typeof opts.readForward === 'function' ? opts.readForward : readAuditForward;
  if (!ring || typeof ring.append !== 'function') {
    throw new Error('createCoworkAuditTailAdapter requires a ring with append()');
  }

  /** @type {Map<string, {auditPath:string, offset:?number, parser:object, wt:object, read:Function}>} */
  const byTask = new Map();

  async function readAndAppend(taskId) {
    const st = byTask.get(taskId);
    if (!st || !st.wt) return null;
    let auditPath;
    try {
      // Path guard: only ever read under the Claude local-agent-mode-sessions root.
      auditPath = assertAllowedCoworkAuditPath(st.wt.audit_path, homeDir);
    } catch {
      return { appended: 0 }; // unlinked / foreign path → lifecycle-only, never throw
    }
    if (st.auditPath !== auditPath) {
      // A relinked session (new audit) resets the incremental cursor + parser carry.
      st.auditPath = auditPath;
      st.offset = null;
      st.parser = {};
    }
    let result;
    try {
      result = await readForward(auditPath, st.offset, maxBytes);
    } catch {
      return { appended: 0 }; // ENOENT / read error → serve the retained ring, never throw
    }
    st.offset = result.offset;
    if (!result.records || !result.records.length) return { appended: 0 };
    let events;
    try {
      ({ events } = parseCoworkAuditRecords(result.records, st.parser));
    } catch {
      return { appended: 0 }; // a malformed record must never break the feed
    }
    if (!events || !events.length) return { appended: 0 };
    let appended = 0;
    try {
      appended = ring.append(taskId, events);
    } catch {
      return { appended: 0 };
    }
    return { appended };
  }

  /**
   * Kick a (poll-guarded) audit read for one cowork task and append new LiveTurnEvents to the ring.
   * Returns a promise the CALLER MAY IGNORE (fire-and-forget from the sync endpoint) or AWAIT
   * (harness / tests) — never rejects. A non-cowork / unlinked watch resolves to null (no-op).
   */
  function prime(taskId, wt) {
    if (!isCoworkAuditWatch(wt)) return Promise.resolve(null);
    const id = String(taskId || '');
    let st = byTask.get(id);
    if (!st) {
      st = { auditPath: '', offset: null, parser: {}, wt, read: null };
      st.read = wrapShortTtlMemo(() => readAndAppend(id), debounceMs);
      byTask.set(id, st);
    }
    st.wt = wt;
    return st.read().catch(() => null);
  }

  /**
   * Generic tailAdapters seam entry (live_feed_service iterates `{ pump(taskId, wt, nowMs) }` each
   * poll). SYNC + fire-and-forget: kicks the poll-guarded read and returns immediately; the events
   * append in the background for the next poll. Never throws (the service also try/catches per
   * adapter). `nowMs` is unused — poll_guard debounces on its own clock.
   */
  function pump(taskId, wt) {
    try {
      prime(taskId, wt);
    } catch {
      /* fail safe: an adapter can never break a task's feed */
    }
  }

  function drop(taskId) {
    byTask.delete(String(taskId || ''));
  }

  return { prime, pump, drop, size: () => byTask.size, _byTask: byTask };
}

module.exports = {
  createCoworkAuditTailAdapter,
  readAuditForward,
  isCoworkAuditWatch,
  DEFAULT_POLL_DEBOUNCE_MS,
};
