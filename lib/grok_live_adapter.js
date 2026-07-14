'use strict';

/*
 * grok_live_adapter.js — Seam B pull adapter for grok CLI sessions (live-feed campaign R2c).
 *
 * grok has NO raw hook flow in production (the fake-HOME shim keeps the vendor-bug claude/cursor
 * taps quiet, and no grok-native tap is installed this wave), so live_turn_normalizer.
 * providerLogKey() returns '' for grok watches and the base live feed would serve lifecycle-only.
 * This adapter closes the gap the sanctioned way (the cowork audit-tail precedent,
 * lib/cowork_live_adapter.js): read the session's LIVE events.jsonl off disk OUTSIDE the
 * synchronous response path, map it (lib/grok_session_tracker.parseGrokSessionEvents), and append
 * LiveTurnEvents to the task's ring — the ring assigns seq/t and owns turn/FIFO.
 *
 * What the ring receives (tier 2 + gate kinds — the R2b-reviewed mapping, T2-upgraded by the L5
 * closure wave after the updates.jsonl liveness re-verification):
 *   meta          — model from events.jsonl turn_started.model_id, model+cwd from summary.json
 *   tool_start /  — events.jsonl tool_started/tool_completed (names + outcome only: the file
 *   tool_end        carries no args — detail stays '' by DATA HONESTY)
 *   gate_open     — {gate_kind} WITHOUT payloads (question payloads ride the agent→client RPCs
 *                   only; the disk carries kind-level markers). Instant always-approve permission
 *                   pairs (wait_ms < GROK_INSTANT_GATE_MS) are folded away, never rendered.
 *   gate_answered — {waited_ms} (grok's own permission_resolved.wait_ms / question span)
 *   prompt / note — a SECOND live tail on updates.jsonl (parseGrokUpdatesRecords):
 *                   user_message_chunk → prompt, agent_thought_chunk / agent_message_chunk → note.
 *                   updates.jsonl is flushed INCREMENTALLY at message/tool boundaries — LIVE
 *                   mid-turn, re-verified 2026-07-12 (L5) in headless, ACP and TUI modes on
 *                   0.2.93 with a 100ms sampler; this supersedes the R2a "turn-end flush" claim.
 *                   NB grok's NATIVE hooks were probed the same day and carry NO assistant text
 *                   in 0.2.93 (evidence/l5/t2-liveness/) — the hook-tap route to T2 is dead; the
 *                   live updates tail is the real note channel.
 *   stop          — on turn_ended {outcome:'completed'}; text = the updates tail's last
 *                   agent_message_chunk (already read by the note channel). If the final message
 *                   has not landed yet the stop is HELD for a few polls (then emitted with its
 *                   text; after the retry budget it emits with '' rather than never). Cancelled
 *                   turns emit no stop row (cancel clears via task state — the cowork precedent).
 *   (no todo rows: grok's plan.json / ACP plan updates stay unexercised — revisit with evidence.)
 *
 * RULES honored (core-implementation-notes §5, same as cowork):
 *   - poll_guard: wrapShortTtlMemo shares one disk read across the ~1s live-feed polls.
 *   - FAIL SAFE everywhere: missing/unlinked/unreadable session ⇒ append NOTHING (lifecycle-only).
 *   - bounded incremental reads: cold read is TAIL-bounded, then byte-offset resume on complete
 *     lines only (readAuditForward — the shared forward reader).
 */

const os = require('os');
const { wrapShortTtlMemo } = require('./poll_guard');
const { readAuditForward } = require('./cowork_live_adapter');
const {
  DEFAULT_TAIL_BYTES,
  assertAllowedGrokSessionDir,
  grokEventsPath,
  grokUpdatesPath,
  parseGrokSessionEvents,
  parseGrokUpdatesRecords,
  readGrokSummary,
  grokStopTextFromUpdates,
} = require('./grok_session_tracker');
const { clamp, clampBlock, CAPS } = require('./live_turn_normalizer');

const DEFAULT_POLL_DEBOUNCE_MS = 750; // ≈ one live-feed poll (mirrors the cowork adapter)
const STOP_TEXT_MAX_RETRIES = 4; // polls to wait for the updates.jsonl turn-end flush

function isGrokSessionWatch(wt) {
  return !!(
    wt &&
    typeof wt === 'object' &&
    wt.kind === 'ide_agent' &&
    wt.provider === 'grok' &&
    typeof wt.session_dir === 'string' &&
    wt.session_dir.trim()
  );
}

/**
 * Build the grok session-tail adapter. `ring` is the shared live_turn_ring (append target).
 * Same seam contract as createCoworkAuditTailAdapter: { prime, pump, drop, size }.
 */
function createGrokSessionTailAdapter(opts = {}) {
  const ring = opts.ring;
  const homeDir = typeof opts.homeDir === 'string' && opts.homeDir ? opts.homeDir : os.homedir();
  const maxBytes = opts.maxBytes;
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEFAULT_POLL_DEBOUNCE_MS;
  const readForward = typeof opts.readForward === 'function' ? opts.readForward : readAuditForward;
  const readSummary = typeof opts.readSummary === 'function' ? opts.readSummary : readGrokSummary;
  const readStopText = typeof opts.readStopText === 'function' ? opts.readStopText : grokStopTextFromUpdates;
  if (!ring || typeof ring.append !== 'function') {
    throw new Error('createGrokSessionTailAdapter requires a ring with append()');
  }

  /** @type {Map<string, {sessionDir:string, offset:?number, parser:object, updOffset:?number, updParser:object, wt:object, read:Function}>} */
  const byTask = new Map();

  async function readAndAppend(taskId) {
    const st = byTask.get(taskId);
    if (!st || !st.wt) return null;
    let sessionDir;
    try {
      // Path guard: only ever read under <grok home>/sessions (auth.json lives outside it).
      sessionDir = assertAllowedGrokSessionDir(st.wt.session_dir, homeDir);
    } catch {
      return { appended: 0 }; // unlinked / foreign path → lifecycle-only, never throw
    }
    if (st.sessionDir !== sessionDir) {
      // A relinked session resets the incremental cursors + parser carries (both channels).
      st.sessionDir = sessionDir;
      st.offset = null;
      st.parser = {};
      st.updOffset = null;
      st.updParser = {};
    }
    let result;
    try {
      result = await readForward(grokEventsPath(sessionDir), st.offset, maxBytes || DEFAULT_TAIL_BYTES);
    } catch {
      return { appended: 0 }; // ENOENT (pre-first-turn) / read error → serve the retained ring
    }
    st.offset = result.offset;
    let events = [];
    if (result.records && result.records.length) {
      // summary.json is the meta side-channel (model + cwd); small and read only when the batch
      // carries records. A failed read degrades meta, never the batch.
      let summary = null;
      try {
        summary = await readSummary(sessionDir);
      } catch {
        summary = null;
      }
      try {
        ({ events } = parseGrokSessionEvents(result.records, st.parser, { summary }));
      } catch {
        return { appended: 0 }; // a malformed record must never break the feed
      }
    }
    // T2 narrative channel: the SECOND live tail, on updates.jsonl (prompt + note rows). Flushed
    // incrementally at message/tool boundaries (liveness re-verified 2026-07-12 — see the module
    // header). Fail-safe: a missing/unreadable updates.jsonl degrades narration, never the batch.
    try {
      const upd = await readForward(grokUpdatesPath(sessionDir), st.updOffset, maxBytes || DEFAULT_TAIL_BYTES);
      st.updOffset = upd.offset;
      if (upd.records && upd.records.length) {
        const { events: narrative } = parseGrokUpdatesRecords(upd.records, st.updParser);
        if (narrative.length) events = events.concat(narrative);
      }
    } catch {
      /* pre-first-flush ENOENT / read error — narration absent this poll */
    }
    // Held completed stop: text = the updates tail's last agent_message_chunk (already read
    // above); fall back to the whole-file pull for a relink/rotation edge. Empty ⇒ retry next
    // poll up to the budget, then emit with '' (never never).
    const pending = st.parser && st.parser.pendingStop;
    if (pending) {
      let text = (st.updParser && typeof st.updParser.lastAgentText === 'string') ? st.updParser.lastAgentText : '';
      if (!text) {
        try {
          text = await readStopText(sessionDir);
        } catch {
          text = '';
        }
      }
      if (text || pending.retries >= STOP_TEXT_MAX_RETRIES) {
        events.push({ abs_ms: pending.abs_ms, kind: 'stop', text: clampBlock(text || '', CAPS.stopText) });
        st.parser.pendingStop = null;
      } else {
        pending.retries += 1;
      }
    }
    if (!events.length) return { appended: 0 };
    // Two channels, one batch: order by the records' own timestamps so narration interleaves
    // with the register/gate rows the way it happened (stable for equal stamps).
    events.sort((a, b) => (a.abs_ms || 0) - (b.abs_ms || 0));
    let appended = 0;
    try {
      appended = ring.append(taskId, events);
    } catch {
      return { appended: 0 };
    }
    return { appended };
  }

  /** Poll-guarded read for one grok task; non-grok/unlinked watches resolve null (no-op). */
  function prime(taskId, wt) {
    if (!isGrokSessionWatch(wt)) return Promise.resolve(null);
    const id = String(taskId || '');
    let st = byTask.get(id);
    if (!st) {
      st = { sessionDir: '', offset: null, parser: {}, updOffset: null, updParser: {}, wt, read: null };
      st.read = wrapShortTtlMemo(() => readAndAppend(id), debounceMs);
      byTask.set(id, st);
    }
    st.wt = wt;
    return st.read().catch(() => null);
  }

  /** Generic tailAdapters seam entry — SYNC fire-and-forget, never throws. */
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
  createGrokSessionTailAdapter,
  isGrokSessionWatch,
  DEFAULT_POLL_DEBOUNCE_MS,
  STOP_TEXT_MAX_RETRIES,
};
