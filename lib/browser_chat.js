const crypto = require('crypto');

const VALID_PROVIDERS = new Set(['chatgpt', 'claude', 'gemini']);

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
]);

function normalizeStreamSignal(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const provider = normalizeProvider(body.provider);
  if (!provider) return { ok: false, error: 'provider must be chatgpt, claude, or gemini' };
  const tabId = Number.parseInt(body.tab_id, 10);
  const marker = typeof body.marker === 'string' ? body.marker.trim() : '';
  if (marker && !STREAM_SIGNAL_MARKERS.has(marker)) {
    return { ok: false, error: `unknown stream marker "${marker}"` };
  }
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
      updated_at: new Date().toISOString(),
    };
    byTabId.set(tabId, snapshot);
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
    return { ok: true, signal };
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

  return {
    getToken: () => token,
    verifyToken,
    ingestSnapshot,
    ingestStreamSignal,
    listStreamSignals,
    listAllStreamSignals,
    streamConversationIdForTab,
    listByProvider,
    findSnapshot,
    removeTab,
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
function shouldCompleteBrowserChatWatch(watchTracking, snapshot) {
  if (!watchTracking || watchTracking.kind !== 'browser_chat') return false;
  if (!snapshot) return false;
  if (snapshot.failure_signal) return true;
  if (snapshot.completion_signal) return true;
  if (!snapshot.generating) return true;
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

function applyBrowserChatResume(getState, onResumeTask, provider, conversation_id) {
  const p = normalizeProvider(provider);
  const cid = normalizeConversationId(conversation_id);
  if (!p || !cid) return 0;
  let resumed = 0;
  for (const project of getState().projects || []) {
    for (const task of project.tasks || []) {
      if (task.status === 'waiting') continue;
      const wt = task.completed_watch_tracking;
      if (!wt || wt.kind !== 'browser_chat') continue;
      if (wt.provider !== p) continue;
      if (normalizeConversationId(wt.conversation_id) !== cid) continue;
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
};
