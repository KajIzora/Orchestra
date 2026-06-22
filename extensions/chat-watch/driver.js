(() => {
  // ===========================================================================
  // Orchestra Chat Watch — TEST-ONLY auto-send driver (v3-browser-driver).
  //
  // PURPOSE: drive ChatGPT / Claude / Gemini *web* tabs for concurrent capture
  // waves — type a prompt, submit it, and (optionally) flip on deep-research
  // mode. This is the browser analog of the CLI/AppleScript auto-drivers and is
  // what lets us run N conversations at once *before* we have golden captures.
  //
  // GUARDRAIL (hard): this driver ONLY SENDS PROMPTS. It never reads or reports
  // completion. Production done-tracking stays the extension's webRequest edge +
  // DOM snapshots (content-* scripts + background.js). Nothing here posts to
  // /complete or otherwise becomes the done signal.
  //
  // INERT BY DEFAULT: every entry point is gated on the `taskAppChatWatchDriver`
  // storage flag. With the flag off (the normal/shipped state) this script
  // registers a single message listener that refuses every command and does
  // nothing to the page. It only acts when a test operator explicitly enables
  // the flag (extension popup / chrome.storage) AND background.js relays a
  // CHAT_DRIVE command originating from the dev-only /api/browser-chats/drive
  // endpoint.
  //
  // FILE BOUNDARY: this file is owned by v3-browser-driver. It mirrors the
  // injection/DOM patterns in spoofer.js + content-chatgpt.js but does NOT edit
  // them. It runs in the ISOLATED world (default) so it can use chrome.runtime;
  // for Gemini's Quill editor it dispatches real key/input events rather than
  // value-setting (the native-input path required by findings/10 §1).
  // ===========================================================================

  if (window.__orchestraChatDriverInstalled) return;
  window.__orchestraChatDriverInstalled = true;

  const LOG_PREFIX = '[chat-driver]';
  const DRIVER_FLAG = 'taskAppChatWatchDriver';

  // Step-by-step trace logging. Always on while driving (the driver itself only
  // runs when the flag is set + a CHAT_DRIVE arrives, so this is never noisy in
  // normal use). Read these in the ChatGPT PAGE console (filter: "chat-driver").
  let traceStep = 0;
  function trace(msg, extra) {
    traceStep += 1;
    if (extra !== undefined) {
      console.log(`${LOG_PREFIX} #${traceStep} ${msg}`, extra);
    } else {
      console.log(`${LOG_PREFIX} #${traceStep} ${msg}`);
    }
  }
  function composerText(composer) {
    try {
      return textOf(composer && (composer.innerText || composer.textContent)) || '';
    } catch (_) {
      return '';
    }
  }
  function menuIsOpen() {
    return Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')).some(isVisible);
  }

  const PROVIDERS = [
    { id: 'chatgpt', hostPattern: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i },
    { id: 'claude', hostPattern: /(^|\.)claude\.ai$/i },
    { id: 'gemini', hostPattern: /(^|\.)gemini\.google\.com$/i },
  ];

  function providerId() {
    const p = PROVIDERS.find((x) => x.hostPattern.test(location.host));
    return p ? p.id : 'unknown';
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  // Poll for an element matching `find()` up to `timeoutMs`.
  async function waitFor(find, { timeoutMs = 12000, intervalMs = 200 } = {}) {
    const start = Date.now();
    for (;;) {
      let el = null;
      try {
        el = find();
      } catch (_) {
        el = null;
      }
      if (el) return el;
      if (Date.now() - start > timeoutMs) return null;
      await sleep(intervalMs);
    }
  }

  function isDriverEnabled() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([DRIVER_FLAG], (stored) => {
          try {
            void chrome.runtime.lastError;
          } catch (_) { /* ignore */ }
          resolve(!!(stored && stored[DRIVER_FLAG]));
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  // ── Banner dismissal ──────────────────────────────────────────────────────
  // findings/10 §1: a load-time banner (e.g. Claude "Fable unavailable") can
  // swallow the first submit. Best-effort dismiss of obvious dismiss controls,
  // then proceed — we never block forever on a banner that may not exist.
  async function dismissBanners() {
    const dismissLabels = /\b(dismiss|close|got it|ok|okay|continue|no thanks|not now)\b/i;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
    for (const btn of buttons) {
      const label = textOf(btn.getAttribute('aria-label') || btn.innerText || btn.textContent);
      if (label && dismissLabels.test(label) && label.length < 40) {
        try {
          btn.click();
          await sleep(150);
        } catch (_) { /* ignore */ }
      }
    }
  }

  // ── Per-provider composer location ─────────────────────────────────────────
  function findComposer(provider) {
    if (provider === 'chatgpt') {
      return (
        document.querySelector('#prompt-textarea[contenteditable="true"]') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('textarea[data-id], main textarea') ||
        document.querySelector('div[contenteditable="true"]')
      );
    }
    if (provider === 'claude') {
      return (
        document.querySelector('div[contenteditable="true"].ProseMirror') ||
        document.querySelector('[contenteditable="true"][role="textbox"]') ||
        document.querySelector('div[contenteditable="true"]')
      );
    }
    if (provider === 'gemini') {
      // Quill editor — the rounded prompt pill, NOT the uploads "+" icon.
      return (
        document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
        document.querySelector('.ql-editor[contenteditable="true"]') ||
        document.querySelector('div[contenteditable="true"][role="textbox"]')
      );
    }
    return null;
  }

  // Focus is the whole game (findings/10 §1): click inside the editable region,
  // then assert document.activeElement actually became (or contains) the input.
  async function focusComposer(provider) {
    await dismissBanners();
    const composer = await waitFor(() => findComposer(provider), { timeoutMs: 15000 });
    if (!composer) throw new Error(`composer not found for ${provider}`);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        composer.scrollIntoView({ block: 'center' });
        const rect = composer.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // A real pointer sequence inside the pill — Quill ignores a bare focus().
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          composer.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window })
          );
        }
        if (typeof composer.focus === 'function') composer.focus();
      } catch (_) { /* ignore and re-check */ }

      await sleep(120);
      const active = document.activeElement;
      if (active === composer || (composer.contains && composer.contains(active)) || (active && active.closest && active.closest('[contenteditable="true"], textarea'))) {
        return composer;
      }
    }
    throw new Error(`could not focus composer for ${provider} (activeElement assert failed)`);
  }

  // ── setInput ───────────────────────────────────────────────────────────────
  // ChatGPT/Claude accept the native input pipeline via execCommand insertText on
  // their contenteditable. Gemini's Quill ql-editor also needs the native input
  // pipeline (synthetic beforeinput/textContent is ignored) — execCommand drives
  // Quill's own input handler. We multiline-split so newlines don't submit early.
  // Select-all + delete the composer's contents. Best-effort; verifies empty.
  async function clearComposer(composer) {
    try {
      composer.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) { /* ignore */ }
    await sleep(60);
    return !textOf(composer.innerText || composer.textContent);
  }

  async function setInput(provider, composer, text) {
    composer.focus();

    // Clear existing content via select-all + delete on the editable.
    await clearComposer(composer);

    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0) {
        // Soft newline inside the composer — never the submit Enter.
        const ok = document.execCommand('insertLineBreak', false, null);
        if (!ok) {
          // Fallback: shift+Enter key event for editors that don't honor execCommand line breaks.
          dispatchKey(composer, 'Enter', { shiftKey: true });
        }
      }
      if (lines[i].length) {
        const inserted = document.execCommand('insertText', false, lines[i]);
        if (!inserted) {
          // Last-resort native input event (still not value-setting).
          composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: lines[i] }));
        }
      }
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);

    // Verify the text actually landed (focus/Quill miss → empty composer).
    const got = textOf(composer.innerText || composer.textContent);
    if (!got) throw new Error(`setInput produced empty composer for ${provider}`);
    return true;
  }

  // Menu/composer handlers frequently still read keyCode/which, so map the keys
  // we use to their real codes. Non-printing keys (Tab, arrows) don't emit a
  // keypress in real browsers — only Enter does — so we gate keypress on that.
  const KEY_CODES = {
    Enter: { code: 'Enter', keyCode: 13 },
    Tab: { code: 'Tab', keyCode: 9 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    Escape: { code: 'Escape', keyCode: 27 },
  };

  function dispatchKey(target, key, opts = {}) {
    const map = KEY_CODES[key] || { code: key, keyCode: 0 };
    const base = {
      key,
      code: map.code,
      keyCode: map.keyCode,
      which: map.keyCode,
      bubbles: true,
      cancelable: true,
      ...opts,
    };
    target.dispatchEvent(new KeyboardEvent('keydown', base));
    if (key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', base));
    target.dispatchEvent(new KeyboardEvent('keyup', base));
  }

  // ── submit ──────────────────────────────────────────────────────────────────
  // Prefer the provider's send button (most reliable); fall back to a bare Enter
  // on the focused composer. We do NOT watch for "the" POST — completion is the
  // extension's job, per the guardrail.
  function findSendButton(provider) {
    if (provider === 'chatgpt') {
      return (
        document.querySelector('[data-testid="send-button"]:not([disabled])') ||
        document.querySelector('button[aria-label*="Send" i]:not([disabled])')
      );
    }
    if (provider === 'claude') {
      return (
        document.querySelector('button[aria-label*="Send" i]:not([disabled])') ||
        document.querySelector('[data-testid="send-button"]:not([disabled])')
      );
    }
    if (provider === 'gemini') {
      return (
        document.querySelector('button.send-button:not([disabled])') ||
        document.querySelector('button[aria-label*="Send" i]:not([disabled])') ||
        document.querySelector('[data-testid="send-button"]:not([disabled])')
      );
    }
    return null;
  }

  async function submit(provider, composer) {
    const btn = await waitFor(() => findSendButton(provider), { timeoutMs: 4000, intervalMs: 200 });
    if (btn) {
      trace('submit: clicking send button');
      btn.click();
      return 'send_button';
    }
    trace('submit: no send button found, pressing Enter in composer');
    composer.focus();
    dispatchKey(composer, 'Enter');
    return 'enter_key';
  }

  // ── Deep-research confirm/start step ─────────────────────────────────────────
  // After a deep-research prompt is sent, Gemini and Claude show a plan first and
  // require a second click to actually start the research run:
  //   Gemini: a <button aria-label="Start research">
  //   Claude: a <button> whose text is "Confirm" (rendered "Confirm ⏎")
  // These appear only after the model responds (seconds later), so we POLL for the
  // button, then click it. They are real <button>s (not isTrusted-gated menu
  // items), so a synthetic .click() works from the content script. Searches the
  // light DOM + shadow roots (Gemini uses web components). ChatGPT has no such
  // step. Returns { clicked, found }.
  function deepCollect(root, acc) {
    for (const el of root.querySelectorAll('*')) {
      acc.push(el);
      if (el.shadowRoot) deepCollect(el.shadowRoot, acc);
    }
    return acc;
  }

  function findResearchConfirmButton(provider) {
    const all = deepCollect(document, []).filter(isVisible);
    if (provider === 'gemini') {
      return (
        all.find(
          (el) =>
            el.tagName === 'BUTTON' &&
            /^start research$/i.test(textOf(el.getAttribute('aria-label')))
        ) ||
        all.find(
          (el) =>
            (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') &&
            /^start research$/i.test(textOf(el.innerText || el.textContent))
        ) ||
        null
      );
    }
    if (provider === 'claude') {
      return (
        all.find(
          (el) => el.tagName === 'BUTTON' && /^confirm\b/i.test(textOf(el.innerText || el.textContent))
        ) || null
      );
    }
    return null; // chatgpt: no confirm step
  }

  // Poll up to timeoutMs for the confirm/start button, then click it.
  async function waitAndClickResearchConfirm(provider, { timeoutMs = 60000, intervalMs = 800 } = {}) {
    if (provider !== 'gemini' && provider !== 'claude') {
      return { clicked: false, found: false, note: 'no confirm step for provider' };
    }
    trace(`waiting for ${provider} research ${provider === 'gemini' ? 'Start research' : 'Confirm'} button (up to ${timeoutMs}ms)`);
    const btn = await waitFor(() => findResearchConfirmButton(provider), { timeoutMs, intervalMs });
    if (!btn) {
      trace(`${provider} confirm/start button never appeared`);
      return { clicked: false, found: false };
    }
    try {
      btn.click();
      trace(`${provider} research confirm/start: clicked "${textOf(btn.getAttribute('aria-label') || btn.innerText || btn.textContent).slice(0, 20)}"`);
      return { clicked: true, found: true };
    } catch (err) {
      trace(`${provider} confirm/start click threw: ${err && err.message}`);
      return { clicked: false, found: true, error: String(err && err.message ? err.message : err) };
    }
  }

  // ── enableDeepResearch ───────────────────────────────────────────────────────
  // ChatGPT: tools "+" menu → "Deep research". Claude: "+" menu → "Research".
  // Gemini: mode pill in the prompt bar / "More tools" (NOT the uploads "+").
  // Best-effort: open the tools menu, click the matching item. Returns true if a
  // matching control was clicked.
  async function clickMenuTrigger(provider) {
    const triggerSelectors =
      provider === 'gemini'
        ? ['button[aria-label*="tools" i]', 'button[aria-label*="More" i]', 'toolbox-drawer button', 'button[aria-label*="mode" i]']
        : ['button[aria-label*="tools" i]', 'button[aria-label*="Add" i]', '[data-testid="composer-plus-btn"]', 'button[aria-label*="Attach" i]'];
    for (const sel of triggerSelectors) {
      const el = Array.from(document.querySelectorAll(sel)).find(isVisible);
      if (el) {
        el.click();
        await sleep(400);
        return true;
      }
    }
    return false;
  }

  async function clickMenuItemMatching(pattern) {
    const item = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a'))
          .filter(isVisible)
          .find((el) => pattern.test(textOf(el.getAttribute('aria-label') || el.innerText || el.textContent))),
      { timeoutMs: 4000, intervalMs: 200 }
    );
    if (item) {
      item.click();
      await sleep(300);
      return true;
    }
    return false;
  }

  // Click a menu entry by its EXACT visible label. Built for the ChatGPT "+"
  // menu, whose rows are plain <div>/<span> (no role="menuitem", no testid) — see
  // the live DOM. We:
  //   - match the leaf element whose trimmed text === the label (exact, so it
  //     never catches sidebar conversation titles like "Deep research request"),
  //   - exclude anything inside the left sidebar/nav (conversation list),
  //   - climb to the nearest clickable ancestor and click it.
  async function clickExactMenuItem(labelExact) {
    const wanted = labelExact.trim().toLowerCase();
    const inSidebar = (el) => !!el.closest('nav, aside, [class*="sidebar" i], #history, [data-testid*="conversation" i]');
    const findLeaf = () =>
      Array.from(document.querySelectorAll('div, span, a, button, [role="menuitem"], [role="option"]'))
        .filter(isVisible)
        .filter((el) => el.children.length === 0) // leaf text node only
        .filter((el) => textOf(el.innerText || el.textContent).toLowerCase() === wanted)
        .find((el) => !inSidebar(el));
    const leaf = await waitFor(findLeaf, { timeoutMs: 4000, intervalMs: 150 });
    if (!leaf) return false;
    // Climb to a clickable row (max 6 hops): something with a role, or a
    // cursor-pointer, or just the leaf itself as a last resort.
    let row = leaf;
    for (let i = 0; i < 6 && row.parentElement; i += 1) {
      const role = row.getAttribute && row.getAttribute('role');
      if (role === 'menuitem' || role === 'menuitemradio' || role === 'option' || role === 'button') break;
      const cursor = (() => { try { return window.getComputedStyle(row).cursor; } catch (_) { return ''; } })();
      if (cursor === 'pointer') break;
      row = row.parentElement;
    }
    (row || leaf).click();
    await sleep(350);
    return true;
  }

  // Dispatch a key event to the element that currently has focus (the page's
  // menus use roving focus + keydown handlers, so we must target activeElement,
  // not a fixed node). Mirrors how a real keyboard event flows.
  function pressKeyGlobal(key, opts = {}) {
    const target = document.activeElement || document.body;
    dispatchKey(target, key, opts);
  }

  // ── Deep-research "is it actually on?" verification ──────────────────────────
  // Clicking/whatever is only "worked" if the mode visibly engaged. For ChatGPT
  // that's a "Deep research" chip in the composer; for Gemini a selected mode
  // pill; for Claude a "Research"/"Deep research" toggle showing active. We check
  // a broad set so a single DOM rename doesn't silently report success.
  function deepResearchEngaged(provider) {
    if (provider === 'chatgpt') {
      // The engaged state shows a "Deep research" chip rendered as a plain
      // accent-colored <span>/<div> INSIDE the composer form (not a <button>),
      // and ChatGPT also shows a "lighter version of deep research" quota banner.
      // Verified against the live DOM. (The old button/role/testid-only check
      // missed the chip entirely and reported false negatives.)
      const chipInComposer = Array.from(document.querySelectorAll('form span, form div, form p, form button'))
        .filter(isVisible)
        .filter((el) => el.children.length === 0)
        .some((el) => /^deep research$/i.test(textOf(el.innerText || el.textContent)));
      if (chipInComposer) return true;
      const quotaBanner = Array.from(document.querySelectorAll('*'))
        .filter(isVisible)
        .some((el) => el.children.length === 0 && /lighter version of deep research/i.test(textOf(el.textContent)));
      return quotaBanner;
    }
    if (provider === 'gemini') {
      return Array.from(document.querySelectorAll('[aria-pressed="true"], [aria-checked="true"], .is-selected, [class*="selected" i]'))
        .filter(isVisible)
        .some((el) => /deep research/i.test(textOf(el.getAttribute('aria-label') || el.innerText || el.textContent)));
    }
    if (provider === 'claude') {
      return Array.from(document.querySelectorAll('[aria-pressed="true"], [aria-checked="true"], button'))
        .filter(isVisible)
        .some((el) => {
          const pressed = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
          return pressed && /\bresearch\b/i.test(textOf(el.getAttribute('aria-label') || el.innerText || el.textContent));
        });
    }
    return false;
  }

  // ── Keyboard-driven menu selection (preferred for ChatGPT) ───────────────────
  // Clicking a menu item is fragile: items are virtualized, icon+label, sometimes
  // role="menuitemradio", and the submenu may not be hit-testable when we click.
  // Driving the page's OWN menu handlers via the keyboard is far more robust.
  //
  // Strategy: open the tools menu (Shift+Tab to the composer's leading "+"/tools
  // button cluster, then Enter — matching the manual sequence), then ArrowDown
  // through the menu, checking the focused item's text against `pattern`. When it
  // matches, Enter. This adapts to menu reordering (no hard-coded arrow count),
  // unlike a fixed "Down x4".
  async function openToolsMenuViaKeyboard(provider, composer) {
    composer.focus();
    await sleep(80);
    // Shift+Tab walks backward from the composer to the toolbar buttons; one or
    // two presses typically lands on the tools/"+" trigger.
    pressKeyGlobal('Tab', { shiftKey: true });
    await sleep(120);
    const active = document.activeElement;
    const looksLikeTrigger =
      active &&
      /\b(tools?|add|attach|more)\b/i.test(textOf(active.getAttribute('aria-label') || active.innerText || active.textContent));
    if (!looksLikeTrigger) {
      // Second hop in case the first Shift+Tab landed on the send button cluster.
      pressKeyGlobal('Tab', { shiftKey: true });
      await sleep(120);
    }
    pressKeyGlobal('Enter');
    await sleep(350);
    return Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]')).some(isVisible);
  }

  // ChatGPT's "+" menu has a search/filter input. The most reliable selection is
  // to type the item name into it and press Enter — sidesteps fragile synthetic
  // arrow navigation (which often doesn't move ChatGPT's focus). We find the
  // filter input (focused input, or any text input inside an open menu/listbox),
  // type via the native input pipeline, let it filter, then Enter.
  function findMenuFilterInput() {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.getAttribute('contenteditable') === 'true')) {
      return a;
    }
    const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')).filter(isVisible);
    for (const menu of menus) {
      const input = menu.querySelector('input[type="text"], input:not([type]), input[role="combobox"], [contenteditable="true"]');
      if (input && isVisible(input)) return input;
    }
    // Fallback: any visible search-ish input on the page (the menu may portal out).
    return (
      Array.from(document.querySelectorAll('input[placeholder*="search" i], input[aria-label*="search" i], input[role="combobox"]'))
        .find(isVisible) || null
    );
  }

  async function typeIntoMenuFilterAndSelect(text, pattern) {
    const input = await waitFor(() => findMenuFilterInput(), { timeoutMs: 2500, intervalMs: 150 });
    if (!input) { trace('menu filter input NOT found'); return false; }
    trace(`menu filter input found: <${input.tagName.toLowerCase()}> placeholder="${textOf(input.getAttribute('placeholder'))}"`);
    input.focus();
    await sleep(80);
    // Native input pipeline (same approach setInput uses), then dispatch input.
    try {
      const inserted = document.execCommand('insertText', false, text);
      if (!inserted) {
        if ('value' in input) input.value = text;
        else input.textContent = text;
      }
    } catch (_) {
      if ('value' in input) input.value = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(450); // let the menu filter down to the matching item

    const matchCount = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]'))
      .filter(isVisible)
      .filter((el) => pattern.test(textOf(el.getAttribute('aria-label') || el.innerText || el.textContent))).length;
    trace(`typed "${text}" into filter; ${matchCount} matching item(s) visible, about to press Enter ONCE on the input`);

    // The filter input is focused, so a single Enter selects the top filtered
    // item. We press Enter EXACTLY ONCE, targeted at the filter input itself, and
    // immediately stop — no ArrowDown, no second Enter. A second Enter (or an
    // Enter after the menu has closed) lands in the composer and submits, which
    // is the "it reopened + and sent" bug. Target the input explicitly so the
    // key never reaches the composer even if focus has already shifted.
    input.focus();
    dispatchKey(input, 'Enter');
    await sleep(350);
    return true;
  }

  async function selectMenuItemViaKeyboard(pattern, { maxSteps = 12 } = {}) {
    const focusedItemText = () => {
      const a = document.activeElement;
      if (!a) return '';
      return textOf(a.getAttribute('aria-label') || a.innerText || a.textContent);
    };
    // If a submenu is needed (some builds nest "Deep research" under a parent),
    // ArrowRight opens it; harmless if not.
    for (let i = 0; i < maxSteps; i += 1) {
      const txt = focusedItemText();
      if (pattern.test(txt)) {
        pressKeyGlobal('Enter');
        await sleep(300);
        return true;
      }
      pressKeyGlobal('ArrowDown');
      await sleep(140);
    }
    return false;
  }

  // The user's confirmed manual sequence for ChatGPT, kept as an explicit
  // fallback: Shift+Tab -> Enter -> ArrowDown x4 -> Enter. Brittle to menu
  // reordering, so it's last and we verify after.
  async function chatgptFixedSequence(composer) {
    composer.focus();
    await sleep(80);
    pressKeyGlobal('Tab', { shiftKey: true });
    await sleep(150);
    pressKeyGlobal('Enter'); // open tools menu
    await sleep(350);
    for (let i = 0; i < 4; i += 1) {
      pressKeyGlobal('ArrowDown');
      await sleep(140);
    }
    pressKeyGlobal('Enter'); // select Deep research
    await sleep(300);
  }

  async function enableDeepResearch(provider, composer) {
    const label =
      provider === 'claude' ? /\bresearch\b/i : /deep research/i;

    // 0) Already engaged? (e.g. a sticky mode or a visible selected pill.)
    if (deepResearchEngaged(provider)) { trace('DR already engaged before we started'); return true; }

    // Close any open menu/popup so no stray key reaches the composer, then settle.
    const dismissMenusAndSettle = async () => {
      let escapes = 0;
      for (let i = 0; i < 3 && menuIsOpen(); i += 1) {
        pressKeyGlobal('Escape');
        escapes += 1;
        await sleep(120);
      }
      await sleep(120);
      trace(`dismissMenusAndSettle: pressed Escape x${escapes}, menuOpen=${menuIsOpen()}`);
    };

    // 1) ChatGPT — KEYBOARD-ONLY EXPERIMENT (exactly what the user asked to see):
    //    Tab -> wait -> Tab -> wait -> Enter, and NOTHING else afterward. No
    //    clicking, no extra keys, no fallbacks. Logs document.activeElement after
    //    each step so we can watch where focus goes. These are synthetic events
    //    (the content script cannot send trusted input); this is a pure
    //    observation run.
    if (provider === 'chatgpt' && composer) {
      const activeDesc = () => {
        const a = document.activeElement;
        if (!a) return 'none';
        return `${a.tagName}[${textOf(a.getAttribute('aria-label') || a.innerText || a.textContent).slice(0, 30)}]`;
      };
      composer.focus();
      await sleep(200);
      trace(`KBD start: active=${activeDesc()} composer="${composerText(composer)}"`);

      pressKeyGlobal('Tab');
      await sleep(400);
      trace(`KBD after Tab #1: active=${activeDesc()} menuOpen=${menuIsOpen()}`);

      pressKeyGlobal('Tab');
      await sleep(400);
      trace(`KBD after Tab #2: active=${activeDesc()} menuOpen=${menuIsOpen()}`);

      pressKeyGlobal('Enter');
      await sleep(500);
      trace(`KBD after Enter: active=${activeDesc()} menuOpen=${menuIsOpen()} DR=${deepResearchEngaged(provider)} composer="${composerText(composer)}"`);

      // STOP HERE — no clicking, no fallbacks (per the user's request to see the
      // keyboard-only result in isolation).
      const engaged = deepResearchEngaged(provider);
      trace(`KBD sequence done. DR engaged=${engaged}`);
      return engaged;
    }

    // ── Non-ChatGPT providers keep the existing menu-click paths ────────────────

    // 2) Directly-visible mode pill/chip (Gemini shows one in the bar).
    if (!deepResearchEngaged(provider) && (await clickMenuItemMatching(label))) {
      if (deepResearchEngaged(provider) || provider === 'gemini') { trace('engaged via visible pill/click'); await dismissMenusAndSettle(); return true; }
    }

    // 3) Generic: open the tools menu and click the matching item (Claude/Gemini).
    if (!deepResearchEngaged(provider)) {
      trace('trying click-trigger + click-item fallback');
      await clickMenuTrigger(provider);
      if (await clickMenuItemMatching(label)) {
        if (deepResearchEngaged(provider) || provider !== 'chatgpt') { trace('engaged via menu click fallback'); await dismissMenusAndSettle(); return true; }
      }
    }

    await dismissMenusAndSettle();
    console.warn(`${LOG_PREFIX} deep-research not confirmed engaged for ${provider}`);
    return false;
  }

  // ── Orchestrated drive ───────────────────────────────────────────────────────
  // modeOnly: enable deep-research and STOP — no typing, no submit. For testing
  // the toggle in isolation (--deep-research-on).
  async function drive({ prompt, deepResearch, modeOnly }) {
    const provider = providerId();
    if (provider === 'unknown') throw new Error('unsupported host for driver');
    if (!modeOnly && (typeof prompt !== 'string' || !prompt.trim())) {
      throw new Error('prompt is required');
    }

    trace(`drive start: provider=${provider} deepResearch=${!!deepResearch} modeOnly=${!!modeOnly}`);
    const composer = await focusComposer(provider);
    trace(`composer focused; initial composer="${composerText(composer)}"`);

    let deepResearchEnabled = false;
    if (deepResearch || modeOnly) {
      // Enable the mode BEFORE typing so the submit goes to the research pipeline.
      deepResearchEnabled = await enableDeepResearch(provider, composer);
      // Re-focus: opening menus can blur the composer.
      await focusComposer(provider);
      trace(`after enableDeepResearch: enabled=${deepResearchEnabled}, composer="${composerText(composer)}", menuOpen=${menuIsOpen()}`);
    }

    if (modeOnly) {
      // Verify-and-stop: report whether the mode actually engaged. Nothing sent.
      trace(`modeOnly: stopping here. DR enabled=${deepResearchEnabled}. (nothing typed/sent)`);
      return {
        ok: deepResearchEnabled,
        provider,
        submitMethod: 'none',
        modeOnly: true,
        deepResearchRequested: true,
        deepResearchEnabled,
      };
    }

    // Guard against the deep-research step having left a stray character or
    // submitted prematurely: re-focus and clear the composer so we never type the
    // prompt AFTER an accidental submit (the "prompt pasted after Enter" bug).
    await focusComposer(provider);
    const cleared = await clearComposer(composer);
    trace(`pre-type clear: composerEmpty=${cleared}, composer="${composerText(composer)}"`);
    await setInput(provider, composer, prompt);
    trace(`after setInput: composer="${composerText(composer).slice(0, 60)}..." (len ${composerText(composer).length})`);
    const submitMethod = await submit(provider, composer);
    trace(`submitted via ${submitMethod}`);

    return { ok: true, provider, submitMethod, deepResearchRequested: !!deepResearch, deepResearchEnabled };
  }

  // ── Geometry for the chrome.debugger trusted-input path ──────────────────────
  // The background's debugger DR-toggle needs viewport coordinates for trusted
  // clicks (synthetic clicks are ignored by the menus). We locate the tools/"+"
  // button (and, for Gemini, the deep-research mode pill) and return their center
  // coordinates. Returns null pieces if not found.
  function centerOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  function toolsButtonEl(provider) {
    const selectors =
      provider === 'gemini'
        ? ['button[aria-label*="tools" i]', 'button[aria-label*="More" i]', 'toolbox-drawer button', 'button[aria-label*="mode" i]']
        : [
            'button[aria-label*="Add files and more" i]',
            'button[aria-label*="tools" i]',
            'button[aria-label*="Add" i]',
            '[data-testid="composer-plus-btn"]',
            'button[aria-label*="Attach" i]',
          ];
    for (const sel of selectors) {
      const el = Array.from(document.querySelectorAll(sel)).find(isVisible);
      if (el) return el;
    }
    return null;
  }

  function geminiDeepResearchPillEl() {
    return (
      Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .find((el) => /deep research/i.test(textOf(el.getAttribute('aria-label') || el.innerText || el.textContent))) || null
    );
  }

  function driverGeometry(provider) {
    const tools = centerOf(toolsButtonEl(provider));
    const out = { ok: true, toolsButton: tools };
    if (provider === 'gemini') out.deepResearchPill = centerOf(geminiDeepResearchPillEl());
    return out;
  }

  // ── Command listener (the only always-on surface) ────────────────────────────
  // Inert unless the driver flag is set. Background relays CHAT_DRIVE here, plus
  // DRIVER_GEOMETRY / CHECK_DEEP_RESEARCH used by the debugger DR-toggle path.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'FOCUS_COMPOSER') {
      (async () => {
        if (!(await isDriverEnabled())) { sendResponse({ ok: false, error: 'driver disabled' }); return; }
        try {
          const composer = await focusComposer(message.provider || providerId());
          sendResponse({ ok: !!composer });
        } catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
      })();
      return true;
    }
    if (message && message.type === 'CONFIRM_RESEARCH') {
      (async () => {
        if (!(await isDriverEnabled())) { sendResponse({ ok: false, error: 'driver disabled' }); return; }
        try {
          const res = await waitAndClickResearchConfirm(message.provider || providerId(), {
            timeoutMs: message.timeoutMs || 60000,
          });
          sendResponse({ ok: !!res.clicked, ...res });
        } catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
      })();
      return true;
    }
    if (message && message.type === 'ACTIVE_ELEMENT') {
      (async () => {
        if (!(await isDriverEnabled())) { sendResponse({ ok: false, error: 'driver disabled' }); return; }
        try {
          const a = document.activeElement;
          sendResponse({
            ok: true,
            tag: a ? a.tagName : 'none',
            ariaLabel: a ? textOf(a.getAttribute('aria-label')) : '',
            text: a ? textOf(a.innerText || a.textContent).slice(0, 40) : '',
            testId: a ? textOf(a.getAttribute('data-testid')) : '',
            role: a ? textOf(a.getAttribute('role')) : '',
            isComposer: !!(a && a.closest && a.closest('.ProseMirror, [contenteditable="true"]')),
          });
        } catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
      })();
      return true;
    }
    if (message && message.type === 'DRIVER_GEOMETRY') {
      (async () => {
        if (!(await isDriverEnabled())) { sendResponse({ ok: false, error: 'driver disabled' }); return; }
        try { sendResponse(driverGeometry(message.provider || providerId())); }
        catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); }
      })();
      return true;
    }
    if (message && message.type === 'CHECK_DEEP_RESEARCH') {
      (async () => {
        if (!(await isDriverEnabled())) { sendResponse({ engaged: false, error: 'driver disabled' }); return; }
        try { sendResponse({ engaged: deepResearchEngaged(message.provider || providerId()) }); }
        catch (err) { sendResponse({ engaged: false, error: String(err && err.message ? err.message : err) }); }
      })();
      return true;
    }
    if (!message || message.type !== 'CHAT_DRIVE') return false;
    (async () => {
      try {
        if (!(await isDriverEnabled())) {
          sendResponse({ ok: false, error: 'driver disabled (taskAppChatWatchDriver flag off)' });
          return;
        }
        const result = await drive({
          prompt: message.prompt,
          deepResearch: !!message.deepResearch,
          modeOnly: !!message.modeOnly,
        });
        console.log(`${LOG_PREFIX} drove ${result.provider} via ${result.submitMethod} (modeOnly=${!!result.modeOnly}, deepResearch=${result.deepResearchEnabled})`);
        sendResponse(result);
      } catch (err) {
        console.warn(`${LOG_PREFIX} drive failed:`, err && err.message ? err.message : err);
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true; // async response
  });

  // Test/manual hook: window.__orchestraDrive({prompt, deepResearch}) — still
  // honors the flag, so it's inert in normal use.
  window.__orchestraDrive = async (opts) => {
    if (!(await isDriverEnabled())) {
      console.warn(`${LOG_PREFIX} driver disabled; set the taskAppChatWatchDriver flag to use it.`);
      return { ok: false, error: 'driver disabled' };
    }
    return drive(opts || {});
  };
})();
