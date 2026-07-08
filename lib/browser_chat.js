const crypto = require('crypto');

const VALID_PROVIDERS = new Set(['chatgpt', 'claude', 'gemini']);

// Stream markers that mean a turn ENDED. A stream-signal carrying one of these must never resume a
// completed watch: it is the tail of the turn we just cleared, not the start of a new one. (Gemini's
// StreamGenerate emits `end_of_stream` — and often a `stream_handoff` resume token — at stream close,
// carrying the same conversation_id; without this guard that races the /complete edge and flaps the
// task done→working. See applyBrowserChatResume.)
const TERMINAL_STREAM_MARKERS = new Set(['[DONE]', 'message_stop', 'end_of_stream', 'task_completed']);

// Quiet window after a browser-chat watch completes during which network/stream-signal resumes for
// that same conversation are ignored. Post-completion housekeeping (Gemini's end-of-stream tokens,
// trailing batchexecute attribution) lands within a few seconds of the done; a genuine follow-up
// needs the human to read and type, so it lands far later. 8s clears the observed ~5s tail with
// margin. Applied ONLY to the stream-signal path — a DOM generating:true snapshot is authoritative
// and resumes immediately regardless.
const BROWSER_CHAT_RESUME_QUIET_MS = 8000;

function normalizeProvider(p) {
  if (p === 'chatgpt' || p === 'claude' || p === 'gemini') return p;
  return null;
}

function normalizeConversationId(id) {
  if (typeof id !== 'string' || !id.trim()) return '';
  return id.trim().toLowerCase();
}

function defaultBrowserChatTracking({ provider, conversation_id, url = '', title = '', last_user_preview = '', tab_id = null }) {
  const iso = new Date().toISOString();
  return {
    kind: 'browser_chat',
    provider,
    conversation_id: normalizeConversationId(conversation_id),
    url: typeof url === 'string' ? url : '',
    title: typeof title === 'string' ? title : '',
    last_user_preview: typeof last_user_preview === 'string' ? last_user_preview : '',
    tab_id: tab_id != null && Number.isInteger(Number(tab_id)) ? Number(tab_id) : null,
    linked_at: iso,
    last_seen_at: null,
    last_error: null,
  };
}

function normalizeBrowserChatTracking(input) {
  if (!input || typeof input !== 'object') return null;
  const provider = normalizeProvider(input.provider);
  if (!provider) return null;
  const conversation_id = normalizeConversationId(input.conversation_id);
  if (!conversation_id) return null;
  const base = defaultBrowserChatTracking({
    provider,
    conversation_id,
    url: input.url,
    title: input.title,
    last_user_preview: input.last_user_preview,
    tab_id: input.tab_id,
  });
  return {
    ...base,
    ...input,
    kind: 'browser_chat',
    provider,
    conversation_id,
    url: typeof input.url === 'string' ? input.url : base.url,
    title: typeof input.title === 'string' ? input.title : base.title,
    last_user_preview: typeof input.last_user_preview === 'string' ? input.last_user_preview : base.last_user_preview,
    tab_id: base.tab_id,
    linked_at: input.linked_at || base.linked_at,
    last_seen_at: input.last_seen_at || null,
    last_error: input.last_error || null,
  };
}

/**
 * Parse a pasted chat URL into provider + conversation_id.
 * @returns {{ provider: string, conversation_id: string } | null}
 */
function parseChatUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname || '';

  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) {
    const m = path.match(/\/c\/([^/?#]+)/i);
    if (m) return { provider: 'chatgpt', conversation_id: normalizeConversationId(m[1]) };
    return null;
  }
  if (host === 'chat.openai.com') {
    const m = path.match(/\/c\/([^/?#]+)/i);
    if (m) return { provider: 'chatgpt', conversation_id: normalizeConversationId(m[1]) };
    return null;
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    const m = path.match(/\/chat\/([^/?#]+)/i);
    if (m) return { provider: 'claude', conversation_id: normalizeConversationId(m[1]) };
    return null;
  }
  if (host === 'gemini.google.com') {
    const m = path.match(/\/app\/([^/?#]+)/i);
    if (m) return { provider: 'gemini', conversation_id: normalizeConversationId(m[1]) };
    return null;
  }
  return null;
}

// Structural-only stream-signal markers we accept (S1/S3/S4/S5 + end-of-stream + the id-only case).
// Anything else is dropped — the body never carries model content, but we whitelist to be safe.
const STREAM_SIGNAL_MARKERS = new Set([
  'stream_handoff',
  '[DONE]',
  'message_stop',
  'end_of_stream',
  'conversation_id',
  // Claude deep-research task-status poll: the canonical done edge plus the per-poll observability
  // markers (`task_status:<enum>`, accepted via the prefix check below).
  'task_completed',
]);

// `task_status:<enum>` carries the raw status value for observability (Phase 0 confirmation). The
// suffix is the validated lowercase enum from the body; bound it so the whitelist stays meaningful.
const TASK_STATUS_MARKER_RE = /^task_status:[a-z_]{3,30}$/;

function isAcceptedStreamMarker(marker) {
  return STREAM_SIGNAL_MARKERS.has(marker) || TASK_STATUS_MARKER_RE.test(marker);
}

function normalizeStreamSignal(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const provider = normalizeProvider(body.provider);
  if (!provider) return { ok: false, error: 'provider must be chatgpt, claude, or gemini' };
  const tabId = Number.parseInt(body.tab_id, 10);
  const marker = typeof body.marker === 'string' ? body.marker.trim() : '';
  if (marker && !isAcceptedStreamMarker(marker)) {
    return { ok: false, error: `unknown stream marker "${marker}"` };
  }
  const bodyMs = Number(body.body_ms);
  const signal = {
    tab_id: Number.isInteger(tabId) && tabId > 0 ? tabId : null,
    provider,
    conversation_id: normalizeConversationId(body.conversation_id),
    // turn_id is an opaque structural token (lowercased for stable matching); never content.
    turn_id: typeof body.turn_id === 'string' ? body.turn_id.trim().toLowerCase() : '',
    marker,
    endpoint: typeof body.endpoint === 'string' ? body.endpoint : '',
    method: typeof body.method === 'string' ? body.method : '',
    t: Number.isFinite(Number(body.t)) ? Number(body.t) : Date.now(),
    // Structural stream-shape metadata (see spoofer.js emitStreamSignals): whether the body carried
    // a stream_handoff frame, and how long the sniffed body streamed. Both drive the chatgpt
    // hidden-tab done heuristic; neither ever carries content.
    handoff: body.handoff === true,
    body_ms: Number.isFinite(bodyMs) && bodyMs >= 0 ? Math.round(bodyMs) : 0,
    received_at: new Date().toISOString(),
  };
  return { ok: true, signal };
}

function createBrowserChatStore(options = {}) {
  const token = options.token || crypto.randomBytes(24).toString('hex');
  /** @type {Map<number, object>} */
  const byTabId = new Map();
  // Stream-body signals (structural only), keyed by tab. Capped ring per tab so a long session can't
  // grow unbounded. The latest stream conversation_id is the authoritative attribution key for
  // ChatGPT/Gemini (closing the findings/10 §4 weak spot), so we also index it per tab.
  /** @type {Map<number, Array<object>>} */
  const streamSignalsByTabId = new Map();
  /** @type {Map<number, string>} */
  const streamConversationByTabId = new Map();
  const MAX_STREAM_SIGNALS_PER_TAB = 200;
  // Conversations with a claude deep-research task currently running. Keyed by `provider:cid`. A DR
  // task polls `task/…/status` with a non-terminal enum (e.g. "searching") while it runs, then a
  // terminal enum (→ `task_completed`). While in flight, a bare `generating:false` DOM flicker (the
  // initial ack briefly drops the stop button before the research phase) must NOT complete the watch
  // — only the real DOM landmark (completion_signal/failure_signal) or the task_completed edge may.
  /** @type {Set<string>} */
  const deepResearchInFlight = new Set();
  // provider:cid -> the newest conversation-turn number observed while the research runs (the
  // intro/ack turn). The chatgpt DR completion gate clears only on a completion turn NEWER than
  // this baseline — the intro's own (false) completion landmark can never clear, while the report
  // turn clears the moment its completion snapshot arrives. Lifecycle mirrors deepResearchInFlight.
  /** @type {Map<string, number>} */
  const drBaselineTurnByKey = new Map();

  function verifyToken(req) {
    const header = typeof req.get === 'function' ? req.get('x-browser-chat-token') : null;
    const bodyToken = req.body && typeof req.body === 'object' ? req.body.token : undefined;
    const q = req.query && typeof req.query === 'object' ? req.query.token : undefined;
    const t = header || bodyToken || q;
    return typeof t === 'string' && t === token;
  }

  function ingestSnapshot(body) {
    const tabId = Number.parseInt(body.tab_id, 10);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { ok: false, error: 'tab_id must be a positive integer' };
    }
    const provider = normalizeProvider(body.provider);
    if (!provider) {
      return { ok: false, error: 'provider must be chatgpt, claude, or gemini' };
    }
    const conversation_id = normalizeConversationId(body.conversation_id);
    const snapshot = {
      tab_id: tabId,
      provider,
      conversation_id,
      url: typeof body.url === 'string' ? body.url : '',
      title: typeof body.title === 'string' ? body.title : '',
      last_user_preview: typeof body.last_user_preview === 'string' ? body.last_user_preview : '',
      generating: !!body.generating,
      completion_signal: !!body.completion_signal,
      failure_signal: !!body.failure_signal,
      failure_reason: typeof body.failure_reason === 'string' ? body.failure_reason : '',
      activity_summary: typeof body.activity_summary === 'string' ? body.activity_summary : '',
      // Structural turn anchors for the chatgpt deep-research completion gate (ints or null):
      // latest_turn = highest conversation-turn number in the DOM; completion_turn = the turn the
      // completed-response actions belong to. See shouldCompleteBrowserChatWatch.
      latest_turn: Number.isInteger(body.latest_turn) && body.latest_turn >= 0 ? body.latest_turn : null,
      completion_turn: Number.isInteger(body.completion_turn) && body.completion_turn >= 0 ? body.completion_turn : null,
      // Parent-DOM deep-research card observation: the research UI renders in a cross-origin
      // sandboxed iframe (connector_*.web-sandbox.oaiusercontent.com) whose CONTENTS the content
      // script cannot read, but whose <iframe> element it CAN see. True while that card is visible
      // and the report turn has not landed. Used as a DOM-side in-flight arm below.
      deep_research_active: !!body.deep_research_active,
      // Raw (ungated) research-card iframe visibility — observability/diagnostics only; never
      // arms or clears anything (deep_research_active above is the live-mount+turn gated arm).
      dr_card_visible: !!body.dr_card_visible,
      // Whether the page's in-frame research observer has been heard from (diagnostic only).
      dr_frame_seen: !!body.dr_frame_seen,
      // Loaded-extension version, surfaced to the wave's preflight (stale-extension warning).
      extension_version: typeof body.extension_version === 'string' ? body.extension_version : '',
      updated_at: new Date().toISOString(),
    };
    byTabId.set(tabId, snapshot);
    // DOM-side in-flight arm: the visible research card marks the research running from the very
    // first snapshot — earlier than the network arm (first call_mcp), so the false clears around
    // research start (bare generating:false at ~0s, the intro's completion actions) are held even
    // if the network race is lost. Never DISARMS on deep_research_active:false — a hidden tab's
    // frozen DOM can misreport; only the turn gate / task_completed / complete / cancel drop it.
    if (snapshot.deep_research_active && conversation_id) {
      deepResearchInFlight.add(`${provider}:${conversation_id}`);
    }
    // A DOM FAILURE landmark ends any deep-research task for this conversation — drop the in-flight
    // flag so it can't suppress later clears. completion_signal deliberately does NOT drop it:
    // chatgpt's DR intro grows response actions that read as a (false) completion mid-research —
    // the flag drops only on the researched-quiescence task_completed / the /complete or /cancel
    // endpoints (see shouldCompleteBrowserChatWatch).
    if (snapshot.failure_signal && conversation_id) {
      deepResearchInFlight.delete(`${provider}:${conversation_id}`);
      drBaselineTurnByKey.delete(`${provider}:${conversation_id}`);
    }
    // Deep-research BASELINE turn: the newest conversation turn known while the research runs but
    // before the report lands (in practice the intro/ack turn). The intro's response actions raise
    // false completion_signal for THIS turn all through the research; the real report is a LATER
    // turn — so the completion gate clears only on completion_turn > baseline. First qualifying
    // snapshot wins; the baseline never moves once set (later snapshots still show the same latest
    // turn until the report appears, at which point we must NOT re-anchor to it).
    if (conversation_id && snapshot.latest_turn != null
        && deepResearchInFlight.has(`${provider}:${conversation_id}`)
        && !drBaselineTurnByKey.has(`${provider}:${conversation_id}`)) {
      drBaselineTurnByKey.set(`${provider}:${conversation_id}`, snapshot.latest_turn);
    }
    // A completion for a turn NEWER than the baseline is the research's real report — the research
    // is over. Drop the hold NOW (authoritatively, at ingest) so the next poll clears on this very
    // snapshot, and so a follow-up turn in the same conversation is never suppressed by a stale
    // flag. (A completion on the baseline turn itself is the intro's false landmark — held; the
    // 240s call_mcp quiescence backstop remains the fallback done for that case.)
    if (conversation_id && snapshot.completion_signal) {
      const drKey = `${provider}:${conversation_id}`;
      if (deepResearchInFlight.has(drKey)) {
        const baseline = drBaselineTurnByKey.get(drKey);
        if (Number.isInteger(baseline) && snapshot.completion_turn != null && snapshot.completion_turn > baseline) {
          deepResearchInFlight.delete(drKey);
          drBaselineTurnByKey.delete(drKey);
        }
      }
    }
    return { ok: true, snapshot };
  }

  function listByProvider(providerFilter) {
    const want = normalizeProvider(providerFilter);
    const list = [];
    for (const snap of byTabId.values()) {
      if (want && snap.provider !== want) continue;
      list.push(snap);
    }
    list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    return list;
  }

  function findSnapshot(providerFilter, conversationId) {
    const want = normalizeProvider(providerFilter);
    const cid = normalizeConversationId(conversationId);
    if (!want || !cid) return null;
    let best = null;
    for (const snap of byTabId.values()) {
      if (snap.provider !== want) continue;
      if (normalizeConversationId(snap.conversation_id) !== cid) continue;
      if (!best || (snap.updated_at || '').localeCompare(best.updated_at || '') > 0) {
        best = snap;
      }
    }
    return best;
  }

  function ingestStreamSignal(body) {
    const result = normalizeStreamSignal(body);
    if (!result.ok) return result;
    const signal = result.signal;
    if (signal.tab_id != null) {
      const list = streamSignalsByTabId.get(signal.tab_id) || [];
      list.push(signal);
      if (list.length > MAX_STREAM_SIGNALS_PER_TAB) list.splice(0, list.length - MAX_STREAM_SIGNALS_PER_TAB);
      streamSignalsByTabId.set(signal.tab_id, list);
      // A stream-carried conversation_id is the authoritative attribution key for ChatGPT/Gemini.
      if (signal.conversation_id && (signal.provider === 'chatgpt' || signal.provider === 'gemini')) {
        streamConversationByTabId.set(signal.tab_id, signal.conversation_id);
      }
    }
    // Track deep-research progress: a non-terminal task_status marks the task in flight; the
    // task_completed edge ends it. Keyed by conversation so the completion check can find it.
    // claude: markers come from the task-status poll body (spoofer). chatgpt (findings §3.6): the
    // extension synthesizes `task_status:active` from the `ecosystem/call_mcp` research loop —
    // its DR-mode UI never reads as generating, so without this flag the first bare
    // generating:false snapshot false-clears the watch at ~0s of a multi-minute research.
    if ((signal.provider === 'claude' || signal.provider === 'chatgpt') && signal.conversation_id) {
      const key = `${signal.provider}:${signal.conversation_id}`;
      if (signal.marker === 'task_completed') {
        deepResearchInFlight.delete(key);
        drBaselineTurnByKey.delete(key);
      } else if (signal.marker === 'task_status:ended') {
        // NEUTRAL: the chatgpt in-frame observer's research-UI-ended edge. The research phase is
        // over but the report may still be WRITING — so it must not arm (it is not running work)
        // and must not drop the hold (the false intro completion would clear instantly). The hold
        // drops on the report turn, task_completed, /complete, or /cancel.
      } else if (signal.marker.startsWith('task_status:')) {
        deepResearchInFlight.add(key);
        // Anchor the completion-gate baseline from the conversation's current snapshot if one is
        // already known (snapshot-first arrival order); the snapshot ingest path covers the
        // signal-first order. First anchor wins (see ingestSnapshot).
        if (!drBaselineTurnByKey.has(key)) {
          const snap = findSnapshot(signal.provider, signal.conversation_id);
          if (snap && snap.latest_turn != null) drBaselineTurnByKey.set(key, snap.latest_turn);
        }
      }
    }
    return { ok: true, signal };
  }

  // Is a deep-research task currently running for this conversation? (See deepResearchInFlight.)
  function isDeepResearchInFlight(providerFilter, conversationId) {
    const want = normalizeProvider(providerFilter);
    const cid = normalizeConversationId(conversationId);
    if ((want !== 'claude' && want !== 'chatgpt') || !cid) return false;
    return deepResearchInFlight.has(`${want}:${cid}`);
  }

  // Drop the deep-research-in-flight flag for a conversation whose watch just completed/cancelled —
  // the /complete and /cancel endpoints call this so a lingering flag can't suppress the bare
  // generating:false clear of a FOLLOW-UP standard turn in the same conversation.
  function clearDeepResearchInFlightFor(providerFilter, conversationId) {
    const want = normalizeProvider(providerFilter);
    const cid = normalizeConversationId(conversationId);
    if (want && cid) {
      deepResearchInFlight.delete(`${want}:${cid}`);
      drBaselineTurnByKey.delete(`${want}:${cid}`);
    }
  }

  // The completion-gate baseline for a running deep research (null when unset). See ingestSnapshot.
  function deepResearchBaselineTurn(providerFilter, conversationId) {
    const want = normalizeProvider(providerFilter);
    const cid = normalizeConversationId(conversationId);
    if (!want || !cid) return null;
    const v = drBaselineTurnByKey.get(`${want}:${cid}`);
    return Number.isInteger(v) ? v : null;
  }

  function listStreamSignals(tabId) {
    const id = Number.parseInt(tabId, 10);
    if (!Number.isInteger(id) || id <= 0) return [];
    return (streamSignalsByTabId.get(id) || []).slice();
  }

  function listAllStreamSignals(providerFilter) {
    const want = normalizeProvider(providerFilter);
    const out = [];
    for (const list of streamSignalsByTabId.values()) {
      for (const sig of list) {
        if (want && sig.provider !== want) continue;
        out.push(sig);
      }
    }
    out.sort((a, b) => (a.t || 0) - (b.t || 0));
    return out;
  }

  /**
   * The authoritative conversation id for a tab: prefer the stream-body id (S1/S5) when present,
   * else fall back to the provided fallback (the tab-URL guess). Closes the §4 weak spot.
   */
  function streamConversationIdForTab(tabId, fallback = '') {
    const id = Number.parseInt(tabId, 10);
    const fromStream = Number.isInteger(id) ? streamConversationByTabId.get(id) : '';
    return fromStream || normalizeConversationId(fallback);
  }

  function removeTab(tabId) {
    const id = Number.parseInt(tabId, 10);
    if (Number.isInteger(id) && id > 0) {
      byTabId.delete(id);
      streamSignalsByTabId.delete(id);
      streamConversationByTabId.delete(id);
    }
  }

  // Reconcile the store against the extension's actual open provider tabs (the /tabs-sync
  // endpoint). A tab closed while the MV3 worker was asleep never posts /tab-closed, leaving a
  // phantom "generating" item (and its picker row) behind forever — observed as a stale
  // generating:true chatgpt item hours after its tab died (findings §3.7). The extension posts the
  // full open-tab list on worker startup; anything not in it is gone.
  function pruneMissingTabs(openTabIds) {
    const keep = new Set();
    for (const raw of Array.isArray(openTabIds) ? openTabIds : []) {
      const id = Number.parseInt(raw, 10);
      if (Number.isInteger(id) && id > 0) keep.add(id);
    }
    let pruned = 0;
    for (const id of [...byTabId.keys()]) {
      if (keep.has(id)) continue;
      removeTab(id);
      pruned += 1;
    }
    return pruned;
  }

  // Drop ALL retained stream-body signals (every tab). The stream-signal store, unlike snapshots,
  // accumulates across runs — a fresh capture would otherwise ingest a prior run's terminal markers
  // (observed: claude `message_stop`/`end_of_stream` leaking into a later deep-research capture).
  // The harness calls this before each wave so done-detection sees only this run's markers. Learned
  // conversation ids are kept (cheap, tab-scoped); only the signal lists are cleared.
  function clearStreamSignals() {
    streamSignalsByTabId.clear();
    deepResearchInFlight.clear();
    drBaselineTurnByKey.clear();
  }

  return {
    getToken: () => token,
    verifyToken,
    ingestSnapshot,
    ingestStreamSignal,
    listStreamSignals,
    listAllStreamSignals,
    clearStreamSignals,
    isDeepResearchInFlight,
    clearDeepResearchInFlightFor,
    deepResearchBaselineTurn,
    streamConversationIdForTab,
    listByProvider,
    findSnapshot,
    removeTab,
    pruneMissingTabs,
    parseChatUrl,
    normalizeBrowserChatTracking,
    defaultBrowserChatTracking,
  };
}

/**
 * Whether a linked browser_chat watch should clear from the latest extension snapshot.
 * @param {object|null} watchTracking
 * @param {object|null} snapshot from browserChatStore.findSnapshot
 */
function shouldCompleteBrowserChatWatch(watchTracking, snapshot, opts = {}) {
  if (!watchTracking || watchTracking.kind !== 'browser_chat') return false;
  if (!snapshot) return false;
  // A DOM failure landmark always clears, even mid deep-research (the turn is over either way).
  if (snapshot.failure_signal) return true;
  if (snapshot.completion_signal) {
    // chatgpt deep research: the DOM completion landmark is NOT trustworthy while the research is
    // in flight — the intro/ack message grows response-action buttons that read as a completed
    // report (observed: completion_signal at 124s of a 12+ min research). The intro is its own
    // conversation turn though, and the REAL report is a LATER turn — so a completion belonging to
    // a turn NEWER than the research's baseline turn (opts.drBaselineTurn, anchored at research
    // start) clears immediately (fast done, works on hidden tabs — the completion snapshot arrives
    // via MutationObserver). Anything else is HELD until the in-flight flag drops (the call_mcp
    // quiescence backstop posts task_completed + /complete — both drop the flag — and the next
    // poll then clears on this same stored snapshot). claude is unaffected: its task_completed
    // edge drops the flag before the report completion snapshot.
    if (opts.deepResearchInFlight && watchTracking.provider === 'chatgpt') {
      return Number.isInteger(opts.drBaselineTurn)
        && Number.isInteger(snapshot.completion_turn)
        && snapshot.completion_turn > opts.drBaselineTurn;
    }
    return true;
  }
  // A bare generating:false (no explicit landmark) clears a normal chat turn — but during a claude
  // deep-research task it is the ack flicker (stop button briefly gone before the research phase),
  // NOT the done. Suppress it while the task is in flight; the task_completed edge / a real DOM
  // landmark clears instead. (deepResearchInFlight comes from the task-status stream signals.)
  if (!snapshot.generating) return !opts.deepResearchInFlight;
  return false;
}

/**
 * Mark waiting tasks that watch this browser chat as todo and clear watch state.
 * @returns {number} number of tasks updated
 */
function applyBrowserChatCompletion(getState, onEachTask, provider, conversation_id) {
  const p = normalizeProvider(provider);
  const cid = normalizeConversationId(conversation_id);
  if (!p || !cid) return 0;
  let completed = 0;
  for (const project of getState().projects || []) {
    for (const task of project.tasks || []) {
      if (task.status !== 'waiting') continue;
      const wt = task.watch_tracking;
      if (!wt || wt.kind !== 'browser_chat') continue;
      if (wt.provider !== p) continue;
      if (normalizeConversationId(wt.conversation_id) !== cid) continue;
      onEachTask(task);
      task.watch_tracking = null;
      task.cursor_tracking = null;
      completed += 1;
    }
  }
  return completed;
}

/**
 * Re-open a completed browser-chat watch when its conversation produces fresh activity (a follow-up
 * turn). Three guards keep post-completion housekeeping from flapping the task done→working:
 *   - `marker`: a terminal stream marker ([DONE]/message_stop/end_of_stream) never resumes — it is
 *     the end of the turn we just cleared. (Snapshot/DOM callers pass no marker.)
 *   - `marker`: a `task_status:*` marker never resumes either. These are deep-research in-flight
 *     housekeeping, and both providers emit them on IDLE tabs: claude's recurring status poll, and
 *     chatgpt's isolated `call_mcp` bursts on an idle DR conversation (observed live 2026-07-03:
 *     an idle chatgpt DR tab produced a task_status:active → 240s-backstop task_completed cycle
 *     every ~15min — with a completed watch that would flap done→working→done forever). A research
 *     the user really restarted resumes via the DOM generating:true snapshot path instead.
 *   - `minQuietMsAfterDoneMs`: skip a task whose watch finished less than this many ms ago (judged by
 *     `task.watch_finished.at`). Set for the network/stream-signal path; left 0 for the DOM path,
 *     where a generating:true snapshot is authoritative.
 * @returns {number} number of tasks resumed
 */
function applyBrowserChatResume(getState, onResumeTask, provider, conversation_id, opts = {}) {
  const p = normalizeProvider(provider);
  const cid = normalizeConversationId(conversation_id);
  if (!p || !cid) return 0;
  const { marker = '', nowMs = Date.now(), minQuietMsAfterDoneMs = 0 } = opts;
  // A turn-terminator marker can never start a new turn — block the whole resume.
  if (marker && TERMINAL_STREAM_MARKERS.has(marker)) return 0;
  // Deep-research in-flight housekeeping is not a new turn either (see doc above).
  if (marker && marker.startsWith('task_status:')) return 0;
  let resumed = 0;
  for (const project of getState().projects || []) {
    for (const task of project.tasks || []) {
      if (task.status === 'waiting') continue;
      const wt = task.completed_watch_tracking;
      if (!wt || wt.kind !== 'browser_chat') continue;
      if (wt.provider !== p) continue;
      if (normalizeConversationId(wt.conversation_id) !== cid) continue;
      // Within the quiet window after this watch finished, treat the signal as trailing housekeeping
      // from the just-cleared turn rather than a new one.
      if (minQuietMsAfterDoneMs > 0) {
        const finishedAt = Date.parse((task.watch_finished && task.watch_finished.at) || '') || 0;
        if (finishedAt && (nowMs - finishedAt) < minQuietMsAfterDoneMs) continue;
      }
      onResumeTask(task, wt);
      resumed += 1;
    }
  }
  return resumed;
}

module.exports = {
  VALID_PROVIDERS,
  normalizeProvider,
  normalizeConversationId,
  normalizeStreamSignal,
  STREAM_SIGNAL_MARKERS,
  defaultBrowserChatTracking,
  normalizeBrowserChatTracking,
  parseChatUrl,
  createBrowserChatStore,
  shouldCompleteBrowserChatWatch,
  applyBrowserChatCompletion,
  applyBrowserChatResume,
  TERMINAL_STREAM_MARKERS,
  BROWSER_CHAT_RESUME_QUIET_MS,
};
