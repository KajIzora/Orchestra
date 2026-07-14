'use strict';

/*
 * browser_stream_adapter.js — live-feed browser assistant-text adapter (FollowUps §3.3).
 *
 * Browser rows are tier-0 by default: Orchestra never reads browser conversations. When the user
 * turns on the extension's explicit body-streaming opt-in, the chat-watch extension posts the
 * assistant's message text to POST /api/browser-chats/stream-body, which the browser chat store
 * keeps as ONE current message per conversation (lib/browser_chat.js ingestStreamBody). This adapter
 * maps that store entry into live-feed events for the opted-in task:
 *
 *   - a `prompt` row at the start of each turn (from wt.last_user_preview), which resets the ring turn;
 *   - ONE `note` that is UPDATED IN PLACE as the reply streams (never a second note — a long reply
 *     must not flood the 300-event ring; the in-place technique mirrors live_agy_tail_adapter.js);
 *   - a `stop` row carrying the final message when the store entry flips `final`.
 *
 * It is a tailAdapters-seam adapter: `pump(taskId, wt, nowMs)` is called synchronously each poll
 * (live_feed_service.js). Unlike the disk-tail adapters, the read here is a synchronous in-memory
 * store lookup — no background scheduling — so the events land in the SAME poll's snapshot.
 *
 * SAFETY: no-ops unless the watch is a stream-opted-in browser_chat (wt.stream_optin); every path is
 * try/catch fail-safe (an adapter can never break a task's feed); env off-switch
 * ORCHESTRA_LIVEFEED_BROWSER_STREAM=0 forces zero reads.
 *
 * KNOWN RESIDUAL (documented, mirrors live_agy_tail_adapter.js:437-442): the note is UPDATED IN
 * PLACE, so a full snapshot (a fresh poller, or the browser cell which full-snapshots — surface
 * 'browser' has no delta client holding the row across the stream) always sees the latest text, but
 * a hypothetical delta client already holding the row would not re-receive the mutated `text` until
 * the next turn reset. The final message lands as a NEW `stop` event, so the done strip is always
 * delivered to delta clients regardless.
 */

const { CAPS, clamp, clampBlock } = require('./live_turn_normalizer');

function envOff() {
  return /^(0|false|no|off)$/i.test(String(process.env.ORCHESTRA_LIVEFEED_BROWSER_STREAM || ''));
}

/**
 * Factory for the live_feed_service tailAdapters array.
 * @param {object} opts
 * @param {object} opts.ring   the service's live turn ring (append/ensure/snapshot)
 * @param {object} opts.store  browserChatStore (latestStreamBody)
 * @param {Function} [opts.now]
 */
function createBrowserStreamAdapter({ ring, store, now = Date.now } = {}) {
  // taskId -> { turnSeq, promptEmitted, noteSeq, appliedText, finalEmitted }
  const stateByTask = new Map();

  function ensureState(taskId, turnSeq) {
    const prev = stateByTask.get(taskId);
    if (prev && prev.turnSeq === turnSeq) return prev;
    // New turn (or first sight): fresh state. The ring turn is reset by appending the prompt below.
    const state = { turnSeq, promptEmitted: false, noteSeq: null, appliedText: '', finalEmitted: false };
    stateByTask.set(taskId, state);
    return state;
  }

  function pump(taskId, wt, nowMs) {
    try {
      if (envOff()) return 0;
      if (!ring || !store || !taskId) return 0;
      if (!wt || wt.kind !== 'browser_chat' || wt.stream_optin !== true) return 0;
      if (typeof store.latestStreamBody !== 'function') return 0;
      const entry = store.latestStreamBody(wt.provider, wt.conversation_id);
      if (!entry) return 0;

      const at = Number.isFinite(nowMs) ? nowMs : now();
      const text = typeof entry.text === 'string' ? entry.text : '';
      const state = ensureState(taskId, entry.turn_seq || 1);
      let appended = 0;

      // 1) Prompt row (turn start). Resets the ring turn and seeds t0. Uses the recorded prompt
      //    preview; falls back to a neutral label so the turn boundary still renders.
      if (!state.promptEmitted) {
        const promptText = clamp(String(wt.last_user_preview || '').trim() || 'Browser chat', CAPS.promptText);
        ring.append(taskId, [{ abs_ms: at, kind: 'prompt', text: promptText }]);
        state.promptEmitted = true;
        appended += 1;
      }

      // 2) ONE evolving note (updated in place). Append it once, then mutate its text on later polls.
      const noteText = clamp(text, CAPS.noteText);
      if (noteText) {
        if (state.noteSeq == null) {
          ring.append(taskId, [{ abs_ms: at, kind: 'note', text: noteText }]);
          const snap = ring.snapshot(taskId, null);
          const noteEv = [...snap.events].reverse().find((e) => e.kind === 'note');
          state.noteSeq = noteEv ? noteEv.seq : null;
          state.appliedText = noteText;
          appended += 1;
        } else if (noteText !== state.appliedText) {
          const re = ring.ensure(taskId);
          const target = re.events.find((e) => e.seq === state.noteSeq && e.kind === 'note');
          if (target) {
            target.text = noteText; // UPDATE IN PLACE (see live_agy_tail_adapter.js)
            state.appliedText = noteText;
          } else {
            // The note was evicted/turn-rolled out from under us — re-append rather than lose it.
            ring.append(taskId, [{ abs_ms: at, kind: 'note', text: noteText }]);
            const snap = ring.snapshot(taskId, null);
            const noteEv = [...snap.events].reverse().find((e) => e.kind === 'note');
            state.noteSeq = noteEv ? noteEv.seq : null;
            state.appliedText = noteText;
            appended += 1;
          }
        }
      }

      // 3) Final message → a NEW stop event (delivered to delta clients too). Once per turn.
      if (entry.final === true && !state.finalEmitted) {
        const stopText = clampBlock(text, CAPS.stopText);
        ring.append(taskId, [{ abs_ms: at, kind: 'stop', text: stopText }]);
        state.finalEmitted = true;
        appended += 1;
      }

      return appended;
    } catch {
      return 0; // fail safe: never break a task's feed
    }
  }

  return { pump, _stateByTask: stateByTask };
}

module.exports = {
  createBrowserStreamAdapter,
};
