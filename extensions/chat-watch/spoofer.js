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
    window.addEventListener('chat-watch-stream-config', (event) => {
      try {
        streamSniffEnabled = !!(event && event.detail && event.detail.enabled);
      } catch (_) { /* ignore */ }
    });

    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const GEMINI_C_RE = /\b(c_[0-9a-z]{6,}|rc_[0-9a-z]{6,})\b/ig;

    function streamProviderForUrl(url) {
      const s = String(url || '');
      if (/chatgpt\.com|chat\.openai\.com|\/backend-api\/(f\/)?conversation/i.test(s)) {
        if (/\/backend-api\/(f\/)?conversation\b/i.test(s)) return 'chatgpt';
      }
      if (/\/chat_conversations\/[^/]+\/completion/i.test(s)) return 'claude';
      if (/StreamGenerate/i.test(s)) return 'gemini';
      return null;
    }

    function streamEndpointFamily(provider) {
      if (provider === 'chatgpt') return 'backend-api/conversation';
      if (provider === 'claude') return 'chat_conversations/completion';
      if (provider === 'gemini') return 'StreamGenerate';
      return 'unknown';
    }

    // Scan a chunk for STRUCTURAL fields only — mirror of lib/browser_stream_signals.js. Mutates acc.
    function streamScanChunk(provider, text, acc) {
      const s = String(text || '');
      if (provider === 'chatgpt') {
        let m = s.match(/"conversation_id"\s*:\s*"([^"]+)"/i);
        if (m && UUID_RE.test(m[1]) && !acc.conversation_id) acc.conversation_id = m[1];
        m = s.match(/"turn_exchange_id"\s*:\s*"([^"]+)"/i);
        if (m && !acc.turn_id) acc.turn_id = m[1];
        if (/stream_handoff|resume_conversation_token/i.test(s)) acc.markers.add('stream_handoff');
        if (/\bdata:\s*\[DONE\]/i.test(s)) acc.markers.add('[DONE]');
      } else if (provider === 'claude') {
        if (/"type"\s*:\s*"message_stop"/i.test(s) || /\bevent:\s*message_stop\b/i.test(s)) {
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

    function emitStreamSignals(provider, method, acc) {
      const base = {
        provider,
        conversation_id: acc.conversation_id || '',
        turn_id: acc.turn_id || '',
        endpoint: streamEndpointFamily(provider),
        method: method || 'POST',
        t: Date.now(),
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
    function sniffReadableStream(provider, method, stream) {
      const acc = { conversation_id: '', turn_id: '', markers: new Set() };
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
            streamScanChunk(provider, tail + chunk, acc);
            tail = (tail + chunk).slice(-4096);
          }
          acc.markers.add('end_of_stream');
          emitStreamSignals(provider, method, acc);
        } catch (_) {
          // Stream errored/aborted — still emit whatever structural fields we captured.
          try { emitStreamSignals(provider, method, acc); } catch (__) { /* ignore */ }
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
        if (streamSniffEnabled) {
          let url = '';
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
                sniffReadableStream(provider, method, clone.body);
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
          if (streamSniffEnabled) {
            const url = this.__chatWatchStreamUrl || '';
            const provider = streamProviderForUrl(url);
            if (provider) {
              this.addEventListener('load', () => {
                try {
                  let text = '';
                  try { text = this.responseType === '' || this.responseType === 'text' ? this.responseText : ''; } catch (_) { text = ''; }
                  const acc = { conversation_id: '', turn_id: '', markers: new Set() };
                  streamScanChunk(provider, text, acc);
                  acc.markers.add('end_of_stream');
                  emitStreamSignals(provider, this.__chatWatchStreamMethod || 'GET', acc);
                } catch (_) { /* ignore */ }
              });
            }
          }
        } catch (_) { /* never break the page */ }
        return originalSend.apply(this, arguments);
      };
    }

  } catch (e) {
    console.error('[chat-watch] failed to initialize visibility spoofer in page context:', e);
  }
})();
