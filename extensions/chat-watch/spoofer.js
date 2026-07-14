(function() {
  try {
    // ── Visibility Spoofing ──
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.hasFocus = () => true;

    const preventEvent = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    window.addEventListener('visibilitychange', preventEvent, true);
    window.addEventListener('blur', preventEvent, true);
    document.addEventListener('visibilitychange', preventEvent, true);
    document.addEventListener('blur', preventEvent, true);

    // ── Console Interception ──
    const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
    const originalConsole = {};
    for (const method of consoleMethods) {
      originalConsole[method] = console[method];
      console[method] = function(...args) {
        originalConsole[method].apply(console, args);
        try {
          const text = args.map(arg => {
            if (arg === null) return 'null';
            if (arg === undefined) return 'undefined';
            if (typeof arg === 'object') {
              try {
                return JSON.stringify(arg);
              } catch (_) {
                return String(arg);
              }
            }
            return String(arg);
          }).join(' ');

          window.dispatchEvent(new CustomEvent('chat-watch-console-log', {
            detail: {
              method,
              text,
              timestamp: new Date().toISOString()
            }
          }));
        } catch (_) {
          // ignore
        }
      };
    }

    // ── Stream-body signal sniffer (S1/S3/S4/S5 — structural-only) ──
    //
    // chrome.webRequest cannot read response BODIES, but the signals that fix ChatGPT/Gemini
    // attribution (and the clean stream-end edges) live inside the streamed body. This hook tees
    // window.fetch / XMLHttpRequest streams, scans each chunk for STRUCTURAL markers ONLY
    // (conversation_id, turn id, [DONE] / message_stop / end-of-stream), and dispatches a
    // `chat-watch-stream-signal` CustomEvent that the isolated-world content script forwards to the
    // background worker — exactly the dispatch pattern used by the console interceptor above.
    //
    // PRIVACY: body-reading is OPT-IN and DEFAULTS OFF. The MAIN world can't read chrome.storage,
    // so the isolated-world content script (which can) tells us via a `chat-watch-stream-config`
    // event whether the privacy toggle is enabled. Until enabled, we do not tee any body. We also
    // never read content — only the narrow id/marker regexes below touch the chunk text, and the
    // text is discarded immediately after scanning.

    let streamSniffEnabled = false;
    // Separate, stricter opt-in (FollowUps §3.3): stream the assistant's MESSAGE TEXT, not just
    // structural markers. Defaults OFF. When on, we also tee the body (even if streamSignals is off)
    // and extract the reply text — see extractAssistantText below (mirror of lib/browser_stream_signals.js).
    let streamBodyEnabled = false;
    window.addEventListener('chat-watch-stream-config', (event) => {
      try {
        const d = (event && event.detail) || {};
        streamSniffEnabled = !!d.enabled;
        streamBodyEnabled = !!d.bodyEnabled;
      } catch (_) { /* ignore */ }
    });

    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const GEMINI_C_RE = /\b(c_[0-9a-z]{6,}|rc_[0-9a-z]{6,})\b/ig;
    // Claude deep-research task-status poll (mirror of lib/browser_stream_signals.js). Done lives in
    // the JSON body's status enum, which webRequest can't read — so we sniff it here.
    const CLAUDE_TASK_STATUS_RE = /\/chat_conversations\/([^/]+)\/task\/wf-[^/]+\/status/i;
    const CLAUDE_TASK_DONE_STATES = new Set([
      'completed', 'complete', 'done', 'succeeded', 'success', 'finished',
      'failed', 'error', 'errored', 'cancelled', 'canceled', 'stopped',
    ]);
    function isClaudeTaskStatusEndpoint(url) {
      return CLAUDE_TASK_STATUS_RE.test(String(url || ''));
    }
    function claudeConversationIdFromUrl(url) {
      const m = String(url || '').match(CLAUDE_TASK_STATUS_RE);
      return m ? m[1].toLowerCase() : '';
    }

    function streamProviderForUrl(url) {
      const s = String(url || '');
      // ANCHORED (findings §3.2): only the real generation stream POST (`/backend-api/conversation`
      // or `/backend-api/f/conversation`, nothing after) is sniffed. The old `\b` match also teed
      // `/f/conversation/prepare`, `/conversation/init`, `/conversation/<id>/stream_status` and
      // `/conversation/<id>/textdocs` — housekeeping whose end_of_stream markers polluted the
      // activity-quiescence ground truth (a GT done at 0.4s from a page-load /prepare).
      if (/chatgpt\.com|chat\.openai\.com|\/backend-api\/(f\/)?conversation/i.test(s)) {
        if (/\/backend-api\/(f\/)?conversation(\?|$)/i.test(s)) return 'chatgpt';
      }
      if (/\/chat_conversations\/[^/]+\/completion/i.test(s) || isClaudeTaskStatusEndpoint(s)) return 'claude';
      if (/StreamGenerate/i.test(s)) return 'gemini';
      return null;
    }

    // Host-only provider match for realtime channels (WebSocket / EventSource). ChatGPT's handoff
    // architecture (2026-07: `stream_handoff` / `resume_conversation_token` frames) can move the
    // real token stream off the `/f/conversation` POST onto a channel that webRequest and the fetch
    // hook never see — so realtime channels are sniffed by provider HOST, not endpoint path.
    function streamProviderForRealtimeUrl(url) {
      try {
        const u = new URL(String(url || ''), location.href);
        const host = u.hostname || '';
        if (/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(host)) return 'chatgpt';
        if (/(^|\.)claude\.ai$/i.test(host)) return 'claude';
        if (host === 'gemini.google.com') return 'gemini';
      } catch (_) { /* ignore */ }
      return null;
    }

    function streamEndpointFamily(provider, url) {
      if (provider === 'chatgpt') return 'backend-api/conversation';
      if (provider === 'claude') return isClaudeTaskStatusEndpoint(url) ? 'chat_conversations/task_status' : 'chat_conversations/completion';
      if (provider === 'gemini') return 'StreamGenerate';
      return 'unknown';
    }

    // Scan a chunk for STRUCTURAL fields only — mirror of lib/browser_stream_signals.js. Mutates acc.
    function streamScanChunk(provider, text, acc, url) {
      const s = String(text || '');
      if (provider === 'chatgpt') {
        let m = s.match(/"conversation_id"\s*:\s*"([^"]+)"/i);
        if (m && UUID_RE.test(m[1]) && !acc.conversation_id) acc.conversation_id = m[1];
        m = s.match(/"turn_exchange_id"\s*:\s*"([^"]+)"/i);
        if (m && !acc.turn_id) acc.turn_id = m[1];
        if (/stream_handoff|resume_conversation_token/i.test(s)) acc.markers.add('stream_handoff');
        if (/\bdata:\s*\[DONE\]/i.test(s)) acc.markers.add('[DONE]');
      } else if (provider === 'claude') {
        if (isClaudeTaskStatusEndpoint(url)) {
          // Deep-research status poll: read the status ENUM value(s) only (never content).
          const re = /"(?:status|state|task_status|workflow_status|run_status|task_state)"\s*:\s*"([a-z_]{3,30})"/ig;
          let mm;
          while ((mm = re.exec(s)) !== null) {
            const value = mm[1].toLowerCase();
            acc.markers.add('task_status:' + value);
            if (CLAUDE_TASK_DONE_STATES.has(value)) acc.markers.add('task_completed');
          }
        } else if (/"type"\s*:\s*"message_stop"/i.test(s) || /\bevent:\s*message_stop\b/i.test(s)) {
          acc.markers.add('message_stop');
        }
      } else if (provider === 'gemini') {
        const matches = s.match(GEMINI_C_RE) || [];
        for (const tok of matches) {
          if (/^c_/i.test(tok) && !acc.conversation_id) acc.conversation_id = tok.toLowerCase();
          else if (/^rc_/i.test(tok) && !acc.turn_id) acc.turn_id = tok.toLowerCase();
        }
      }
    }

    // Realtime-WS content-append delta detector — mirror of lib/browser_stream_signals.js
    // isChatgptRealtimeActivityFrame. Structural ONLY: matches the JSON-patch `append` op / message
    // content pointer, never the appended value. Trailing metadata patches don't match.
    function isChatgptRealtimeActivityFrame(text) {
      const s = String(text || '');
      return /"o"\s*:\s*"append"/i.test(s) || /"p"\s*:\s*"\/message\/content\/parts\//i.test(s);
    }

    // ── OPT-IN assistant-text extraction (FollowUps §3.3) — mirror of lib/browser_stream_signals.js ──
    // Only ever invoked when streamBodyEnabled is true. Reads the model's message content, so it is
    // held behind the separate body-streaming opt-in. Claude is reliable (text_delta); ChatGPT is
    // best-effort (snapshot + append frames); Gemini is handled by the DOM path in the content script.
    function decodeJsonStringBody(raw) {
      try {
        return JSON.parse('"' + String(raw) + '"');
      } catch (_) {
        return String(raw).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    function extractAssistantText(provider, text, acc, url) {
      const s = String(text || '');
      if (provider === 'claude') {
        if (isClaudeTaskStatusEndpoint(url)) return;
        const re = /"type"\s*:\s*"text_delta"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"/ig;
        let m;
        while ((m = re.exec(s)) !== null) acc.text += decodeJsonStringBody(m[1]);
      } else if (provider === 'chatgpt') {
        const snapRe = /"content"\s*:\s*\{\s*"content_type"\s*:\s*"text"\s*,\s*"parts"\s*:\s*\[\s*"((?:\\.|[^"\\])*)"/ig;
        let m;
        let lastSnap = null;
        while ((m = snapRe.exec(s)) !== null) lastSnap = m[1];
        if (lastSnap !== null) { acc.text = decodeJsonStringBody(lastSnap); return; }
        const partsAppendRe = /"p"\s*:\s*"\/message\/content\/parts\/0"\s*,\s*"o"\s*:\s*"append"\s*,\s*"v"\s*:\s*"((?:\\.|[^"\\])*)"/ig;
        let appended = false;
        while ((m = partsAppendRe.exec(s)) !== null) { acc.text += decodeJsonStringBody(m[1]); appended = true; }
        if (appended) return;
        const bareAppendRe = /(^|[\n,{])\s*"v"\s*:\s*"((?:\\.|[^"\\])*)"\s*(?=[,}\n]|$)/ig;
        while ((m = bareAppendRe.exec(s)) !== null) acc.text += decodeJsonStringBody(m[2]);
      }
    }
    // Post the current assistant text to the isolated-world content script, which forwards it to the
    // background worker (→ POST /api/browser-chats/stream-body). `final` marks the last emit of a turn.
    function emitStreamBody(provider, textAcc, url, final) {
      try {
        const text = String(textAcc.text || '');
        if (!text && !final) return;
        window.dispatchEvent(new CustomEvent('chat-watch-stream-body', {
          detail: {
            provider,
            conversation_id: textAcc.conversation_id || '',
            turn_id: textAcc.turn_id || '',
            text,
            final: final === true,
            source: 'stream',
            t: Date.now(),
          },
        }));
      } catch (_) { /* ignore */ }
    }

    function emitStreamSignals(provider, method, acc, url, opts) {
      const o = opts || {};
      const base = {
        provider,
        conversation_id: acc.conversation_id || claudeConversationIdFromUrl(url) || '',
        turn_id: acc.turn_id || '',
        endpoint: o.endpoint || streamEndpointFamily(provider, url),
        method: method || 'POST',
        t: Date.now(),
        // Whether a stream_handoff/resume_conversation_token frame appeared in the SAME body. A
        // handoff body can end with an early `data: [DONE]` while the reply keeps streaming
        // elsewhere, so consumers must not treat its [DONE] as the turn's done (findings §3.1).
        handoff: acc.markers.has('stream_handoff') || acc.handoff === true,
        // How long the sniffed body streamed (ms; 0 = unknown/not applicable). A real full-stream
        // body ends at the turn's true finish (tens of seconds); a handoff body ends in ~1-2s. The
        // hidden-tab done heuristic in background.js keys off this.
        body_ms: Number.isFinite(o.bodyMs) && o.bodyMs >= 0 ? Math.round(o.bodyMs) : 0,
      };
      const markers = acc.markers.size ? Array.from(acc.markers) : (base.conversation_id ? ['conversation_id'] : []);
      for (const marker of markers) {
        try {
          window.dispatchEvent(new CustomEvent('chat-watch-stream-signal', {
            detail: { ...base, marker },
          }));
        } catch (_) { /* ignore */ }
      }
    }

    // Consume a ReadableStream we OWN (the body of a response.clone()). The page reads the
    // original response on its own stream; this `stream` belongs to our clone, so we read it
    // directly — no inner tee needed (teeing here would leave an unread branch that stalls the
    // reader via backpressure). Decoder output is scanned then discarded.
    // Throttle for streaming assistant-text emits (§3.3). One evolving snapshot every ~1.5s while the
    // reply grows, so a long generation posts a bounded number of updates (the server keeps ONE
    // current message; the live-feed adapter mutates ONE note in place).
    const STREAM_BODY_EMIT_MS = 1500;
    function sniffReadableStream(provider, method, stream, url) {
      const acc = { conversation_id: '', turn_id: '', markers: new Set() };
      // Text accumulator for the opt-in body-streaming path; carries ids alongside so the emit can be
      // attributed. Text is only ever touched when streamBodyEnabled is true.
      const textAcc = { text: '', conversation_id: '', turn_id: '' };
      const isTaskStatus = isClaudeTaskStatusEndpoint(url);
      const startedAt = Date.now();
      let lastBodyEmitAt = 0;
      (async () => {
        try {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          // Bound the scanned window so a huge body never balloons memory; ids/markers appear early
          // and at the very end, so we keep only a rolling tail plus first-seen ids.
          let tail = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
            const scanText = tail + chunk;
            streamScanChunk(provider, scanText, acc, url);
            // Text extraction is incremental per chunk (deltas append) — feed ONLY the fresh chunk,
            // not the rolling tail, so append-style frames aren't double-counted.
            if (streamBodyEnabled && !isTaskStatus) {
              extractAssistantText(provider, chunk, textAcc, url);
              textAcc.conversation_id = textAcc.conversation_id || acc.conversation_id;
              textAcc.turn_id = textAcc.turn_id || acc.turn_id;
              const now = Date.now();
              if (now - lastBodyEmitAt >= STREAM_BODY_EMIT_MS) {
                lastBodyEmitAt = now;
                emitStreamBody(provider, textAcc, url, false);
              }
            }
            tail = scanText.slice(-4096);
          }
          // The body simply ending is a done edge for streamed generations — but NOT for the claude
          // task-status poll, where each poll's body ends every few seconds (its done lives in the
          // status enum, handled by streamScanChunk).
          if (!isTaskStatus) acc.markers.add('end_of_stream');
          emitStreamSignals(provider, method, acc, url, { bodyMs: Date.now() - startedAt });
          // Final text emit at stream end (the content script also sends a DOM final on the
          // generating→idle edge; the server keeps whichever is longer — see ingestStreamBody).
          if (streamBodyEnabled && !isTaskStatus) {
            textAcc.conversation_id = textAcc.conversation_id || acc.conversation_id;
            textAcc.turn_id = textAcc.turn_id || acc.turn_id;
            emitStreamBody(provider, textAcc, url, true);
          }
        } catch (_) {
          // Stream errored/aborted — still emit whatever structural fields we captured.
          try { emitStreamSignals(provider, method, acc, url, { bodyMs: Date.now() - startedAt }); } catch (__) { /* ignore */ }
        }
      })();
    }

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function patchedFetch(input, init) {
        // Decide FIRST whether this is a request we sniff. For everything else (the vast majority —
        // analytics/ads/telemetry beacons, asset loads, etc.) we are a pure pass-through: a direct
        // tail-return of the native fetch with NO retained promise and NO `.then`/`.catch` chain of
        // ours. This matters for two reasons:
        //   1. Page behavior is byte-identical — the page gets exactly the native promise (same
        //      resolution, same rejection), so we never alter or swallow anything it relies on.
        //   2. When a non-sniffed request rejects (e.g. Gemini's own googleadservices.com ad-
        //      conversion beacon being blocked by Gemini's CSP — not our request, just one that
        //      happens to flow through the wrapped fetch), the rejected/unhandled promise is the
        //      native one, not a spoofer-owned then-chained promise, so it stops being attributed to
        //      spoofer.js in the extension's error panel. We were only ever an innocent frame on
        //      those; this removes the frame for the requests we don't care about.
        let provider = null;
        let url = '';
        // Tee when EITHER opt-in is on: structural sniffing OR body-text streaming (§3.3). Both
        // default off, so the common case is still the pure pass-through below.
        if (streamSniffEnabled || streamBodyEnabled) {
          try {
            url = typeof input === 'string' ? input : (input && input.url) || '';
          } catch (_) { url = ''; }
          provider = streamProviderForUrl(url);
        }
        if (!provider) return originalFetch.apply(this, arguments);

        // Sniffed path: a provider stream endpoint. Here we DO chain a `.then` to clone+sniff the
        // body, but we never add a `.catch` — a rejection still propagates to the page unchanged.
        const method = (init && init.method) || (input && input.method) || 'GET';
        return originalFetch.apply(this, arguments).then((response) => {
          try {
            // CRITICAL: never tee response.body directly — tee() locks and disturbs the
            // original stream, so the page's own response.json()/response.body read throws
            // "body stream already read". Clone first and sniff the CLONE's body; the
            // original Response the page holds is left completely untouched.
            if (response && response.body && !response.bodyUsed) {
              let clone = null;
              try { clone = response.clone(); } catch (_) { clone = null; }
              if (clone && clone.body) {
                sniffReadableStream(provider, method, clone.body, url);
              }
            }
          } catch (_) { /* never break the page */ }
          return response;
        });
      };
    }

    // XHR: we can't tee an XHR body stream, so we scan the (already buffered) responseText on
    // load — structural-only, same regexes. Reading responseText does not consume the page's data.
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;
      XHR.prototype.open = function patchedOpen(method, url) {
        try {
          this.__chatWatchStreamUrl = url;
          this.__chatWatchStreamMethod = method;
        } catch (_) { /* ignore */ }
        return originalOpen.apply(this, arguments);
      };
      XHR.prototype.send = function patchedSend() {
        try {
          if (streamSniffEnabled || streamBodyEnabled) {
            const url = this.__chatWatchStreamUrl || '';
            const provider = streamProviderForUrl(url);
            if (provider) {
              const sentAt = Date.now();
              this.addEventListener('load', () => {
                try {
                  let text = '';
                  try { text = this.responseType === '' || this.responseType === 'text' ? this.responseText : ''; } catch (_) { text = ''; }
                  const acc = { conversation_id: '', turn_id: '', markers: new Set() };
                  streamScanChunk(provider, text, acc, url);
                  // Not a done edge for the claude task-status poll (each poll completes; see fetch path).
                  if (!isClaudeTaskStatusEndpoint(url)) acc.markers.add('end_of_stream');
                  emitStreamSignals(provider, this.__chatWatchStreamMethod || 'GET', acc, url, { bodyMs: Date.now() - sentAt });
                  // Opt-in body text: an XHR body is already fully buffered, so this is a single final
                  // emit (no intermediate streaming). Skips the claude task-status poll.
                  if (streamBodyEnabled && !isClaudeTaskStatusEndpoint(url)) {
                    const textAcc = { text: '', conversation_id: acc.conversation_id, turn_id: acc.turn_id };
                    extractAssistantText(provider, text, textAcc, url);
                    if (textAcc.text) emitStreamBody(provider, textAcc, url, true);
                  }
                } catch (_) { /* ignore */ }
              });
            }
          }
        } catch (_) { /* never break the page */ }
        return originalSend.apply(this, arguments);
      };
    }

    // ── Realtime channels: WebSocket / EventSource (structural-only, same privacy contract) ──
    //
    // ChatGPT's resumable/handoff streaming (2026-07) can end the `/f/conversation` POST ~1-2s in
    // (its body closes with `stream_handoff` frames + an early `data: [DONE]`) while the real reply
    // keeps streaming on a channel invisible to both chrome.webRequest and the fetch/XHR hooks
    // above. Observing that channel restores a network-side done that works foreground AND on a
    // hidden tab (findings §3.1). Same rules as the fetch hook: gated on the opt-in flag at
    // scan time, narrow structural regexes only, frame text discarded immediately.
    //
    // Per-frame semantics: a realtime channel has no natural body end mid-conversation, so markers
    // are emitted as they appear (the terminal [DONE]/message_stop IS the live done edge) and the
    // marker set resets after each emit so a later turn's terminal frame emits again. A short
    // re-emit throttle keeps a burst of frames from duplicating the same marker.
    //
    // A handoff turn's real answer streams here as content-append delta frames that carry no terminal
    // marker — so without a heartbeat the activity-quiescence GT sees nothing after the ~2s handoff
    // and fires done ~40s+ early (observed 2026-07-13 happy-path-long). We emit a structural-only
    // `stream_delta` per content-append frame; the same re-emit throttle collapses the burst to one
    // heartbeat every REALTIME_MARKER_REEMIT_MS, which keeps the quiescence clock alive across the WS
    // stream and lands done on the last delta. `stream_delta` is inert to production (lib/browser_chat).
    const REALTIME_MARKER_REEMIT_MS = 3000;
    function sniffRealtimeChannel(provider, channelLabel, target, url) {
      const acc = { conversation_id: '', turn_id: '', markers: new Set(), handoff: false };
      const openedAt = Date.now();
      const lastEmitAtByMarker = new Map();
      const emitFresh = () => {
        if (acc.markers.has('stream_handoff')) acc.handoff = true; // sticky across frames
        const now = Date.now();
        const fresh = Array.from(acc.markers).filter(
          (m) => now - (lastEmitAtByMarker.get(m) || 0) > REALTIME_MARKER_REEMIT_MS
        );
        acc.markers.clear();
        if (!fresh.length) return;
        for (const m of fresh) lastEmitAtByMarker.set(m, now);
        emitStreamSignals(
          provider,
          channelLabel,
          { conversation_id: acc.conversation_id, turn_id: acc.turn_id, markers: new Set(fresh), handoff: acc.handoff },
          url,
          { endpoint: `realtime:${channelLabel.toLowerCase()}`, bodyMs: now - openedAt }
        );
      };
      const scanFrame = (data) => {
        try {
          if (!streamSniffEnabled || typeof data !== 'string' || !data) return;
          streamScanChunk(provider, data, acc, url);
          // Realtime content heartbeat: a ChatGPT content-append delta over the WS is generation
          // activity even though it carries no terminal marker. Emit a throttled `stream_delta`.
          if (provider === 'chatgpt' && isChatgptRealtimeActivityFrame(data)) acc.markers.add('stream_delta');
          emitFresh();
        } catch (_) { /* never break the page */ }
      };
      try {
        target.addEventListener('message', (ev) => scanFrame(ev && ev.data));
        const onEnd = () => {
          try {
            if (!streamSniffEnabled) return;
            acc.markers.add('end_of_stream');
            emitFresh();
          } catch (_) { /* ignore */ }
        };
        if (channelLabel === 'WS') target.addEventListener('close', onEnd);
        else target.addEventListener('error', onEnd); // EventSource: error fires on close/drop
      } catch (_) { /* ignore */ }
    }

    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket === 'function') {
      const PatchedWebSocket = function WebSocket(url, protocols) {
        const ws = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
        try {
          // Attach unconditionally for provider hosts; scanFrame re-checks the opt-in flag per
          // frame (the flag can arrive after page-load sockets are already open).
          const provider = streamProviderForRealtimeUrl(url);
          if (provider) sniffRealtimeChannel(provider, 'WS', ws, String(url || ''));
        } catch (_) { /* never break the page */ }
        return ws;
      };
      try {
        PatchedWebSocket.prototype = OriginalWebSocket.prototype;
        for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) PatchedWebSocket[k] = OriginalWebSocket[k];
      } catch (_) { /* ignore */ }
      window.WebSocket = PatchedWebSocket;
    }

    const OriginalEventSource = window.EventSource;
    if (typeof OriginalEventSource === 'function') {
      const PatchedEventSource = function EventSource(url, config) {
        const es = config === undefined ? new OriginalEventSource(url) : new OriginalEventSource(url, config);
        try {
          // Best-effort: only unnamed `message` events are observed (named SSE events would need
          // per-type listeners we can't enumerate) — enough for id/terminal-marker scanning.
          const provider = streamProviderForRealtimeUrl(url);
          if (provider) sniffRealtimeChannel(provider, 'SSE', es, String(url || ''));
        } catch (_) { /* never break the page */ }
        return es;
      };
      try {
        PatchedEventSource.prototype = OriginalEventSource.prototype;
        for (const k of ['CONNECTING', 'OPEN', 'CLOSED']) PatchedEventSource[k] = OriginalEventSource[k];
      } catch (_) { /* ignore */ }
      window.EventSource = PatchedEventSource;
    }

  } catch (e) {
    console.error('[chat-watch] failed to initialize visibility spoofer in page context:', e);
  }
})();
