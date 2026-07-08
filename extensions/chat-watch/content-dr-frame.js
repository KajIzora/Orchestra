// Orchestra Chat Watch — deep-research frame observer (v3-browser-signals).
//
// ChatGPT renders the deep-research progress card in a CROSS-ORIGIN sandboxed iframe
// (connector_openai_deep_research.web-sandbox.oaiusercontent.com, title "internal://deep-research").
// The parent-page content script cannot see into it — same-origin policy — so the card's buttons,
// the only live research phase signals ChatGPT exposes, are invisible to it. This script runs
// INSIDE that frame (manifest all_frames on *.oaiusercontent.com) and relays ONLY button
// visibility:
//
//   - start_visible true   → research is PENDING: the post-send countdown card is up. It will
//                             auto-start when the ~60s timer expires (or sooner on click), so the
//                             correct watch state is WORKING — including with the tab backgrounded.
//   - stop_visible true    → research is RUNNING (arms the DR hold + resets the quiet window)
//   - stop_visible false   → research phase ended (the report may still be writing — background
//                             does NOT complete on this edge alone; it enables the post-end fast
//                             complete). Only meaningful after a stop_visible true.
//
// TRANSPORT (v0.5.15): the frame is SANDBOXED (opaque origin), and live testing showed the
// chrome.runtime port never delivered from it (a Stop click produced silence). So the PRIMARY
// transport is window.parent.postMessage → the parent-page content script (content-chatgpt.js)
// validates and forwards over its own runtime channel. The port is still attempted as a secondary
// (background dedupes — both paths carry the same state and the handlers are idempotent). A BOOT
// beacon is sent on script load so the parent can prove injection happened at all
// (dr_frame_seen on snapshots), separating "script never injected" from "buttons not matched".
//
// PRIVACY: structural only — booleans, timestamps, and a button count. Never page content.

(() => {
  'use strict';

  if (window.top === window) return; // frame-only script

  const PORT_NAME = 'chat-watch-dr-frame';
  const RELAY_KEY = '__orchestraChatWatchDrFrame';
  const STOP_RE = /\bstop\s+research\b/i;
  // The countdown card's start control. Matched conservatively ("start" alone would be too loose
  // even inside the research frame): "Start research" / "Start now" / a bare "Start" button.
  const START_RE = /\bstart(\s+(research|now))?\b/i;
  // The COMPLETED state (v0.5.19): the inner frame's body flips to "Research completed in Xm ·
  // N citations · N searches" when the report has fully landed — the one report-done signal that
  // exists on a HIDDEN tab (the frame mutates while hidden; live-proven by the ended edge). The
  // phrase is English-only for now; the burst/backstop paths remain the fallback where it misses.
  const COMPLETED_RE = /\bresearch\s+completed\b/i;
  const PING_MS = 5000; // heartbeat while a phase button is visible (resets the backstop quiet window)

  let port = null;
  let portBroken = false;
  let lastState = null; // null = never reported; else { start: bool, stop: bool }
  let lastSentMs = 0;

  function textOf(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function readButtons() {
    let start = false;
    let stop = false;
    let count = 0;
    for (const button of document.querySelectorAll('button')) {
      count += 1;
      const label = textOf(
        [button.getAttribute('aria-label'), button.innerText || button.textContent, button.getAttribute('title')]
          .map(textOf)
          .filter(Boolean)
          .join(' ')
      );
      if (!label) continue;
      if (STOP_RE.test(label) && isVisible(button)) stop = true;
      else if (START_RE.test(label) && isVisible(button)) start = true;
    }
    // Completed marker: a body-text presence check (boolean only — the text never leaves the frame).
    const completed = !stop && COMPLETED_RE.test(String(document.body ? document.body.textContent : ''));
    return { start, stop, completed, count };
  }

  function ensurePort() {
    if (port || portBroken) return port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
      port.onDisconnect.addListener(() => {
        port = null;
      });
    } catch (_) {
      port = null;
      portBroken = true; // opaque-origin frames may not get runtime APIs at all — the relay carries it
    }
    return port;
  }

  function send(message) {
    // Primary: relay to the TOP page (its content script validates the source chain and
    // forwards). window.top, not window.parent: the research UI lives in a NESTED iframe (page →
    // connector shell → inner frame, discovered live 2026-07-03), and only the top page has a
    // listener. targetOrigin '*' is acceptable: the payload is structural booleans only.
    try {
      window.top.postMessage({ [RELAY_KEY]: message }, '*');
    } catch (_) { /* top gone — nothing to do */ }
    // Secondary: the direct port, when the sandboxed frame is allowed one.
    const p = ensurePort();
    if (p) {
      try { p.postMessage(message); } catch (_) { port = null; }
    }
    lastSentMs = Date.now();
  }

  function stateMessage(state, extra) {
    return {
      event: 'dr_frame_state',
      stop_visible: !!state.stop,
      start_visible: !!state.start,
      completed_visible: !!state.completed,
      t: Date.now(),
      ...(extra || {}),
    };
  }

  function report() {
    const state = readButtons();
    // Lazy phase reporting: don't spam states from frames that never show a phase BUTTON. The
    // completed marker deliberately does NOT activate — a finished research's page shows it from
    // the first paint, and only a frame that reported a live phase earlier may report completion
    // (background additionally requires an observed running phase before acting on it).
    if (lastState === null && !state.start && !state.stop) return;
    const now = Date.now();
    const changed = !lastState
      || state.start !== lastState.start
      || state.stop !== lastState.stop
      || state.completed !== lastState.completed;
    if (changed) {
      lastState = { start: state.start, stop: state.stop, completed: state.completed };
      send(stateMessage(state));
    } else if ((state.start || state.stop) && now - lastSentMs >= PING_MS) {
      send(stateMessage(state)); // heartbeat: research still pending/running
    }
  }

  // User-cancel discrimination (v0.5.17): a clicked "Stop research" and a natural finish both end
  // with the button vanishing plus trailing tool-call completions — indistinguishable from outside
  // (live-confirmed: a clicked stop's drain passed the burst guard and completed as done). The
  // click itself is the one direct discriminator, and it happens in THIS document: report it, and
  // background treats the following ended edge as a CANCEL. Capture phase so ChatGPT's own
  // handlers can't swallow it.
  document.addEventListener('click', (e) => {
    try {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      for (const node of path) {
        if (!(node instanceof Element) || node.tagName !== 'BUTTON') continue;
        const label = textOf(
          [node.getAttribute('aria-label'), node.innerText || node.textContent, node.getAttribute('title')]
            .map(textOf).filter(Boolean).join(' ')
        );
        if (STOP_RE.test(label)) {
          send({ event: 'dr_frame_stop_click', t: Date.now() });
          break;
        }
      }
    } catch (_) { /* structural best-effort */ }
  }, true);

  const observer = new MutationObserver(() => report());
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  window.setInterval(report, 2000); // safety net (throttled while hidden; observer carries the load)

  // Boot beacon: prove injection + report the initial read (button count is a number, nothing more).
  const initial = readButtons();
  send({ event: 'dr_frame_boot', buttons: initial.count, start_visible: initial.start, stop_visible: initial.stop, t: Date.now() });
  report();

  // Frame teardown = the card is going away. Best-effort final word; background also treats a
  // port disconnect (when a port exists) as the research-UI-gone edge.
  window.addEventListener('pagehide', () => {
    if (lastState === null) return; // never phase-activated — stay silent
    send(stateMessage({ start: false, stop: false }, { pagehide: true }));
  });
})();
