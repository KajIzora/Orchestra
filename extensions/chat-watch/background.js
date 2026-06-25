const STORAGE_KEYS = {
  apiBase: 'taskAppChatWatchApiBase',
  token: 'taskAppChatWatchToken',
};

const DEFAULT_PORTS = [47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830];
const CONFIG_FETCH_TIMEOUT_MS = 1500;

/** @type {Map<number, { lastGenerating: boolean, lastConversationId: string }>} */
const tabGenerationState = new Map();
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

chrome.runtime.onInstalled.addListener(() => {
  loadCredentials().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  loadCredentials().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabGenerationState.delete(tabId);
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
    const snapshotBody = {
      tab_id: tabId,
      provider,
      conversation_id,
      url: typeof p.url === 'string' ? p.url : '',
      title: typeof p.title === 'string' ? p.title : '',
      last_user_preview: typeof p.last_user_preview === 'string' ? p.last_user_preview : '',
      generating: !!p.generating,
      completion_signal: !!p.completion_signal,
      failure_signal: !!p.failure_signal,
      failure_reason: typeof p.failure_reason === 'string' ? p.failure_reason : '',
      activity_summary: typeof p.activity_summary === 'string' ? p.activity_summary : '',
    };

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
    const gen = !!p.generating;
    const failed = !!p.failure_signal;
    const completionSignal = !!p.completion_signal;
    const shouldNotifyComplete =
      !!conversation_id &&
      (failed || completionSignal || (prev.lastGenerating && !gen));
    if (shouldNotifyComplete) {
      await postJson(
        creds.apiBase,
        '/api/browser-chats/complete',
        { provider, conversation_id },
        creds.token
      );
    }
    tabGenerationState.set(tabId, { lastGenerating: gen, lastConversationId: prev.lastConversationId || conversation_id });
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

// Web request monitoring to detect ChatGPT background generation completion
const chatgptFilter = {
  urls: [
    "https://chatgpt.com/backend-api/conversation*",
    "https://chatgpt.com/backend-api/f/conversation*",
    "https://chat.openai.com/backend-api/conversation*",
    "https://chat.openai.com/backend-api/f/conversation*"
  ]
};

async function handleChatgptStreamComplete(details) {
  if (details.method !== 'POST') return;
  const tabId = details.tabId;
  if (!tabId) return;

  const state = tabGenerationState.get(tabId);
  if (!state || !state.lastGenerating) {
    return;
  }

  // Set state to not generating immediately to avoid duplicate notifications
  state.lastGenerating = false;
  tabGenerationState.set(tabId, state);

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
          { provider: 'chatgpt', conversation_id: state.lastConversationId },
          creds.token
        );
      }
      return;
    }

    try {
      const url = new URL(tab.url);
      const match = url.pathname.match(/\/c\/([^/?#]+)/i);
      const conversationId = match ? match[1].toLowerCase() : state.lastConversationId;
      if (conversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'chatgpt', conversation_id: conversationId },
          creds.token
        );
      }
    } catch (_) {
      if (state.lastConversationId) {
        postJson(
          creds.apiBase,
          '/api/browser-chats/complete',
          { provider: 'chatgpt', conversation_id: state.lastConversationId },
          creds.token
        );
      }
    }
  });
}

chrome.webRequest.onCompleted.addListener(handleChatgptStreamComplete, chatgptFilter);
chrome.webRequest.onErrorOccurred.addListener(handleChatgptStreamComplete, chatgptFilter);

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
      },
      creds.token
    );
    sendResponse({ ok: true });
  })();
  return true; // async response
});
// === end stream-signal fence (v3-browser-signals) ===
