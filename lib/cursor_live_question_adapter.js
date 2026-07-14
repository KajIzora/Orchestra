'use strict';

/*
 * cursor_live_question_adapter.js — Phase-2b cursor-cli question pull adapter (live-feed Seam B).
 *
 * Cursor has NO hook for AskQuestion (LiveFeedDataRequirements §cursor: questions are pull, not
 * push), so the normalizer's hook path never emits a question gate. This adapter fills that gap for
 * the LIVE FEED: it reads the cursor-agent chat store.db head — which carries the FULL AskQuestion
 * payload ({ title, questions[] }) WHILE the gate is held (verified in the committed
 * signal-lab/cursor-cli/2026-07-11T02-53-53-347Z recording, `tool-call.args`) — and appends
 * `gate_open {gate_kind:'question', questions}` + a later `gate_answered` LiveTurnEvent to the
 * task's ring. The ring assigns seq/t and handles turn/FIFO (core-implementation-notes §5 Seam B).
 *
 * It REUSES the canonical store.db reader (lib/cursor_chat_db.js headPendingQuestion) — the same
 * mtime/size-gated read the watch poller already runs each tick for getCursorChatDbQuestionHint —
 * so a poll shares one store.db read, never a second. No transcript read is needed: the store.db
 * head advancing past the AskQuestion (pending → not-pending) is itself the answered signal, and it
 * carries the payload pre-answer (an upgrade over the transcript row, which cursor writes only AFTER
 * the user answers — see cursor_tracker.js:637).
 *
 * SAFETY: cursor-cli only by nature — IDE chats live in state.vscdb (findChatDbDir returns nothing)
 * and headless ssh runs keep the store.db on the remote, so both degrade to "no question event"
 * without any cli/ide keying. Every read is try/catch fail-safe and short-TTL debounced; a cold or
 * failed read appends nothing (the cell renders lower-tier). It never mutates task/watch state — the
 * needs_input flip stays with the production watch pipeline (see cursorQuestionHintSinceMs below).
 */

const { normalizeQuestions, CAPS, clamp, clampBlock } = require('./live_turn_normalizer');

// Grace window applied to the store.db question gate's linked_at floor. The live harness measured a
// ~26s identity-binding delay (spawn → watch-link) for cursor-cli, during which a fast in-turn
// AskQuestion is asked BEFORE the watch links; the raw linked_at gate (startedAtMs >= linked_at)
// then suppresses that still-pending question forever — the live-verified reason cursor question
// gates never flip needs_input today (LiveTestHarness.md). Relaxing the floor by this margin lets an
// in-turn question that predates the link flip the gate. It is safe: a store.db HEAD that is still a
// pending AskQuestion is by definition an unanswered question (the head advances the instant it is
// answered), so honoring it is always correct — this only widens which pending heads are honored,
// never fabricates a gate, and touches neither the permission path nor the happy-path.
const CURSOR_QUESTION_LINK_GRACE_MS = 3 * 60 * 1000;

// POST-DONE final-message serving (Closure-L6). Cursor's stop hook carries NO text (raw-verified),
// so a finished cursor task shows a blank done strip while claude/codex show the closing message. The
// text DOES exist in the local chat store.db (where the question pull already reads). When a cursor
// task flips done, this adapter waits a beat (the message is flushed to store.db a moment after done —
// a lookup, not a signal) then does ONE bounded read of the conversation's last assistant message and
// appends it as the stop text. FAIL SAFE: no text found ⇒ the strip stays blank, exactly as before.
const POST_DONE_DELAY_MS = 1200; // wait ~a beat after done before the lookup (store.db flush latency)
const POST_DONE_MAX_ATTEMPTS = 5; // bounded retries while the final blob flushes (reads are mtime-gated)

/**
 * The epoch-ms floor for the cursor store.db question gate: linked_at minus the identity-binding
 * grace. Shared by this adapter (live feed) AND server.js getCursorChatDbQuestionHint (the watch
 * needs_input flip) so both honor the same in-turn question. Returns 0 (no gate) when linked_at is
 * absent/unparseable — mirroring pendingAskQuestion's `sinceMs ? … : true`.
 * @param {string} linkedAtIso
 * @param {number} [graceMs]
 * @returns {number}
 */
function cursorQuestionHintSinceMs(linkedAtIso, graceMs = CURSOR_QUESTION_LINK_GRACE_MS) {
  const linkedMs = Date.parse(linkedAtIso || '') || 0;
  if (!linkedMs) return 0;
  const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
  return Math.max(0, linkedMs - grace);
}

/**
 * Build a `gate_open` question LiveTurnEvent from a cursor AskQuestion tool-call args / tool_use
 * input ({ title, questions[] }). Returns null when no structured questions are present. Options are
 * labels-only (cursor carries no option descriptions); per-question `allow_multiple` → `multi`
 * (handled by the shared normalizeQuestions).
 * @param {object|null} args
 * @param {number} startedAtMs
 * @returns {object|null}
 */
function questionGateOpenEvent(args, startedAtMs) {
  const input = args && typeof args === 'object' ? args : null;
  if (!input) return null;
  const questions = normalizeQuestions(Array.isArray(input.questions) ? input.questions : null);
  if (!questions) return null;
  // cursor's tool-level `title` has no slot in the gate_open schema; surface it as the header of the
  // FIRST question when that question has none, so the UI can render the group heading. Cheap, and
  // it never overwrites a real per-question header.
  const title = clamp(input.title || '', CAPS.questionHeader);
  if (title && questions[0] && !questions[0].header) questions[0].header = title;
  return {
    abs_ms: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    kind: 'gate_open',
    gate_kind: 'question',
    questions,
  };
}

/**
 * Pure per-task state machine: given the previous adapter state, the current pull observation, and
 * `nowMs`, return the LiveTurnEvents to append (0, 1) and the next state. Emits `gate_open` once when
 * a new question becomes pending (deduped by startedAtMs so re-polling the same held gate is a
 * no-op) and `gate_answered` once when the announced gate stops being pending (the store.db head
 * advanced → answered). Resets on a turn_id change (a new prompt).
 *
 * @param {object|null} prev  { turnId, startedAtMs, openEmitted, answeredEmitted }
 * @param {object} input      { turnId, pending, startedAtMs, args }
 * @param {number} nowMs
 * @returns {{ state: object, events: object[] }}
 */
function advanceCursorQuestionState(prev, input, nowMs) {
  const turnId = Number.isFinite(input && input.turnId) ? input.turnId : 0;
  const base =
    prev && prev.turnId === turnId
      ? prev
      : { turnId, startedAtMs: null, openEmitted: false, answeredEmitted: false };
  const events = [];
  let state = base;

  const startedAtMs = input && Number.isFinite(input.startedAtMs) ? input.startedAtMs : null;
  if (input && input.pending && startedAtMs != null) {
    if (!state.openEmitted || state.startedAtMs !== startedAtMs) {
      const open = questionGateOpenEvent(input.args, startedAtMs);
      if (open) {
        events.push(open);
        state = { turnId, startedAtMs, openEmitted: true, answeredEmitted: false };
      }
    }
  } else if (state.openEmitted && !state.answeredEmitted) {
    // The gate we announced is no longer a pending head → the user answered (the head advanced past
    // the AskQuestion). Emit gate_answered once. waited_ms is measured to the detection tick, so it
    // includes up to one poll interval of latency (honest, documented).
    const waited = state.startedAtMs != null ? Math.max(0, nowMs - state.startedAtMs) : 0;
    events.push({ abs_ms: nowMs, kind: 'gate_answered', waited_ms: waited });
    state = { ...state, answeredEmitted: true };
  }
  return { state, events };
}

/**
 * Pure per-task state machine for the POST-DONE stop-text lookup. Given the previous state, the
 * current turnId + live state, and nowMs, decide whether to do the bounded store.db read this tick
 * and return the next state. Resets on a turn_id change (a new prompt re-arms — happy-path-again) and
 * whenever the task is not `done`. Emits action:
 *   'read'      → do ONE bounded lastAssistantText read now (attempts incremented; caller marks
 *                 served on success, else the next tick retries up to maxAttempts).
 *   'wait'      → done, but the post-done delay has not elapsed yet.
 *   'exhausted' → done, delay elapsed, but maxAttempts spent with no text (fail-safe: stay blank).
 *   'served'    → the stop text was already served for this done (idempotent).
 *   'none'      → not done (or no turn).
 *
 * @param {object|null} prev  { turnId, doneAtMs, served, attempts }
 * @param {object} input      { turnId, state }  (state = live 'working'|'blocked'|'done'|…)
 * @param {number} nowMs
 * @param {object} [opts]     { delayMs, maxAttempts }
 */
function advancePostDoneStopState(prev, input, nowMs, opts = {}) {
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : POST_DONE_DELAY_MS;
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : POST_DONE_MAX_ATTEMPTS;
  const turnId = Number.isFinite(input && input.turnId) ? input.turnId : 0;
  const state = input ? input.state : '';
  const fresh = { turnId, doneAtMs: null, served: false, attempts: 0 };
  // A turn change (new prompt) OR leaving 'done' re-arms the lookup.
  if (state !== 'done') return { state: fresh, action: 'none' };
  const base = prev && prev.turnId === turnId ? prev : fresh;
  if (base.served) return { state: base, action: 'served' };
  const doneAtMs = base.doneAtMs == null ? nowMs : base.doneAtMs;
  if (nowMs - doneAtMs < delayMs) return { state: { ...base, doneAtMs }, action: 'wait' };
  if (base.attempts >= maxAttempts) return { state: { ...base, doneAtMs }, action: 'exhausted' };
  return { state: { ...base, doneAtMs, attempts: base.attempts + 1 }, action: 'read' };
}

/**
 * Factory: a fail-safe, short-TTL-debounced pull for the live_feed_service pullAdapters map.
 * `pull({ taskId, wt, ring, state })` reads the cursor store.db head-pending question (reusing the
 * injected chatDbReader) and appends question LiveTurnEvents to the ring; when `state === 'done'` it
 * ALSO runs the POST-DONE step (one bounded lastAssistantText read → append the closing message as
 * the stop text). Returns the number of events appended.
 *
 * @param {object} opts
 * @param {object} opts.chatDbReader  createCursorChatDbReader() instance (headPendingQuestion +
 *                                    lastAssistantText — the post-done final message)
 * @param {Function} [opts.now]
 * @param {number} [opts.ttlMs]       sync short-TTL memo window per conversation (debounce)
 * @param {number} [opts.graceMs]     linked_at grace (default CURSOR_QUESTION_LINK_GRACE_MS)
 * @param {number} [opts.postDoneDelayMs]    beat to wait after done before the lookup (store.db flush)
 * @param {number} [opts.postDoneMaxAttempts] bounded retries while the final blob flushes
 */
function createCursorQuestionPull({
  chatDbReader,
  now = Date.now,
  ttlMs = 1500,
  graceMs = CURSOR_QUESTION_LINK_GRACE_MS,
  postDoneDelayMs = POST_DONE_DELAY_MS,
  postDoneMaxAttempts = POST_DONE_MAX_ATTEMPTS,
} = {}) {
  const stateByTask = new Map(); // taskId -> question state
  const postDoneByTask = new Map(); // taskId -> post-done stop-text state
  const readCache = new Map(); // conv -> { atMs, value }

  // Sync short-TTL memo. poll_guard.wrapShortTtlMemo is async (it wraps the read in a promise); the
  // store.db read (execFileSync) and the live_feed_service endpoint path are SYNCHRONOUS, so we use
  // the sync analog here. The reader is ALSO mtime/size-gated internally (it won't re-decode an
  // unchanged db), so this is a second, cheaper bound on read frequency, not the only one.
  function readPending(conv) {
    const prev = readCache.get(conv);
    const nowMs = now();
    if (prev && nowMs - prev.atMs < ttlMs) return prev.value;
    let value = { pending: false, startedAtMs: null, args: null };
    try {
      value = chatDbReader.headPendingQuestion(conv, { sinceMs: 0 }) || value;
    } catch {
      value = { pending: false, startedAtMs: null, args: null };
    }
    readCache.set(conv, { atMs: nowMs, value });
    return value;
  }

  // Append the final assistant message as the stop text, aligned to the existing stop's turn-relative
  // t so the served elapsed_ms is unchanged (the normalizer already emitted stop{text:''}; the
  // service serves the LAST stop's text, so this later stop wins with the closing message). Returns
  // the number appended (0 when no text / no ring). Fail-safe.
  function servePostDoneStop({ taskId, conv, ring, snap, nowMs }) {
    let text = '';
    try {
      text = chatDbReader.lastAssistantText ? chatDbReader.lastAssistantText(conv) : '';
    } catch {
      text = '';
    }
    if (!text) return 0;
    const events = snap && Array.isArray(snap.events) ? snap.events : [];
    let lastStopT = null;
    for (const ev of events) if (ev && ev.kind === 'stop') lastStopT = ev.t;
    const t0 = snap && Number.isFinite(snap.t0_abs_ms) ? snap.t0_abs_ms : 0;
    // Reuse the existing stop's t (keeps elapsed_ms honest); fall back to nowMs if no stop landed yet.
    const absMs = lastStopT != null && t0 ? t0 + lastStopT : nowMs;
    return ring.append(taskId, [{ abs_ms: absMs, kind: 'stop', text: clampBlock(text, CAPS.stopText) }]);
  }

  function pull({ taskId, wt, ring, state } = {}) {
    try {
      if (!wt || wt.kind !== 'cursor' || !ring || !taskId) return 0;
      const conv = String(wt.conversation_id || wt.run_id || '').trim();
      if (!conv) return 0;
      const nowMs = now();
      const sinceMs = cursorQuestionHintSinceMs(wt.linked_at, graceMs);
      const raw = readPending(conv);
      const pending = !!(
        raw && raw.pending && Number.isFinite(raw.startedAtMs) && (!sinceMs || raw.startedAtMs >= sinceMs)
      );
      const snap = ring.snapshot(taskId, null);
      const turnId = snap.turn_id;
      const prev = stateByTask.get(taskId) || null;
      const { state: qState, events } = advanceCursorQuestionState(
        prev,
        { turnId, pending, startedAtMs: raw ? raw.startedAtMs : null, args: raw ? raw.args : null },
        nowMs
      );
      stateByTask.set(taskId, qState);
      let appended = events.length ? ring.append(taskId, events) : 0;

      // POST-DONE final-message step: when the task flips done, do ONE bounded store.db read of the
      // last assistant message and serve it as the stop text. Bounded/retried/fail-safe; re-arms on a
      // new turn (happy-path-again). Only cursor-cli local watches yield text — a remote/IDE watch's
      // store.db isn't local, so lastAssistantText returns '' and the strip stays blank (as today).
      const pdPrev = postDoneByTask.get(taskId) || null;
      const { state: pdState, action } = advancePostDoneStopState(
        pdPrev,
        { turnId, state },
        nowMs,
        { delayMs: postDoneDelayMs, maxAttempts: postDoneMaxAttempts }
      );
      if (action === 'read') {
        const n = servePostDoneStop({ taskId, conv, ring, snap, nowMs });
        if (n > 0) {
          postDoneByTask.set(taskId, { ...pdState, served: true });
          appended += n;
        } else {
          postDoneByTask.set(taskId, pdState); // no text yet → retry next tick (attempts bounded)
        }
      } else {
        postDoneByTask.set(taskId, pdState);
      }
      return appended;
    } catch {
      return 0; // fail safe: a question pull must never break the feed or the task list
    }
  }

  return { pull, _stateByTask: stateByTask, _postDoneByTask: postDoneByTask };
}

module.exports = {
  CURSOR_QUESTION_LINK_GRACE_MS,
  POST_DONE_DELAY_MS,
  POST_DONE_MAX_ATTEMPTS,
  cursorQuestionHintSinceMs,
  questionGateOpenEvent,
  advanceCursorQuestionState,
  advancePostDoneStopState,
  createCursorQuestionPull,
};
