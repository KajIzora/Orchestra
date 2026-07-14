const STORAGE_KEYS = {
  apiBase: 'taskAppChatWatchApiBase',
  token: 'taskAppChatWatchToken',
};

const DEFAULT_PORTS = [47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830];
const CONFIG_FETCH_TIMEOUT_MS = 1500;

/** @type {Map<number, { lastGenerating: boolean, lastConversationId: string }>} */
const tabGenerationState = new Map();
// ChatGPT deep-research quiescence backstop state (see the chatgptResearchFilter block below).
// Declared up here so syncKeepAlive (called at module init) can see it without a TDZ error.
/** @type {Map<number, { lastActivityMs: number, conversationId: string, armed: boolean }>} */
const drBackstopByTab = new Map();
function anyDrBackstopArmed() {
  for (const e of drBackstopByTab.values()) if (e.armed) return true;
  return false;
}
// Live Stop-research button visibility per tab, from the in-frame observer port (v0.5.10). This is
// the PRIMARY chatgpt deep-research truth: the report renders in the SAME conversation turn as the
// intro (turn numbers never advance — observed live on a completed research page), so no parent-DOM
// structure can tell "research running" from "research finished"; only the button inside the
// cross-origin card iframe can.
const drFrameButtonVisibleByTab = new Map();
// Conversations whose research WE recently completed (fast complete or backstop). A completed
// research page keeps its card iframe visible indefinitely, so a snapshot-side card arm would
// re-arm right after every completion and cycle arm→complete forever (observed live, ~4.5min
// period). Snapshot arms are suppressed during this cooldown; the port and sustained-network arms
// are exempt (real new-research evidence).
const drRecentlyCompletedByCid = new Map();
const DR_REARM_COOLDOWN_MS = 600000;
function drRecentlyCompleted(conversationId) {
  if (!conversationId) return false;
  const at = drRecentlyCompletedByCid.get(conversationId);
  if (!at) return false;
  if (Date.now() - at > DR_REARM_COOLDOWN_MS) { drRecentlyCompletedByCid.delete(conversationId); return false; }
  return true;
}

// Persisted set of tab ids with a generation IN FLIGHT (chrome.storage.session — survives an MV3
// worker restart, cleared on browser close). It exists so the worker stays alive THROUGH a turn even
// when the page makes no requests for a while: claude streams one long /completion with ~50s of no
// other traffic, which otherwise lets the worker idle out at ~30s and drop the in-memory generation
// state that handleClaudeStreamComplete needs — so the backgrounded turn never clears. Keeping the
// worker warm (syncKeepAlive consults this) means that state survives and the completion handler fires.
const GEN_INFLIGHT_KEY = 'chatWatchGenInFlight';
async function setGenInFlight(tabId, on) {
  if (!tabId) return;
  try {
    const cur = (await chrome.storage.session.get(GEN_INFLIGHT_KEY))[GEN_INFLIGHT_KEY] || {};
    if (on) cur[tabId] = 1; else delete cur[tabId];
    await chrome.storage.session.set({ [GEN_INFLIGHT_KEY]: cur });
  } catch (_) { /* session storage unavailable — keepalive falls back to debug/DR-armed only */ }
}
async function anyGenInFlight() {
  try {
    const cur = (await chrome.storage.session.get(GEN_INFLIGHT_KEY))[GEN_INFLIGHT_KEY] || {};
    return Object.keys(cur).length > 0;
  } catch (_) { return false; }
}
/** @type {Promise<{ apiBase: string, token: string } | null> | null} */
let credentialsInFlight = null;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let cachedCreds = null;

async function loadCredentials() {
  if (cachedCreds) return cachedCreds;
  if (credentialsInFlight) return credentialsInFlight;
  credentialsInFlight = (async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.apiBase, STORAGE_KEYS.token]);
    if (stored[STORAGE_KEYS.apiBase] && stored[STORAGE_KEYS.token]) {
      cachedCreds = { apiBase: stored[STORAGE_KEYS.apiBase], token: stored[STORAGE_KEYS.token] };
      return cachedCreds;
    }
    for (const port of DEFAULT_PORTS) {
      const base = `http://127.0.0.1:${port}`;
      try {
        const res = await fetchWithTimeout(`${base}/api/browser-chats/config`, CONFIG_FETCH_TIMEOUT_MS);
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.token) {
          const apiBase = (data.apiBase || base).replace(/\/$/, '');
          const creds = { apiBase, token: data.token };
          await chrome.storage.local.set({
            [STORAGE_KEYS.apiBase]: apiBase,
            [STORAGE_KEYS.token]: data.token,
          });
          cachedCreds = creds;
          return creds;
        }
      } catch (err) {
        // Keep failures visible in worker DevTools for debugging.
        console.debug('[chat-watch] config probe failed', base, err && err.name ? err.name : err);
        /* try next port */
      }
    }
    return null;
  })();
  try {
    return await credentialsInFlight;
  } finally {
    credentialsInFlight = null;
  }
}

async function postJson(apiBase, path, body, token) {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Browser-Chat-Token': token,
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.debug('[chat-watch] post failed', `${apiBase}${path}`, err && err.name ? err.name : err);
    return false;
  }
}

function conversationIdFromProviderUrl(provider, rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const path = url.pathname || '';
    if (provider === 'chatgpt') {
      const match = path.match(/\/c\/([^/?#]+)/i);
      return match ? match[1].toLowerCase() : '';
    }
    if (provider === 'claude') {
      const chatMatch = path.match(/\/chat\/([^/?#]+)/i);
      if (chatMatch) return chatMatch[1].toLowerCase();
      const apiMatch = path.match(/\/chat_conversations\/([^/]+)\/(?:completion|stop_response)/i);
      return apiMatch ? apiMatch[1].toLowerCase() : '';
    }
    if (provider === 'gemini') {
      const pathMatch = path.match(/\/app\/([^/?#]+)/i);
      if (pathMatch) return pathMatch[1].toLowerCase();
      const sourcePath = url.searchParams.get('source-path') || '';
      const sourceMatch = sourcePath.match(/\/app\/([^/?#]+)/i);
      return sourceMatch ? sourceMatch[1].toLowerCase() : '';
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

function isGeminiCancelRequestUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.hostname === 'gemini.google.com'
      && /\/BardChatUi\/data\/batchexecute$/i.test(url.pathname)
      && url.searchParams.get('rpcids') === 'NkpXw';
  } catch (_) {
    return false;
  }
}

async function conversationIdForCancel(provider, tabId, requestUrl) {
  const fromRequest = conversationIdFromProviderUrl(provider, requestUrl);
  if (fromRequest) return fromRequest;
  const state = tabGenerationState.get(tabId);
  if (state && state.lastConversationId) return state.lastConversationId;
  const tabInfo = await getTabInfo(tabId);
  return conversationIdFromProviderUrl(provider, tabInfo && tabInfo.url);
}

async function postBrowserChatCancel(provider, details) {
  if (!details || details.method !== 'POST') return;
  const tabId = details.tabId;
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const state = tabGenerationState.get(tabId);
  if (provider === 'gemini' && (!state || !state.lastGenerating)) return;
  const conversationId = await conversationIdForCancel(provider, tabId, details.url);
  if (!conversationId) return;

  if (state) {
    state.lastGenerating = false;
    if (!state.lastConversationId) state.lastConversationId = conversationId;
    tabGenerationState.set(tabId, state);
  }
  if (provider === 'chatgpt') clearChatgptDrBackstop(tabId);
  await setGenInFlight(tabId, false);
  syncKeepAlive().catch(() => {});

  const creds = await loadCredentials();
  if (!creds) return;
  await postJson(
    creds.apiBase,
    '/api/browser-chats/cancel',
    { provider, conversation_id: conversationId },
    creds.token
  );
}

chrome.runtime.onInstalled.addListener(() => {
  loadCredentials().catch(() => {});
  syncOpenTabsWithServer().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  loadCredentials().catch(() => {});
  syncKeepAlive().catch(() => {});
  syncOpenTabsWithServer().catch(() => {});
});

// Reconcile the server's browser-chat store with the tabs that actually exist. A provider tab
// closed while this MV3 worker was asleep never fires tabs.onRemoved here, so its /tab-closed
// post is lost and the server keeps a phantom "generating" item (and picker row) forever
// (findings §3.7). On worker start, send the full open provider-tab list; the server prunes the
// rest. Best-effort — a failure just leaves the stale item until the next worker start.
async function syncOpenTabsWithServer() {
  const creds = await loadCredentials();
  if (!creds) return;
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({
      url: [
        'https://chatgpt.com/*', 'https://chat.openai.com/*',
        'https://claude.ai/*', 'https://gemini.google.com/*',
      ],
    }, (list) => { try { void chrome.runtime.lastError; } catch (_) {} resolve(list || []); });
  });
  const tabIds = tabs.map((t) => t && t.id).filter((id) => Number.isInteger(id));
  await postJson(creds.apiBase, '/api/browser-chats/tabs-sync', { tab_ids: tabIds }, creds.token);
}

// ── Service-worker keepalive (MV3) ──────────────────────────────────────────
// An MV3 service worker is torn down after ~30s with no events. During a FOREGROUND generation the
// content script pushes DOM snapshots every ~700ms, which keeps the worker awake — but on a
// BACKGROUNDED tab the DOM observer goes quiet, the worker idles out at ~30s, and then it stops
// forwarding EVERYTHING: snapshots, stream signals, AND the webRequest probe-logs / completion edges
// that don't otherwise depend on the tab being visible. That silent worker death (not the page
// itself) is what makes a backgrounded run look like "the site stopped talking". While debug logging
// is on (capture/test mode) we keep the worker warm two ways: a 30s alarm (the external waker that
// revives a sleeping worker) plus a 20s self-ping (keeps it from reaching the idle threshold while
// already awake). Gated on the debug flag so a normal user's worker still sleeps when truly idle.
const KEEPALIVE_ALARM = 'chatwatch-keepalive';
let keepAliveTimer = null;

function pingKeepAlive() {
  // Any trivial async API call counts as worker activity and resets the idle timer.
  try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) { /* ignore */ }
}

// Is the TEST-ONLY auto-driver flag on? Read at module scope (the driver IIFE keeps its own copy) so
// the keepalive can stay warm during a driver wave even with NO provider tabs open. Without this the
// MV3 worker idles out at ~30s and the drive/open poll loops stop — so an AUTO-OPEN wave (which begins
// with zero tabs, hence no snapshot traffic to keep the worker awake) would hang forever waiting for
// the open queue to drain.
function isDriverFlagOn() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['taskAppChatWatchDriver'], (stored) => {
        try { void chrome.runtime.lastError; } catch (_) {}
        resolve(!!(stored && stored.taskAppChatWatchDriver));
      });
    } catch (_) { resolve(false); }
  });
}

async function syncKeepAlive() {
  // Keep the worker warm while ANY of: debug logging on (capture/test mode), a deep-research
  // quiescence backstop armed (so its quiet-window check fires in production with debug off), the
  // auto-driver flag on (so a driver wave's poll loops survive even before any tab exists), OR a
  // generation is in flight (so a quiet streaming turn — e.g. claude — can't idle the worker out and
  // drop the state its completion handler needs).
  const on = (await isDebugLoggingEnabled()) || anyDrBackstopArmed() || (await isDriverFlagOn()) || (await anyGenInFlight());
  if (on) {
    try { await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch (_) { /* ignore */ }
    if (keepAliveTimer == null) keepAliveTimer = setInterval(pingKeepAlive, 20000);
  } else {
    try { await chrome.alarms.clear(KEEPALIVE_ALARM); } catch (_) { /* ignore */ }
    if (keepAliveTimer != null) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Re-arm the self-ping (a torn-down worker loses its setInterval) and verify the flag is still on.
  if (keepAliveTimer == null) keepAliveTimer = setInterval(pingKeepAlive, 20000);
  pingKeepAlive();
  // The DR backstop's quiet-window check rides on this alarm (the only timer guaranteed to fire after
  // the worker has been idle through the research's quiet tail).
  checkChatgptDrQuiescence().catch(() => {});
  syncKeepAlive().catch(() => {});
});

// React to the debug or driver flag flipping at runtime so keepalive turns on/off without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.taskAppChatWatchDebug || changes.taskAppChatWatchDriver)) {
    syncKeepAlive().catch(() => {});
  }
});

syncKeepAlive().catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabGenerationState.delete(tabId);
  drBackstopByTab.delete(tabId);
  drFrameButtonVisibleByTab.delete(tabId);
  setGenInFlight(tabId, false).then(() => syncKeepAlive().catch(() => {})).catch(() => {});
  chrome.storage.local.get([STORAGE_KEYS.apiBase, STORAGE_KEYS.token]).then(async (stored) => {
    const apiBase = stored[STORAGE_KEYS.apiBase];
    const token = stored[STORAGE_KEYS.token];
    if (!apiBase || !token) return;
    try {
      await fetch(`${apiBase}/api/browser-chats/tab-closed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Browser-Chat-Token': token,
        },
        body: JSON.stringify({ tab_id: tabId }),
      });
    } catch {
      /* ignore */
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'no tab' });
    return false;
  }

  if (message.type === 'PAGE_CONSOLE_LOG') {
    (async () => {
      if (!(await isDebugLoggingEnabled())) {
        sendResponse({ ok: true });
        return;
      }
      const creds = await loadCredentials();
      if (!creds) {
        sendResponse({ ok: false, error: 'Orchestra not reachable' });
        return;
      }
      const payload = message.payload || {};
      const tabInfo = await getTabInfo(tabId);
      await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
        type: 'console',
        method: payload.method,
        text: payload.text,
        timestamp: payload.timestamp,
        tabId: tabId,
        tabTitle: tabInfo.title || '',
        tabUrl: tabInfo.url || ''
      }, creds.token);
      sendResponse({ ok: true });
    })();
    return true; // async response
  }

  // Relayed deep-research frame state (v0.5.15): the sandboxed card iframe cannot reliably use
  // runtime APIs itself (live-confirmed: a direct port never delivered), so content-dr-frame.js
  // posts to the parent page and content-chatgpt.js forwards here. Same handler as the direct
  // port path — both may deliver, the handler is idempotent.
  if (message.type === 'DR_FRAME_STATE') {
    handleDrFrameState(tabId, message.payload || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== 'CHAT_UPDATE') {
    return false;
  }

  (async () => {
    const creds = await loadCredentials();
    if (!creds) {
      sendResponse({ ok: false, error: 'Orchestra not reachable' });
      return;
    }
    const p = message.payload || {};
    const provider = p.provider;
    if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
      sendResponse({ ok: false, error: 'unknown provider' });
      return;
    }

    const conversation_id = typeof p.conversation_id === 'string' ? p.conversation_id.trim().toLowerCase() : '';
    // extension_version lets the wave's preflight warn when the LOADED extension is
    // stale vs the repo manifest (reload it at chrome://extensions). Read from the
    // loaded manifest, not hardcoded, so it always reflects what's actually running.
    let extensionVersion = '';
    try { extensionVersion = (chrome.runtime.getManifest() || {}).version || ''; } catch (_) { extensionVersion = ''; }
    const snapshotBody = {
      tab_id: tabId,
      provider,
      conversation_id,
      extension_version: extensionVersion,
      url: typeof p.url === 'string' ? p.url : '',
      title: typeof p.title === 'string' ? p.title : '',
      last_user_preview: typeof p.last_user_preview === 'string' ? p.last_user_preview : '',
      generating: !!p.generating,
      completion_signal: !!p.completion_signal,
      failure_signal: !!p.failure_signal,
      failure_reason: typeof p.failure_reason === 'string' ? p.failure_reason : '',
      activity_summary: typeof p.activity_summary === 'string' ? p.activity_summary : '',
      // Structural turn anchors for the chatgpt deep-research completion gate (ints or null).
      latest_turn: Number.isInteger(p.latest_turn) && p.latest_turn >= 0 ? p.latest_turn : null,
      completion_turn: Number.isInteger(p.completion_turn) && p.completion_turn >= 0 ? p.completion_turn : null,
      // Deep research in flight (v0.5.10): the in-frame observer's live Stop-research button is the
      // PRIMARY truth (the parent DOM cannot distinguish a running research from a finished one —
      // the report renders into the SAME conversation turn and the card iframe persists after
      // completion). The parent-DOM card mount (live-mount + turn gated, cooldown-guarded below)
      // remains a secondary arm for the research's opening seconds, before the frame port connects.
      deep_research_active: drFrameButtonVisibleByTab.get(tabId) === true
        || (!!p.deep_research_active && !drRecentlyCompleted(conversation_id)),
      // Raw (ungated) card-iframe visibility — observability only.
      dr_card_visible: !!p.dr_card_visible,
      // Whether the parent page has received any relayed message from the in-frame observer on
      // this page (v0.5.15 diagnostic: separates "frame script never injected" from "buttons not
      // matched" when the port/relay goes quiet).
      dr_frame_seen: !!p.dr_frame_seen,
    };
    // A visible Stop-research button means the tab is working even though the parent DOM reads
    // idle (the DR-mode UI shows no stop button outside the sandboxed card iframe).
    if (snapshotBody.deep_research_active) snapshotBody.generating = true;

    let snapOk = await postJson(creds.apiBase, '/api/browser-chats/snapshot', snapshotBody, creds.token);
    if (!snapOk) {
      cachedCreds = null;
      await chrome.storage.local.remove([STORAGE_KEYS.apiBase, STORAGE_KEYS.token]);
      const freshCreds = await loadCredentials();
      if (!freshCreds) {
        sendResponse({ ok: false, error: 'snapshot rejected' });
        return;
      }
      snapOk = await postJson(freshCreds.apiBase, '/api/browser-chats/snapshot', snapshotBody, freshCreds.token);
      if (!snapOk) {
        sendResponse({ ok: false, error: 'snapshot rejected' });
        return;
      }
      creds.apiBase = freshCreds.apiBase;
      creds.token = freshCreds.token;
    }

    let prev = tabGenerationState.get(tabId) || { lastGenerating: false, lastConversationId: '' };
    const convChanged =
      conversation_id &&
      prev.lastConversationId &&
      conversation_id !== prev.lastConversationId;
    if (convChanged) {
      prev = { lastGenerating: false, lastConversationId: conversation_id };
    } else if (conversation_id) {
      prev = { ...prev, lastConversationId: conversation_id };
    }
    const gen = !!p.generating || snapshotBody.deep_research_active;
    const failed = !!p.failure_signal;
    const completionSignal = !!p.completion_signal;
    // chatgpt deep research (armed backstop entry): the intro/ack turn grows response actions that
    // raise FALSE completion_signal all through the research — and this handler's /complete post
    // (plus its backstop disarm) would false-clear on it. The report renders into the SAME
    // conversation turn (turn numbers never advance — v0.5.10 finding), so NO DOM shape can release
    // the hold: while armed, everything but a failure is held, and done arrives exclusively via
    // completeChatgptDrNow (the post-end fast complete on the report-render burst, or the 240s
    // quiescence backstop).
    let drHold = false;
    if (provider === 'chatgpt') {
      // Arm from the composed deep_research_active (port button, or the gated card mount): engages
      // the hold from the FIRST snapshot, without needing to win the first-call_mcp race.
      if (snapshotBody.deep_research_active) {
        const entry = getDrEntry(tabId, conversation_id);
        entry.armed = true;
        entry.corroborated = true; // debounced heuristic or button seen in-frame — real evidence
        entry.lastActivityMs = Date.now();
        drBackstopByTab.set(tabId, entry);
        syncKeepAlive().catch(() => {});
        if (conversation_id && entry.inFlightPostedFor !== conversation_id) {
          entry.inFlightPostedFor = conversation_id;
          postChatgptDrInFlightSignal(tabId, conversation_id).catch(() => {});
        }
      }
      const drEntry = drBackstopByTab.get(tabId);
      if (drEntry && drEntry.armed) {
        if (drEntry.baselineTurn == null && Number.isInteger(p.latest_turn) && p.latest_turn >= 0) {
          drEntry.baselineTurn = p.latest_turn; // diagnostic anchor (kept for recordings/replay)
        }
        if (!failed) {
          drHold = true; // research armed: neither the intro completion nor a bare gen flicker may clear
        }
      }
    }
    const shouldNotifyComplete =
      !drHold &&
      !!conversation_id &&
      (failed || completionSignal ||
        // Bare falling edge: HELD while the research-card iframe is on the page (v0.5.15). The DR
        // intro ends with a gen falling edge ~5s in, BEFORE any arm can engage (observed live: the
        // card mounts just ahead of the edge) — completing on it false-cleared the watch at the
        // countdown. Real dones on card-bearing pages still clear via completion_signal (follow-up
        // turns grow response actions), and completed-page loads have no falling edge at all.
        (prev.lastGenerating && !gen && !(provider === 'chatgpt' && p.dr_card_visible)));
    if (shouldNotifyComplete) {
      clearChatgptDrBackstop(tabId); // the DOM path cleared it — don't let the backstop re-fire later
      await postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider, conversation_id },
        creds.token
      );
    }
    tabGenerationState.set(tabId, { lastGenerating: gen, lastConversationId: prev.lastConversationId || conversation_id });
    // Keepalive: hold the worker through the turn while generating; release it once the turn is done.
    if (gen && !prev.lastGenerating) { await setGenInFlight(tabId, true); syncKeepAlive().catch(() => {}); }
    else if (!gen && (prev.lastGenerating || shouldNotifyComplete)) { await setGenInFlight(tabId, false); syncKeepAlive().catch(() => {}); }
    sendResponse({ ok: true });
  })();

  return true;
});

// Web request monitoring to detect Gemini background generation completion
const geminiFilter = { urls: ["https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate*"] };

async function handleGeminiStreamComplete(details) {
  const tabId = details.tabId;
  if (!tabId) return;

  const state = tabGenerationState.get(tabId);
  if (!state || !state.lastGenerating) {
    return;
  }

  // Set state to not generating immediately to avoid duplicate notifications
  state.lastGenerating = false;
  tabGenerationState.set(tabId, state);
  setGenInFlight(tabId, false); syncKeepAlive().catch(() => {}); // turn done — release the keepalive hold

  const creds = await loadCredentials();
  if (!creds) return;

  // Retrieve the tab to parse conversation_id from its URL
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) {
      // Fallback to last known conversation ID from state
      if (state.lastConversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'gemini', conversation_id: state.lastConversationId },
          creds.token
        );
      }
      return;
    }

    try {
      const url = new URL(tab.url);
      const match = url.pathname.match(/\/app\/([^/?#]+)/i);
      const conversationId = match ? match[1].toLowerCase() : state.lastConversationId;
      if (conversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'gemini', conversation_id: conversationId },
          creds.token
        );
      }
    } catch (_) {
      if (state.lastConversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'gemini', conversation_id: state.lastConversationId },
          creds.token
        );
      }
    }
  });
}

chrome.webRequest.onCompleted.addListener(handleGeminiStreamComplete, geminiFilter);
chrome.webRequest.onErrorOccurred.addListener(handleGeminiStreamComplete, geminiFilter);

// Web request monitoring to detect Claude background generation completion
const claudeFilter = { urls: ["https://claude.ai/api/organizations/*/chat_conversations/*/completion*"] };

async function handleClaudeStreamComplete(details) {
  const tabId = details.tabId;
  if (!tabId) return;

  const state = tabGenerationState.get(tabId);
  if (!state || !state.lastGenerating) {
    return;
  }

  // Set state to not generating immediately to avoid duplicate notifications
  state.lastGenerating = false;
  tabGenerationState.set(tabId, state);
  setGenInFlight(tabId, false); syncKeepAlive().catch(() => {}); // turn done — release the keepalive hold

  const creds = await loadCredentials();
  if (!creds) return;

  // Extract conversation ID from request URL
  try {
    const urlStr = details.url || '';
    const match = urlStr.match(/https:\/\/claude\.ai\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/completion/i);
    const conversationId = match ? match[1].toLowerCase() : state.lastConversationId;
    if (conversationId) {
      postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider: 'claude', conversation_id: conversationId },
        creds.token
      );
    }
  } catch (err) {
    console.debug('[chat-watch] failed to parse Claude completion URL', err);
    if (state.lastConversationId) {
      postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider: 'claude', conversation_id: state.lastConversationId },
        creds.token
      );
    }
  }
}

chrome.webRequest.onCompleted.addListener(handleClaudeStreamComplete, claudeFilter);
chrome.webRequest.onErrorOccurred.addListener(handleClaudeStreamComplete, claudeFilter);

// Claude deep-research detection. A DR turn polls a task-status endpoint; the FIRST such request
// fires ~0.7s before any status body and before the initial-ack DOM flicker (a bare generating:false
// that would otherwise false-complete the watch). Flag "deep-research in flight" on that first
// request so the server suppresses the flicker (see lib/browser_chat.js shouldCompleteBrowserChatWatch).
// We emit a synthetic, non-terminal `task_status:active` stream signal — the same channel the body
// sniffer uses — and dedupe to one per tab (re-armed when the task completes).
const claudeTaskStatusFilter = { urls: ["https://claude.ai/api/organizations/*/chat_conversations/*/task/wf-*/status*"] };
const CLAUDE_TASK_STATUS_URL_RE = /\/chat_conversations\/([^/]+)\/task\/wf-[^/]+\/status/i;
const claudeDeepResearchFlaggedTabs = new Set();

async function handleClaudeTaskStatusRequest(details) {
  const tabId = details.tabId;
  if (!tabId || claudeDeepResearchFlaggedTabs.has(tabId)) return;
  const match = String(details.url || '').match(CLAUDE_TASK_STATUS_URL_RE);
  const conversationId = match ? match[1].toLowerCase() : '';
  if (!conversationId) return;
  claudeDeepResearchFlaggedTabs.add(tabId);
  const creds = await loadCredentials();
  if (!creds) return;
  postJson(
    creds.apiBase,
    '/api/browser-chats/stream-signal',
    { tab_id: tabId, provider: 'claude', conversation_id: conversationId,
      marker: 'task_status:active', endpoint: 'chat_conversations/task_status', method: 'GET' },
    creds.token
  );
}

chrome.webRequest.onBeforeRequest.addListener(handleClaudeTaskStatusRequest, claudeTaskStatusFilter);

// ── ChatGPT deep-research quiescence backstop ───────────────────────────────
// ChatGPT deep-research has NO terminal "done" request: the research runs as a loop of
// `ecosystem/call_mcp` tool calls + `f/conversation` streams, then simply stops. Foreground (and a
// backgrounded tab whose DOM stays live) the completion_signal snapshot clears the watch — but if the
// tab's DOM is throttled while hidden there is no done signal at all. This backstop watches the
// research's own NETWORK activity (which `chrome.webRequest` sees regardless of tab focus, as long as
// the worker is alive — see the keepalive) and, once it has been QUIET for DR_QUIESCENCE_MS, posts
// /complete. It is purely additive: /complete is idempotent, so when the DOM path already cleared the
// task this is a no-op; it only rescues the throttled-DOM case. `call_mcp` is the arm signal (it fires
// on deep-research turns only — 0 on a standard chat). The quiet window must exceed the largest
// mid-research "thinking" gap (~73s observed) so a pause isn't mistaken for done; 120s leaves margin.
const chatgptResearchFilter = {
  urls: [
    // The research's own work: tool calls + the streaming reply. NOT the `/conversation/{id}` fetch or
    // `/conversations` list (housekeeping) — those would wrongly keep resetting the quiet window.
    "https://chatgpt.com/backend-api/ecosystem/call_mcp*",
    "https://chatgpt.com/backend-api/f/conversation*",
    "https://chat.openai.com/backend-api/ecosystem/call_mcp*",
    "https://chat.openai.com/backend-api/f/conversation*",
  ],
};
// Must exceed BOTH the largest mid-research thinking gap (~73s observed) AND the silent
// report-writing gap after the LAST call_mcp (the model writes the final report over a channel
// webRequest cannot see; ~140s observed between the last call_mcp and the DOM completion
// snapshot). At 120s the backstop fired mid-writing — marking the research done ~20s+ before the
// report actually landed, and ahead of the accurate DOM clear on a visible tab. 240s lets the DOM
// path win whenever the tab is visible; a hidden tab clears late-but-correct.
const DR_QUIESCENCE_MS = 240000;

function isChatgptDeepResearchArm(url) {
  // call_mcp fires only on deep-research turns (a standard chat makes none).
  return /\/backend-api\/ecosystem\/call_mcp/i.test(String(url || ''));
}

// Evidence gate (v0.5.9): isolated `call_mcp` requests occur on IDLE deep-research conversation
// tabs (observed live 2026-07-03: one lone burst every ~15min on a hidden idle tab — each armed
// the backstop and produced a spurious task_completed + /complete cycle 240s later). A lone burst
// must therefore never complete anything. Research evidence counts as real when it is either
//   - CORROBORATED: the parent DOM saw the research card (deep_research_active snapshot) or the
//     in-frame observer saw the Stop-research button (port) — set on those arms; or
//   - SUSTAINED: enough research-endpoint events over enough time. A real research is chatty
//     (dozens of call_mcp + stream completions over minutes); an idle keepalive is 1-3 requests
//     in a couple of seconds.
// An entry lacking both silently disarms after the quiet window (no task_completed, no /complete),
// and its in-flight `task_status:active` post is deferred until the gate passes (the card arm
// covers the research's opening seconds, where the false clears live).
const DR_EVIDENCE_MIN_EVENTS = 3;
const DR_EVIDENCE_MIN_SPAN_MS = 15000;
// Bursts separated by more than this are separate evidence windows (idle DR pages emit lone
// call_mcp bursts ~15min apart; a page load fires one or two).
const DR_BURST_RESET_GAP_MS = 60000;

function drEvidenceQualifies(entry) {
  if (!entry) return false;
  if (entry.corroborated || entry.evidenceLatched) return true;
  const span = (entry.lastActivityMs || 0) - (entry.firstActivityMs || entry.lastActivityMs || 0);
  return (entry.eventCount || 0) >= DR_EVIDENCE_MIN_EVENTS && span >= DR_EVIDENCE_MIN_SPAN_MS;
}

// Fetch (or refresh) a tab's backstop entry with EVIDENCE ISOLATION (v0.5.13): counters must never
// accumulate across conversations or across well-separated bursts. Observed live: flipping through
// five completed research pages summed each load's lone call_mcp into one tab-level counter until
// "sustained" passed and every subsequent page-open posted a spurious arm. A conversation change
// discards the entry outright; a >60s quiet gap resets the counting window (the latch below
// preserves a mid-research qualification across genuine thinking gaps, which run up to ~107s).
function getDrEntry(tabId, conversationId) {
  let entry = drBackstopByTab.get(tabId) || null;
  if (entry && conversationId && entry.conversationId && entry.conversationId !== conversationId) {
    entry = null; // SPA-navigated to a different conversation — old evidence does not transfer
  }
  if (entry && !entry.corroborated && !entry.evidenceLatched
      && entry.lastActivityMs && Date.now() - entry.lastActivityMs > DR_BURST_RESET_GAP_MS) {
    entry.eventCount = 0;
    entry.firstActivityMs = 0;
  }
  if (!entry) entry = { lastActivityMs: 0, conversationId: '', armed: false };
  if (conversationId && !entry.conversationId) entry.conversationId = conversationId;
  return entry;
}

function noteChatgptResearchActivity(details) {
  const tabId = details.tabId;
  if (!tabId || details.method === 'OPTIONS') return;
  const arm = isChatgptDeepResearchArm(details.url);
  if (!arm && !drBackstopByTab.has(tabId)) return;
  // A plain f/conversation completion with no DR turn in progress is a STANDARD chat — ignore it so we
  // never arm (or even allocate) for non-deep-research. Only `call_mcp` starts a DR turn.
  const state = tabGenerationState.get(tabId);
  const priorEntry = drBackstopByTab.get(tabId);
  const conversationId = (state && state.lastConversationId) || (priorEntry && priorEntry.conversationId) || '';
  // Missing mapping (worker restarted mid-research): recover from the tab URL in the background —
  // the research loop is chatty, so the next event finds it populated (v0.5.18).
  if (!conversationId) resolveTabConversationId(tabId).catch(() => {});
  const entry = getDrEntry(tabId, conversationId);
  if (!arm && !entry.armed && !entry.eventCount) {
    drBackstopByTab.delete(tabId); // cid-change discarded the old entry and this event can't start one
    return;
  }
  entry.lastActivityMs = Date.now(); // any research activity resets the quiet window
  if (!entry.firstActivityMs) entry.firstActivityMs = entry.lastActivityMs;
  entry.eventCount = (entry.eventCount || 0) + 1;
  if (arm) entry.armed = true;
  // Latch a within-window qualification so a genuine research's long thinking gaps (up to ~107s
  // observed) can't un-qualify it before the quiet-window completion check runs.
  if (drEvidenceQualifies(entry)) entry.evidenceLatched = true;
  drBackstopByTab.set(tabId, entry);
  if (entry.armed) syncKeepAlive().catch(() => {}); // keep the worker warm through the quiet window
  // Post-end fast complete (v0.5.7): the in-frame observer saw the research UI end
  // (entry.researchEndedMs); the next research-endpoint COMPLETION after a short guard is the
  // report-render burst (observed: the final call_mcp burst lands ~1s before the report's DOM
  // completion snapshot). Complete on it — idempotent with the DOM turn-gate path, and minutes
  // ahead of the 240s quiescence backstop for a HIDDEN tab. `statusCode != null` gates to
  // onCompleted events (the onBeforeRequest arm listener carries none). The guard skips the
  // frame-teardown's own trailing requests, so a canceled research's teardown can't read as the
  // report; a cancel also deletes the entry via the stop_conversation → /cancel path.
  const POST_END_BURST_GUARD_MS = 5000;
  if (entry.armed && entry.researchEndedMs
      && details.statusCode != null
      && Date.now() - entry.researchEndedMs > POST_END_BURST_GUARD_MS) {
    completeChatgptDrNow(tabId, entry).catch(() => {});
  }
  // Evidence-gated in-flight post → tell the server the research is IN FLIGHT (findings §3.6).
  // `task_status:active` is the same structural marker claude's task-status poll produces; the
  // store suppresses bare generating:false + completion clears while it is set (lib/browser_chat.js
  // shouldCompleteBrowserChatWatch). Deferred until the evidence gate passes so an idle tab's lone
  // call_mcp burst never marks a conversation in-flight; the card/port arms (corroborated) post
  // their own signal and cover the research's opening seconds.
  if (entry.armed && conversationId && drEvidenceQualifies(entry) && entry.inFlightPostedFor !== conversationId) {
    entry.inFlightPostedFor = conversationId;
    postChatgptDrInFlightSignal(tabId, conversationId).catch(() => {});
  }
}

async function postChatgptDrInFlightSignal(tabId, conversationId) {
  const creds = await loadCredentials();
  if (!creds) return;
  await postJson(creds.apiBase, '/api/browser-chats/stream-signal', {
    tab_id: tabId,
    provider: 'chatgpt',
    conversation_id: conversationId,
    turn_id: '',
    marker: 'task_status:active',
    endpoint: 'ecosystem/call_mcp',
    method: 'POST',
    t: Date.now(),
  }, creds.token);
}

chrome.webRequest.onCompleted.addListener(noteChatgptResearchActivity, chatgptResearchFilter);
// ALSO arm on request START for call_mcp: the first call_mcp can run for seconds, and the false
// early clear it must suppress happens within ~5s of research start — onCompleted alone can lose
// that race (findings §3.6). f/conversation stays onCompleted-only (its completion is the signal).
chrome.webRequest.onBeforeRequest.addListener(noteChatgptResearchActivity, {
  urls: [
    "https://chatgpt.com/backend-api/ecosystem/call_mcp*",
    "https://chat.openai.com/backend-api/ecosystem/call_mcp*",
  ],
});

// Complete a chatgpt deep research NOW: disarm, then post the task_completed edge FIRST (drops the
// server's DR in-flight flag — which holds DOM completion clears for chatgpt, see
// lib/browser_chat.js — and records the done edge for replay, mirroring claude), then /complete
// (idempotent with the DOM path that unblocks once the flag is down). Shared by the quiescence
// backstop and the post-end fast complete.
async function completeChatgptDrNow(tabId, entry) {
  drBackstopByTab.delete(tabId);
  const conversationId = (entry && entry.conversationId) || (await resolveTabConversationId(tabId));
  if (!conversationId) return;
  const state = tabGenerationState.get(tabId);
  // The completed page keeps its card iframe visible — suppress snapshot-side re-arms for this
  // conversation so the completion can't cycle arm→complete (port/network arms stay exempt).
  drRecentlyCompletedByCid.set(conversationId, Date.now());
  if (state) { state.lastGenerating = false; tabGenerationState.set(tabId, state); }
  const creds = await loadCredentials();
  if (!creds) return;
  await postJson(creds.apiBase, '/api/browser-chats/stream-signal', {
    tab_id: tabId,
    provider: 'chatgpt',
    conversation_id: conversationId,
    turn_id: '',
    marker: 'task_completed',
    endpoint: 'ecosystem/call_mcp',
    method: 'POST',
    t: Date.now(),
  }, creds.token);
  await postJson(creds.apiBase, '/api/browser-chats/complete', { provider: 'chatgpt', conversation_id: conversationId }, creds.token);
  syncKeepAlive().catch(() => {}); // may now be able to let the worker sleep again
}

// Fire /complete for any armed deep-research tab whose research activity has been quiet long enough.
// Called from the keepalive alarm (so it runs even when the worker would otherwise have idled).
async function checkChatgptDrQuiescence() {
  const now = Date.now();
  for (const [tabId, entry] of [...drBackstopByTab.entries()]) {
    if (!entry.armed) continue;
    if (now - entry.lastActivityMs < DR_QUIESCENCE_MS) continue;
    // Evidence gate: an idle tab's lone call_mcp burst arms an entry but must not complete anything
    // when it goes quiet — silently disarm instead (no task_completed, no /complete). See
    // drEvidenceQualifies.
    if (!drEvidenceQualifies(entry)) {
      drBackstopByTab.delete(tabId);
      continue;
    }
    // Freeze guard (v0.5.18): Chrome freezes/discards long-hidden tabs — a frozen page makes NO
    // client requests, so its silence is NOT research quiescence. Keep the entry armed and wait;
    // on thaw the frame observer's ended edge (or genuine post-thaw quiet) finishes the job.
    const tab = await new Promise((resolve) => {
      chrome.tabs.get(tabId, (t) => { try { void chrome.runtime.lastError; } catch (_) {} resolve(t || null); });
    });
    if (tab && (tab.discarded || tab.frozen)) continue;
    await completeChatgptDrNow(tabId, entry);
  }
  syncKeepAlive().catch(() => {}); // may now be able to let the worker sleep again
}

// ── Deep-research frame port (v0.5.7) ───────────────────────────────────────
// content-dr-frame.js runs INSIDE the cross-origin research-card iframe (the parent page cannot
// see into it) and relays the "Stop research" button's visibility over this port — the only live
// research-running/ended signal ChatGPT exposes. Visibility works like a heartbeat (arms the
// backstop + resets its quiet window); the button-GONE edge (or the frame tearing down) marks the
// research UI ended, which never completes by itself — the report may still be writing on an
// invisible channel — but enables the post-end fast complete in noteChatgptResearchActivity.
chrome.runtime.onConnect.addListener((framePort) => {
  if (!framePort || framePort.name !== 'chat-watch-dr-frame') return;
  const senderTab = framePort.sender && framePort.sender.tab;
  const tabId = senderTab && Number.isInteger(senderTab.id) ? senderTab.id : null;
  if (tabId == null) { try { framePort.disconnect(); } catch (_) {} return; }
  framePort.onMessage.addListener((msg) => handleDrFrameState(tabId, msg));
  framePort.onDisconnect.addListener(() => handleDrFrameGone(tabId));
});

// Diagnostic: last boot beacon per tab — proves the in-frame script injected at all.
const drFrameBootByTab = new Map();

// Recover a tab's conversation id from its URL when the in-memory mapping is missing. An MV3
// worker restart wipes tabGenerationState, and a hidden tab posts no snapshots to rebuild it —
// live-observed (v0.5.18): an entire backgrounded research ran end-to-end with EVERY signal path
// muted by empty-cid guards. chrome.tabs.get works regardless of visibility or freeze.
async function resolveTabConversationId(tabId) {
  const state = tabGenerationState.get(tabId);
  if (state && state.lastConversationId) return state.lastConversationId;
  const tab = await new Promise((resolve) => {
    chrome.tabs.get(tabId, (t) => { try { void chrome.runtime.lastError; } catch (_) {} resolve(t || null); });
  });
  const m = String((tab && tab.url) || '').match(/\/c\/([0-9a-f][0-9a-f-]*)/i);
  const cid = m ? m[1].toLowerCase() : '';
  if (cid) tabGenerationState.set(tabId, { ...(state || { lastGenerating: false }), lastConversationId: cid });
  return cid;
}

// Shared handler for deep-research frame state, whether it arrives over the direct port or the
// parent-page postMessage relay (both may deliver the same state — every branch is idempotent).
// Async: resolves the conversation id from the tab URL first, so a worker-restart can't mute the
// signal paths (see resolveTabConversationId).
async function handleDrFrameState(tabId, msg) {
  if (!msg) return;
  if (msg.event === 'dr_frame_boot') {
    drFrameBootByTab.set(tabId, { t: Date.now(), buttons: msg.buttons | 0 });
    return;
  }
  // The user clicked "Stop research" inside the frame (v0.5.17). Remember it: the ended edge that
  // follows is a CANCEL, not a done — a clicked stop and a natural finish are otherwise
  // indistinguishable (both end with the button vanishing + trailing tool-call completions, and a
  // stop's drain passed the burst guard as a false done, live-confirmed).
  if (msg.event === 'dr_frame_stop_click') {
    const cid = await resolveTabConversationId(tabId);
    const entry = getDrEntry(tabId, cid);
    entry.stopClickedMs = Date.now();
    drBackstopByTab.set(tabId, entry);
    return;
  }
  if (msg.event !== 'dr_frame_state') return;
  {
    const entry = getDrEntry(tabId, await resolveTabConversationId(tabId));
    // PENDING (v0.5.14): the post-send countdown card (Start button, ~60s timer). It auto-starts
    // when the timer expires, so the correct state is WORKING even before the research runs — and
    // even with the tab backgrounded. Pending arms exactly like running; only the running phase
    // sets researchUiActive (the ended-edge/fast-complete semantics belong to the Stop button).
    const pending = !!msg.start_visible && !msg.stop_visible;
    if (msg.stop_visible || pending) {
      drFrameButtonVisibleByTab.set(tabId, true);
      entry.armed = true;
      entry.corroborated = true; // the in-frame observer sees a phase button — real research
      if (msg.stop_visible) {
        entry.researchUiActive = true;
        entry.researchPending = false;
        // A stop click that didn't take (button still alive seconds later) is stale — forget it.
        if (entry.stopClickedMs && Date.now() - entry.stopClickedMs > 3000) entry.stopClickedMs = 0;
      } else {
        entry.researchPending = true;
      }
      entry.researchEndedMs = 0; // (re)pending/running — clears a stale end edge
      entry.lastActivityMs = Date.now();
      drBackstopByTab.set(tabId, entry);
      syncKeepAlive().catch(() => {});
      if (entry.conversationId && entry.inFlightPostedFor !== entry.conversationId) {
        entry.inFlightPostedFor = entry.conversationId;
        postChatgptDrInFlightSignal(tabId, entry.conversationId).catch(() => {});
      }
    } else if (entry.researchUiActive && !entry.researchEndedMs) {
      drFrameButtonVisibleByTab.set(tabId, false);
      // Ended edge after a recent stop CLICK = user cancel: post /cancel and retire the entry so
      // neither the fast complete nor the backstop can mark the canceled research done.
      if (entry.stopClickedMs && Date.now() - entry.stopClickedMs < 30000) {
        drBackstopByTab.delete(tabId);
        if (entry.conversationId) drRecentlyCompletedByCid.set(entry.conversationId, Date.now());
        postChatgptDrEndedSignal(tabId, entry.conversationId).catch(() => {});
        postChatgptDrCancel(tabId, entry.conversationId).catch(() => {});
        return;
      }
      entry.researchEndedMs = Date.now();
      drBackstopByTab.set(tabId, entry);
      postChatgptDrEndedSignal(tabId, entry.conversationId).catch(() => {});
    } else {
      // Both buttons gone without a prior running phase: either the start→stop transition flash
      // (research about to begin — keep the entry, the stop report follows) or an idle frame.
      drFrameButtonVisibleByTab.set(tabId, false);
    }
    // COMPLETED marker (v0.5.19): the inner frame's body flipped to "Research completed …" — the
    // report has fully landed. This is the fast done for a HIDDEN tab (no render burst, no DOM
    // snapshot there; previously only the 240s backstop). Guarded three ways: the frame must have
    // been observed RUNNING in this session (a finished research's page shows the marker from
    // first paint — its frame never phase-activates, and even if it did, researchUiActive is
    // false), a recent stop click wins (the cancel path above already retired the entry), and
    // completeChatgptDrNow is idempotent with the burst/backstop paths.
    if (msg.completed_visible && !msg.stop_visible) {
      const doneEntry = drBackstopByTab.get(tabId);
      if (doneEntry && doneEntry.armed && doneEntry.researchUiActive
          && !(doneEntry.stopClickedMs && Date.now() - doneEntry.stopClickedMs < 30000)) {
        completeChatgptDrNow(tabId, doneEntry).catch(() => {});
      }
    }
  }
}

// User-canceled research (Stop click + ended edge): clear the watch as CANCELLED. The /cancel
// endpoint also drops the server's deep-research in-flight hold.
async function postChatgptDrCancel(tabId, conversationId) {
  if (!conversationId) return;
  const state = tabGenerationState.get(tabId);
  if (state) { state.lastGenerating = false; tabGenerationState.set(tabId, state); }
  await setGenInFlight(tabId, false);
  syncKeepAlive().catch(() => {});
  const creds = await loadCredentials();
  if (!creds) return;
  await postJson(creds.apiBase, '/api/browser-chats/cancel', { provider: 'chatgpt', conversation_id: conversationId }, creds.token);
}

// The frame is gone (port disconnect, or the relay's pagehide). Running → the ended edge;
// pending-only → the countdown was dismissed before any research ran, disarm silently.
function handleDrFrameGone(tabId) {
  drFrameButtonVisibleByTab.set(tabId, false);
  const entry = drBackstopByTab.get(tabId);
  if (entry && entry.researchUiActive && !entry.researchEndedMs) {
    // Teardown right after a stop CLICK is the cancel materializing (same rule as the ended edge).
    if (entry.stopClickedMs && Date.now() - entry.stopClickedMs < 30000) {
      drBackstopByTab.delete(tabId);
      if (entry.conversationId) drRecentlyCompletedByCid.set(entry.conversationId, Date.now());
      postChatgptDrEndedSignal(tabId, entry.conversationId).catch(() => {});
      postChatgptDrCancel(tabId, entry.conversationId).catch(() => {});
      return;
    }
    entry.researchEndedMs = Date.now(); // frame torn down = research UI gone
    drBackstopByTab.set(tabId, entry);
    postChatgptDrEndedSignal(tabId, entry.conversationId).catch(() => {});
  } else if (entry && entry.researchPending && !entry.researchUiActive) {
    // Countdown card torn down before the research ever started (user navigated away or
    // dismissed it): nothing will run and nothing should complete — disarm silently so the
    // backstop can't mark a never-run research as done.
    drBackstopByTab.delete(tabId);
  }
}

// The research-UI-ended edge (Stop-research button gone / frame torn down), as a server-visible
// stream signal. NEUTRAL on the server (never arms or drops the in-flight hold — the report may
// still be writing): it exists for observability and replay mining, and as direct live evidence
// the in-frame observer works.
async function postChatgptDrEndedSignal(tabId, conversationId) {
  if (!conversationId) return;
  const creds = await loadCredentials();
  if (!creds) return;
  await postJson(creds.apiBase, '/api/browser-chats/stream-signal', {
    tab_id: tabId,
    provider: 'chatgpt',
    conversation_id: conversationId,
    turn_id: '',
    marker: 'task_status:ended',
    endpoint: 'dr-frame/stop-button',
    method: 'PORT',
    t: Date.now(),
  }, creds.token);
}

// Disarm the backstop when the watch already cleared (DOM path) or the tab closes, so it doesn't post
// a redundant /complete later.
function clearChatgptDrBackstop(tabId) {
  if (tabId != null) drBackstopByTab.delete(tabId);
}

// ChatGPT standard-turn done: DOM completion snapshot for a VISIBLE tab. We deliberately do NOT
// clear on the `/f/conversation` webRequest completion. Investigation (docs .../browser-chatgpt)
// showed that edge is unreliable: ChatGPT's handoff-shaped turns end the request with an early
// stream `[DONE]` ~1-2s into a reply that keeps streaming for ~30s on a channel webRequest can't
// see, so clearing on it marks a long reply "done" ~28s early. The visible-tab DOM completion
// snapshot lands on the real finish, so it is the standard-turn done.
//
// A fully BACKGROUNDED tab freezes the DOM — formerly a documented dead zone. Mitigated two ways
// (findings §3.1): the stream-signal handler clears a HIDDEN tab on the sniffer's [DONE] when the
// body streamed ≥5s (a full body's end IS the true finish; a short/handoff body is ambiguous and
// never clears), and spoofer.js sniffs WebSocket/EventSource so a handoff turn's real stream is
// observable at all. Handoff turns with no in-budget signal remain a (narrower) dead zone.
//
// (Deep-research still clears via the chatgptResearchFilter quiescence backstop above; cancel via the
// stop_conversation filter below. Only the standard-turn network `complete` edge is removed.)

// Explicit provider cancel endpoints. Use request start so the cancel clear wins the race against the
// in-flight generation request error that would otherwise post /complete a few ms later.
const chatgptCancelFilter = {
  urls: [
    "https://chatgpt.com/backend-api/stop_conversation*",
    "https://chat.openai.com/backend-api/stop_conversation*"
  ]
};
const claudeCancelFilter = {
  urls: ["https://claude.ai/api/organizations/*/chat_conversations/*/stop_response*"]
};
const geminiCancelFilter = {
  urls: ["https://gemini.google.com/_/BardChatUi/data/batchexecute*"]
};

chrome.webRequest.onBeforeRequest.addListener(
  (details) => { postBrowserChatCancel('chatgpt', details).catch(() => {}); },
  chatgptCancelFilter
);
chrome.webRequest.onBeforeRequest.addListener(
  (details) => { postBrowserChatCancel('claude', details).catch(() => {}); },
  claudeCancelFilter
);
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (isGeminiCancelRequestUrl(details && details.url)) {
      postBrowserChatCancel('gemini', details).catch(() => {});
    }
  },
  geminiCancelFilter
);

// ── Probe Logging Helper Functions & Tab Caching ──

const tabInfoCache = new Map();

async function isDebugLoggingEnabled() {
  const stored = await chrome.storage.local.get('taskAppChatWatchDebug');
  return !!stored['taskAppChatWatchDebug'];
}

async function getTabInfo(tabId) {
  if (tabInfoCache.has(tabId)) {
    return tabInfoCache.get(tabId);
  }
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ title: '', url: '' });
      } else {
        const info = { title: tab.title || '', url: tab.url || '' };
        tabInfoCache.set(tabId, info);
        resolve(info);
      }
    });
  });
}

// Track tab updates to keep tabInfoCache fresh
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.url && (tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com') || tab.url.includes('claude.ai') || tab.url.includes('gemini.google.com'))) {
    const title = tab.title || '';
    const url = changeInfo.url || tab.url || '';
    tabInfoCache.set(tabId, { title, url });

    if (changeInfo.url && (await isDebugLoggingEnabled())) {
      const creds = await loadCredentials();
      if (creds) {
        await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
          type: 'navigation',
          url: changeInfo.url,
          tabId,
          tabTitle: title,
          tabUrl: changeInfo.url,
          timestamp: new Date().toISOString()
        }, creds.token);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabInfoCache.delete(tabId);
});

// Intercept web requests for probe logging
const llmRequestFilter = {
  urls: [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*"
  ]
};

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.type !== 'xmlhttprequest' && details.type !== 'other') return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    if (!(await isDebugLoggingEnabled())) return;

    const creds = await loadCredentials();
    if (!creds) return;

    const tabInfo = await getTabInfo(details.tabId);
    await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
      type: 'web_request',
      event: 'request_before',
      method: details.method,
      url: details.url,
      requestId: details.requestId,
      resourceType: details.type,
      tabId: details.tabId,
      tabTitle: tabInfo.title || '',
      tabUrl: tabInfo.url || '',
      timestamp: new Date().toISOString()
    }, creds.token);
  },
  llmRequestFilter
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.type !== 'xmlhttprequest' && details.type !== 'other') return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    if (!(await isDebugLoggingEnabled())) return;

    const creds = await loadCredentials();
    if (!creds) return;

    const tabInfo = await getTabInfo(details.tabId);
    await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
      type: 'web_request',
      event: 'request_response',
      method: details.method,
      url: details.url,
      requestId: details.requestId,
      resourceType: details.type,
      statusCode: details.statusCode,
      tabId: details.tabId,
      tabTitle: tabInfo.title || '',
      tabUrl: tabInfo.url || '',
      timestamp: new Date().toISOString()
    }, creds.token);
  },
  llmRequestFilter
);

chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    if (details.type !== 'xmlhttprequest' && details.type !== 'other') return;
    if (details.url.startsWith('http://127.0.0.1') || details.url.startsWith('http://localhost')) return;
    if (!(await isDebugLoggingEnabled())) return;

    const creds = await loadCredentials();
    if (!creds) return;

    const tabInfo = await getTabInfo(details.tabId);
    await postJson(creds.apiBase, '/api/browser-chats/probe-log', {
      type: 'web_request',
      event: 'request_error',
      method: details.method,
      url: details.url,
      requestId: details.requestId,
      resourceType: details.type,
      error: details.error,
      tabId: details.tabId,
      tabTitle: tabInfo.title || '',
      tabUrl: tabInfo.url || '',
      timestamp: new Date().toISOString()
    }, creds.token);
  },
  llmRequestFilter
);

// === stream-signal: attribution + extra_signals (v3-browser-signals) ===
//
// The MAIN-world spoofer (extensions/chat-watch/spoofer.js) tees streamed response BODIES — which
// chrome.webRequest cannot read — and emits structural-only `chat-watch-stream-signal` events that
// the content script forwards here as `STREAM_SIGNAL`. Two jobs, both append-only (a second message
// listener so the existing CHAT_UPDATE/PAGE_CONSOLE_LOG handler is untouched):
//
//   (a) Attribution upgrade (the findings/10 §4 fix): when a stream signal carries a real
//       conversation_id (S1 ChatGPT stream_handoff frames, S5 Gemini c_<id>), record it as the
//       tab's AUTHORITATIVE conversation id — replacing the fragile tab-URL + lastConversationId
//       guess for ChatGPT/Gemini. Claude already carries its id in the request URL, so it doesn't
//       need this. We only sharpen attribution; the generating→done clock is unchanged.
//   (b) Recorder forward: POST the structural signal to /api/browser-chats/stream-signal so the
//       recorder can capture every observed stream signal into extra_signals (capture-everything).
//
// PRIVACY: the spoofer only reads bodies when the user opts in (taskAppChatWatchStreamSignals), and
// the payload here is structural ONLY (provider, conversation_id, turn_id, marker, endpoint family,
// method, t) — never message content.



/** @type {Map<number, string>} tabId -> authoritative conversation id from the stream body. */
const tabStreamConversationId = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreamConversationId.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'STREAM_SIGNAL') return false;
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'no tab' });
    return false;
  }

  const p = message.payload || {};
  const provider = p.provider;
  if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
    sendResponse({ ok: false, error: 'unknown provider' });
    return false;
  }
  const conversation_id =
    typeof p.conversation_id === 'string' ? p.conversation_id.trim().toLowerCase() : '';

  // (a) Promote the stream conversation_id to the tab's authoritative id for ChatGPT/Gemini.
  if (conversation_id && (provider === 'chatgpt' || provider === 'gemini')) {
    tabStreamConversationId.set(tabId, conversation_id);
    const state = tabGenerationState.get(tabId);
    if (state) {
      state.lastConversationId = conversation_id;
      tabGenerationState.set(tabId, state);
    }
  }

  // (b) Forward the structural signal to the recorder endpoint.
  (async () => {
    const creds = await loadCredentials();
    if (!creds) {
      sendResponse({ ok: false, error: 'Orchestra not reachable' });
      return;
    }
    await postJson(
      creds.apiBase,
      '/api/browser-chats/stream-signal',
      {
        tab_id: tabId,
        provider,
        conversation_id,
        turn_id: typeof p.turn_id === 'string' ? p.turn_id : '',
        marker: typeof p.marker === 'string' ? p.marker : '',
        endpoint: typeof p.endpoint === 'string' ? p.endpoint : '',
        method: typeof p.method === 'string' ? p.method : '',
        t: typeof p.t === 'number' ? p.t : Date.now(),
        handoff: p.handoff === true,
        body_ms: typeof p.body_ms === 'number' && p.body_ms >= 0 ? p.body_ms : 0,
      },
      creds.token
    );

    // (c) Claude deep-research completion edge. DR has no streamed /completion request (so the
    // webRequest-based handleClaudeStreamComplete never fires); done lives in the task-status poll
    // BODY, surfaced as the `task_completed` marker. Treat it exactly like the chat completion edge:
    // POST /complete so the watched task clears. The conversation id comes from the status-poll URL.
    if (provider === 'claude' && p.marker === 'task_completed' && conversation_id) {
      claudeDeepResearchFlaggedTabs.delete(tabId); // re-arm DR detection for the tab's next turn
      const state = tabGenerationState.get(tabId);
      if (state) { state.lastGenerating = false; tabGenerationState.set(tabId, state); }
      await postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider: 'claude', conversation_id },
        creds.token
      );
    }

    // (d) ChatGPT HIDDEN-TAB standard-turn done (findings §3.1). Production's only standard-turn
    // done is the DOM completion snapshot, which a hidden tab never produces (frozen DOM) — the
    // documented dead zone. The sniffer's stream-body [DONE] still fires on a hidden tab and, for
    // a FULL stream body, lands at the turn's true finish (observed: body end 43.1s vs GT 43.2s).
    // Clear on it ONLY when ALL hold:
    //   - body_ms >= 5s: a handoff-shaped body ends with an early [DONE] ~1-2s in while the reply
    //     keeps streaming on an invisible channel — its [DONE] must NOT clear. (The handoff flag
    //     alone can't discriminate: full 40s+ bodies also carry stream_handoff frames.) Very short
    //     real replies are missed — conservative: never a wrong clear, at worst the dead zone.
    //   - a generation was actually observed in flight on that tab (no stray [DONE] can clear);
    //   - no DR backstop armed (deep research has its own done path);
    //   - the tab is NOT active — a visible tab keeps the more accurate DOM done.
    if (provider === 'chatgpt' && p.marker === '[DONE]' && conversation_id) {
      const CHATGPT_HIDDEN_CLEAN_DONE_MIN_BODY_MS = 5000;
      const bodyMs = typeof p.body_ms === 'number' ? p.body_ms : 0;
      const drEntry = drBackstopByTab.get(tabId);
      const state = tabGenerationState.get(tabId);
      const generating = !!(state && state.lastGenerating);
      if (bodyMs >= CHATGPT_HIDDEN_CLEAN_DONE_MIN_BODY_MS && generating && !(drEntry && drEntry.armed)) {
        const tab = await new Promise((resolve) => {
          chrome.tabs.get(tabId, (t) => { try { void chrome.runtime.lastError; } catch (_) {} resolve(t || null); });
        });
        const hidden = !tab || tab.active === false;
        if (hidden) {
          state.lastGenerating = false;
          tabGenerationState.set(tabId, state);
          await setGenInFlight(tabId, false);
          await postJson(
            creds.apiBase,
            '/api/browser-chats/complete',
            { provider: 'chatgpt', conversation_id },
            creds.token
          );
        }
      }
    }
    sendResponse({ ok: true });
  })();
  return true; // async response
});
// === end stream-signal fence (v3-browser-signals) ===

// === assistant-text streaming (FollowUps §3.3 — explicit privacy opt-in) ===
// Unlike STREAM_SIGNAL (structural markers only), STREAM_BODY carries the model's MESSAGE TEXT. It
// is only ever dispatched by the content/spoofer scripts when the user has turned on the
// body-streaming opt-in (default OFF). We forward it to the dedicated content endpoint; the server
// keeps ONE current message per conversation and the live-feed adapter renders it as one evolving
// note + a final stop. Display-only: never feeds completion/attribution.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'STREAM_BODY') return false;
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) {
    sendResponse({ ok: false, error: 'no tab' });
    return false;
  }
  const p = message.payload || {};
  const provider = p.provider;
  if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini') {
    sendResponse({ ok: false, error: 'unknown provider' });
    return false;
  }
  const conversation_id =
    (typeof p.conversation_id === 'string' && p.conversation_id.trim()
      ? p.conversation_id.trim().toLowerCase()
      : tabStreamConversationId.get(tabId)) || '';
  const text = typeof p.text === 'string' ? p.text : '';
  // An empty non-final snapshot carries nothing to show; drop it (a final empty is still meaningful —
  // it lets the server close the turn even if no text was captured).
  if (!text && p.final !== true) {
    sendResponse({ ok: false, error: 'empty' });
    return false;
  }
  (async () => {
    const creds = await loadCredentials();
    if (!creds) {
      sendResponse({ ok: false, error: 'Orchestra not reachable' });
      return;
    }
    await postJson(
      creds.apiBase,
      '/api/browser-chats/stream-body',
      {
        tab_id: tabId,
        provider,
        conversation_id,
        turn_id: typeof p.turn_id === 'string' ? p.turn_id : '',
        text,
        final: p.final === true,
        source: p.source === 'stream' || p.source === 'dom' ? p.source : 'stream',
        t: typeof p.t === 'number' ? p.t : Date.now(),
      },
      creds.token
    );
    sendResponse({ ok: true });
  })();
  return true; // async response
});
// === end assistant-text streaming fence (§3.3) ===
