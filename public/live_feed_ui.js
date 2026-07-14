/*
 * live_feed_ui.js — the Phase-2b live-feed UI: row cell (L0 strips), manual L1 card,
 * L2 history, plain/live toggle, delta-cursor polling, count-up ticker.
 *
 * Loadable BOTH ways (the live_feed_derive.js precedent):
 *   - browser: <script src="live_feed_ui.js"> → window.LiveFeedUI (init() wires it to app.js)
 *   - node:    const LiveFeedUI = require('../public/live_feed_ui');  (pure helpers + builders)
 *
 * Contract highlights (AUTHORITATIVE SPEC):
 *   - Plain mode = today's UI byte-identical: app.js appends NO cell DOM unless live mode is on
 *     for the project; this module never polls in plain mode.
 *   - Hidden beats live: app.js gates the cell on the same progressHidden flag as the pill; a
 *     hidden row gets no cell at all.
 *   - The PILL stays the interaction point. The cell is display-only + `open ▸` (history) —
 *     clicking the cell toggles the L1 card; NOTHING auto-expands (needs-input and done included).
 *   - DATA HONESTY: render at the served tier; an absent module is an absent line — no
 *     placeholder text, ever. The register line is the ONLY tier-gated line (tier >= 1);
 *     everything else renders iff the data is actually present.
 *   - Fail-safe polling: an endpoint error leaves the cells exactly as they were.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveFeedUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIVE_MODE_KEY_PREFIX = 'orchestra.live-mode.';
  var HOLD_MS = 2000;

  /* ------------------------------------------------------------------ mode persistence */

  function liveModeStorageKey(projectId) {
    return LIVE_MODE_KEY_PREFIX + String(projectId || '');
  }

  /** Per-project mode, default 'plain'. `storage` is localStorage-shaped. */
  function readLiveMode(storage, projectId) {
    if (!storage || !projectId) return 'plain';
    try {
      var raw = storage.getItem(liveModeStorageKey(projectId));
      return raw === 'live' ? 'live' : 'plain';
    } catch (err) {
      return 'plain';
    }
  }

  function writeLiveMode(storage, projectId, mode) {
    if (!storage || !projectId) return;
    try {
      storage.setItem(liveModeStorageKey(projectId), mode === 'live' ? 'live' : 'plain');
    } catch (err) {
      /* preference still applies for this session */
    }
  }

  /* ------------------------------------------------------------------ tracked predicate */

  /**
   * The tracking binding a live cell keys off — mirrors lib/live_feed_service.js
   * liveFeedWatchBinding (active > paused > finished re-arm binding). A task with no binding is
   * untracked: no cell, empty leftover space.
   */
  function taskLiveBinding(task) {
    if (!task || typeof task !== 'object') return null;
    return (
      task.watch_tracking ||
      task.cursor_tracking ||
      task.paused_watch_tracking ||
      (task.watch_finished ? task.completed_watch_tracking || null : null)
    );
  }

  function projectHasTrackedTasks(project) {
    var tasks = (project && project.tasks) || [];
    for (var i = 0; i < tasks.length; i++) {
      if (taskLiveBinding(tasks[i])) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ bot mapping */

  /** Orchestra provider_kind → pixel-bot character. ChatGPT/openai reuse codex by design. */
  function botCharacterFor(providerKind) {
    var kind = String(providerKind || '');
    if (kind === 'openai' || kind === 'codex' || kind === 'chatgpt') return 'codex';
    if (kind === 'gemini') return 'gemini';
    if (kind === 'cursor') return 'cursor';
    if (kind === 'grok' || kind === 'xai') return 'grok';
    if (kind === 'process' || kind === 'terminal') return 'terminal';
    return 'claude';
  }

  /** Served live state → pixel-bot state attribute. */
  function botStateFor(state) {
    if (state === 'working' || state === 'blocked' || state === 'done' || state === 'idle') return state;
    return 'idle';
  }

  /**
   * Fallback state from the task's own /api/state fields for the beat between a live toggle and
   * the first feed poll — the same mapping as app.js taskAgentStateClass (fl-* classes).
   */
  function taskFallbackState(task) {
    if (!task) return 'idle';
    var finished = task.status === 'todo' && !!task.watch_finished;
    if (finished && task.watch_finished.needs_input) return 'blocked';
    if (finished) return 'done';
    if (task.status === 'waiting') return 'working';
    return 'idle';
  }

  /* ------------------------------------------------------------------ formatting */

  /** M:SS (H:MM:SS above an hour). null/negative-safe. */
  function formatClock(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var total = Math.max(0, Math.floor(ms / 1000));
    var s = total % 60;
    var m = Math.floor(total / 60) % 60;
    var h = Math.floor(total / 3600);
    var mm = h > 0 && m < 10 ? '0' + m : String(m);
    var ss = s < 10 ? '0' + s : String(s);
    return h > 0 ? h + ':' + mm + ':' + ss : m + ':' + ss;
  }

  /** Count-up seconds for the register suffix: `8s`, `1:12` past a minute. */
  function formatCountUp(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    return formatClock(ms);
  }

  /** Settled register suffix: `3s ago`, `2m ago`. */
  function formatAgo(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  /** `3 tools` / `1 tool` (empty for 0 — no noise on rows with no tool flow). */
  function formatToolCount(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
    return n === 1 ? '1 tool' : n + ' tools';
  }

  /**
   * The coral strip's headline: STOPPED — {N QUESTIONS | QUESTION | PERMISSION | NEEDS INPUT}.
   * `NEEDS INPUT` is the honest fallback when the gate kind is unknown (matches the generic pill).
   */
  function stoppedLabel(gateKind, questionCount) {
    if (gateKind === 'permission') return 'PERMISSION';
    if (gateKind === 'question') {
      return questionCount > 1 ? questionCount + ' QUESTIONS' : 'QUESTION';
    }
    return 'NEEDS INPUT';
  }

  /* ------------------------------------------------------------------ event picking */

  function lastEventOfKind(events, kind) {
    var list = Array.isArray(events) ? events : [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].kind === kind) return list[i];
    }
    return null;
  }

  /** The one-line preview of an open gate: first question text, else the gated command. */
  function gateFirstLine(open) {
    if (!open) return '';
    if (Array.isArray(open.questions) && open.questions.length && open.questions[0].question) {
      return open.questions[0].question;
    }
    if (typeof open.command === 'string' && open.command) return open.command;
    return '';
  }

  function gateQuestionCount(open) {
    return open && Array.isArray(open.questions) ? open.questions.length : 0;
  }

  /* ------------------------------------------------------------------ feed store */

  /**
   * Client-side per-task buffer + delta-cursor bookkeeping over GET /api/projects/:id/live-feed.
   * Pure data (no DOM): applyResponse merges a payload; sinceParam() builds the next cursor.
   * Rules (probe contract): `reset:true` or a changed `turn_id` ⇒ drop the local buffer and
   * rebuild from the returned events; otherwise append events with seq beyond our head.
   */
  function createFeedStore() {
    var entries = new Map();

    function applyResponse(payload, receivedAtMs) {
      var changed = [];
      if (!payload || !Array.isArray(payload.tasks)) return { changed: changed };
      for (var i = 0; i < payload.tasks.length; i++) {
        var row = payload.tasks[i];
        if (!row || !row.task_id) continue;
        var entry = entries.get(row.task_id);
        var isNew = !entry;
        if (isNew) {
          entry = {
            task_id: row.task_id,
            turn_id: -1,
            base_seq: 0,
            head_seq: -1,
            events: [],
            state: null,
            gate_kind: null,
            tier: 0,
            provider: '',
            surface: '',
            lifecycle: {},
            server_now: 0,
            received_at: 0,
            register: null,
            turn_flipped: false
          };
          entries.set(row.task_id, entry);
        }
        var turnFlip = row.reset === true || row.turn_id !== entry.turn_id;
        var evAdded = false;
        var incoming = Array.isArray(row.events) ? row.events : [];
        if (isNew || turnFlip) {
          entry.events = incoming.slice();
          evAdded = incoming.length > 0 || entry.events.length !== 0 || isNew;
          entry.turn_flipped = !isNew; // renderer resets the register on a real flip
          if (entry.register && !isNew) entry.register.reset();
        } else {
          for (var j = 0; j < incoming.length; j++) {
            var ev = incoming[j];
            if (!ev || typeof ev.seq !== 'number') continue;
            if (ev.seq <= entry.head_seq) continue;
            entry.events.push(ev);
            evAdded = true;
          }
        }
        var stateChanged =
          entry.state !== row.state ||
          entry.gate_kind !== (row.gate_kind || null) ||
          stopTextOf(entry.lifecycle) !== stopTextOf(row.lifecycle) ||
          waitingSinceOf(entry.lifecycle) !== waitingSinceOf(row.lifecycle);
        entry.turn_id = row.turn_id;
        entry.base_seq = row.base_seq;
        entry.head_seq = typeof row.head_seq === 'number' ? row.head_seq : entry.head_seq;
        entry.state = row.state;
        entry.gate_kind = row.gate_kind || null;
        entry.tier = typeof row.tier === 'number' ? row.tier : 0;
        entry.provider = row.provider || entry.provider;
        entry.surface = row.surface || entry.surface;
        entry.lifecycle = row.lifecycle || {};
        entry.server_now = typeof payload.now === 'number' ? payload.now : entry.server_now;
        entry.received_at = receivedAtMs;
        if (isNew || turnFlip || evAdded || stateChanged) changed.push(row.task_id);
      }
      return { changed: changed };
    }

    function stopTextOf(lc) { return (lc && lc.stop_text) || null; }
    function waitingSinceOf(lc) { return (lc && lc.waiting_since) || null; }

    function sinceParam() {
      var map = {};
      var any = false;
      entries.forEach(function (entry, taskId) {
        if (entry.head_seq >= 0) {
          map[taskId] = entry.head_seq;
          any = true;
        }
      });
      return any ? map : null;
    }

    return {
      applyResponse: applyResponse,
      sinceParam: sinceParam,
      entry: function (taskId) { return entries.get(taskId) || null; },
      drop: function (taskId) { entries.delete(taskId); },
      clear: function () { entries.clear(); },
      size: function () { return entries.size; }
    };
  }

  /**
   * Turn-relative "now" for an entry (drives the register + elapsed count-ups): the served
   * lifecycle.elapsed_ms is the server baseline at receipt; the client counts up from there.
   * Without a baseline (lifecycle-only rows), the newest event t anchors the clock.
   */
  function turnNowMs(entry, nowMs) {
    if (!entry) return 0;
    var base = 0;
    if (entry.lifecycle && typeof entry.lifecycle.elapsed_ms === 'number') {
      base = entry.lifecycle.elapsed_ms;
    } else if (entry.events.length) {
      var last = entry.events[entry.events.length - 1];
      base = typeof last.t === 'number' ? last.t : 0;
    }
    var delta = entry.received_at ? Math.max(0, nowMs - entry.received_at) : 0;
    return base + delta;
  }

  /* ------------------------------------------------------------------ cell model (pure) */

  /**
   * Everything the DOM builder needs, computed as plain data (fully unit-testable).
   * `ui` = { expanded, history } for this task (manual only — nothing here auto-expands).
   */
  function buildCellModel(task, entry, ui, nowMs, derive) {
    var binding = taskLiveBinding(task);
    if (!binding) return null;
    var uiState = ui || {};
    var lc = (entry && entry.lifecycle) || {};
    var events = (entry && entry.events) || [];
    var state = entry && entry.state ? entry.state : taskFallbackState(task);
    var provider = (task && task.provider_kind) || (entry && entry.provider) || '';
    var surface = (task && task.surface_kind) || (entry && entry.surface) || '';
    var tier = entry ? entry.tier : 0;
    var gateKind = entry && entry.gate_kind ? entry.gate_kind : (task.watch_finished && task.watch_finished.gate_kind) || null;

    var model = {
      taskId: task.id,
      state: state,
      level: uiState.expanded ? 1 : 0, // MANUAL only; needs-input and done stay strips
      history: !!(uiState.expanded && uiState.history),
      botProvider: botCharacterFor(provider),
      botState: botStateFor(state),
      browser: surface === 'browser',
      botScale: uiState.expanded ? 3 : 2,
      hasEvents: events.length > 0,
      register: null,
      metaElapsedText: null,
      metaRestText: null,
      strip: null,
      done: null,
      l1: null,
      todo: null,
      contextNote: null,
      foot: null,
      historyModel: null
    };

    var elapsedNow = null;
    if (typeof lc.elapsed_ms === 'number') {
      elapsedNow = state === 'done' ? lc.elapsed_ms : lc.elapsed_ms + (entry && entry.received_at ? Math.max(0, nowMs - entry.received_at) : 0);
    }
    var toolsText = formatToolCount(lc.tool_count);
    var groupedMeta = null;

    // The register line is the ONLY tier-gated line (tier >= 1) — claude ships tier 0 today, so
    // its working strip shows just the meta line even though tool_end events flow.
    if (state === 'working' && tier >= 1 && derive && entry) {
      if (!entry.register) entry.register = derive.createActivityRegister({ holdMs: HOLD_MS });
      if (entry.turn_flipped) {
        entry.register.reset();
        entry.turn_flipped = false;
      }
      var tNow = turnNowMs(entry, nowMs);
      var view = entry.register.update(events, tNow);
      if (view && view.name) {
        model.register = {
          text: view.detail ? view.name + ' · ' + view.detail : view.name,
          running: !!view.running,
          suffix: view.running
            ? formatCountUp(tNow - (typeof view.started_t === 'number' ? view.started_t : tNow))
            : formatAgo(tNow - (typeof view.settled_t === 'number' ? view.settled_t : tNow)),
          switched: !!view.switched
        };
      }
    }

    if (state === 'working') {
      model.metaElapsedText = elapsedNow != null ? formatClock(elapsedNow) : null;
      var rest = [];
      if (toolsText) rest.push(toolsText);
      if (lc.model) rest.push(lc.model);
      model.metaRestText = rest.length ? rest.join(' · ') : null;
    } else if (state === 'blocked') {
      var open = lastEventOfKind(events, 'gate_open');
      var waitingMs = lc.waiting_since ? Math.max(0, nowMs - Date.parse(lc.waiting_since)) : null;
      model.strip = {
        label: 'STOPPED — ' + stoppedLabel(gateKind, gateQuestionCount(open)),
        waitText: waitingMs != null && isFinite(waitingMs) ? formatClock(waitingMs) : null,
        firstLine: gateFirstLine(open) || null
      };
    } else if (state === 'done') {
      model.done = {
        label: 'DONE' + (elapsedNow != null ? ' · ' + formatClock(elapsedNow) : ''),
        text: lc.stop_text || null
      };
      var doneRest = [];
      if (toolsText) doneRest.push(toolsText);
      if (lc.model) doneRest.push(lc.model);
      model.metaRestText = doneRest.length ? doneRest.join(' · ') : null;
    }

    // Collapsed status chip (L0): the compact split pill [ bot · dot · label · timer | caret ].
    // label carries the state; the timer is a live-ticked M:SS (elapsed while working/done, waiting
    // while blocked). The dot pulses while the agent is live (working / needs-input) and holds on done.
    model.chipLabel = state === 'blocked' ? 'Needs input' : state === 'done' ? 'Done' : 'Working';
    model.chipPulse = state === 'working' || state === 'blocked';
    if (state === 'blocked') {
      model.chipTimerText = (model.strip && model.strip.waitText) || null;
      model.chipTimerKind = 'wait';
    } else {
      model.chipTimerText = elapsedNow != null ? formatClock(elapsedNow) : null;
      model.chipTimerKind = 'elapsed';
    }

    if (uiState.expanded) {
      model.l1 = buildL1Model(state, gateKind, events, lc, nowMs, entry);
      var todoEv = lastEventOfKind(events, 'todo');
      if (state === 'working' && todoEv && typeof todoEv.total === 'number' && todoEv.total > 0) {
        model.todo = {
          done: typeof todoEv.done === 'number' ? todoEv.done : 0,
          total: todoEv.total,
          active: todoEv.active || ''
        };
      }
      var note = String((task && task.context_note) || '').trim();
      if (note) model.contextNote = note;

      if (model.history && derive) {
        var grouped = derive.groupFeedEvents(events);
        groupedMeta = grouped.meta;
        model.historyModel = buildHistoryModel(grouped, gateKind);
      }

      var footModel = (groupedMeta && groupedMeta.model) || lc.model || null;
      var footParts = [];
      if (elapsedNow != null) footParts.push(formatClock(elapsedNow));
      if (toolsText) footParts.push(toolsText);
      model.foot = {
        model: footModel,
        metaText: footParts.length ? footParts.join(' · ') : null,
        historyLabel: model.history ? 'hide history' : 'history ▸',
        showHistoryButton: model.hasEvents
      };
    }

    return model;
  }

  /** State-dependent L1 card body (manual expand only). */
  function buildL1Model(state, gateKind, events, lc, nowMs, entry) {
    if (state === 'blocked') {
      var open = lastEventOfKind(events, 'gate_open');
      var waitingMs = lc.waiting_since ? Math.max(0, nowMs - Date.parse(lc.waiting_since)) : null;
      var head = {
        label: 'STOPPED — ' + stoppedLabel(gateKind, gateQuestionCount(open)),
        waitText: waitingMs != null && isFinite(waitingMs) ? formatClock(waitingMs) : null
      };
      if (open && Array.isArray(open.questions) && open.questions.length) {
        return { kind: 'questions', head: head, questions: open.questions, readonlyHint: 'answer in the agent — this card is read-only' };
      }
      if (open && (open.command || open.justification)) {
        return {
          kind: 'permission',
          head: head,
          command: open.command || null,
          justification: open.justification || null,
          readonlyHint: 'approve in the agent — this card is read-only'
        };
      }
      return { kind: 'blocked-bare', head: head };
    }
    if (state === 'done') {
      // Full final message; scrolls past ~200px (CSS). Absent stop text = absent block.
      return { kind: 'done', text: lc.stop_text || null };
    }
    // working / idle
    var noteEv = lastEventOfKind(events, 'note');
    return {
      kind: 'working',
      lastNote: noteEv && noteEv.text ? noteEv.text : null
    };
  }

  /** L2 history rows from the grouped feed → declarative rows the DOM builder materializes. */
  function buildHistoryModel(grouped, taskGateKind) {
    var out = [];
    var rows = (grouped && grouped.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      switch (row.type) {
        case 'prompt':
          out.push({ kind: 'prompt', label: 'PROMPT · ' + formatClock(row.t), text: row.text });
          break;
        case 'tool': {
          var item = row.item || {};
          out.push({
            kind: 'tool',
            name: item.name || '',
            detail: item.detail || '',
            failed: item.ok === false,
            durationText: typeof item.duration_ms === 'number' ? formatCountUp(item.duration_ms) : null
          });
          break;
        }
        case 'tool_group':
          out.push({
            kind: 'chip',
            label: row.count + ' tool calls · ' + Math.max(0, Math.round((row.total_ms || 0) / 1000)) + 's' + (row.running ? ' …' : '')
          });
          break;
        case 'gate': {
          var openEv = row.open || {};
          out.push({
            kind: 'gate-answered',
            label: 'STOPPED — ' + stoppedLabel(row.gate_kind || taskGateKind, gateQuestionCount(openEv)) +
              (typeof row.waited_ms === 'number' ? ' · waited ' + formatCountUp(row.waited_ms) : ''),
            pairs: answerPairs(openEv, row.answered)
          });
          break;
        }
        case 'gate_open': {
          var oe = row.open || {};
          out.push({
            kind: 'gate-open',
            label: 'STOPPED — ' + stoppedLabel(oe.gate_kind || taskGateKind, gateQuestionCount(oe)) + ' · waiting',
            text: gateFirstLine(oe) || null
          });
          break;
        }
        case 'gate_answered':
          out.push({ kind: 'resumed', text: 'answered — resumed' });
          break;
        case 'note':
          out.push({ kind: 'note', text: row.text, timeText: formatClock(row.t) });
          break;
        case 'todo':
          out.push({
            kind: 'todo',
            text: 'todo · ' + (row.active ? row.active + ' ' : '') + '(' + (row.done || 0) + '/' + (row.total || 0) + ')'
          });
          break;
        case 'stop':
          out.push({ kind: 'stop', label: 'DONE', text: row.text || null });
          break;
        default:
          break;
      }
    }
    var footParts = [];
    var counts = (grouped && grouped.counts) || {};
    if (typeof counts.tools === 'number' && counts.tools > 0) footParts.push(formatToolCount(counts.tools));
    return {
      rows: out,
      footModel: (grouped && grouped.meta && grouped.meta.model) || null,
      footText: footParts.length ? footParts.join(' · ') : null
    };
  }

  /**
   * Answered-gate header→answer pairs (5c). Answers shapes (normalizer): map {questionKey:
   * string|string[]}, {answer: str}, or a plain list. A skipped multi-select comes back empty →
   * shown as '—'. No answers payload at all (agy today) → null → the row renders
   * "answered — resumed" only.
   */
  function answerPairs(open, answered) {
    var answers = answered && answered.answers;
    if (answers == null) return null;
    var pairs = [];
    function valueText(v) {
      if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
      var s = String(v == null ? '' : v);
      return s === '' ? '—' : s;
    }
    if (Array.isArray(answers)) {
      var qs = (open && open.questions) || [];
      for (var i = 0; i < answers.length; i++) {
        var qh = qs[i] ? qs[i].header || qs[i].question : '';
        pairs.push({ header: qh || 'A' + (i + 1), answer: valueText(answers[i]) });
      }
      return pairs.length ? pairs : null;
    }
    if (typeof answers === 'object') {
      var keys = Object.keys(answers);
      for (var k = 0; k < keys.length; k++) {
        pairs.push({ header: keys[k], answer: valueText(answers[keys[k]]) });
      }
      return pairs.length ? pairs : null;
    }
    return [{ header: 'answer', answer: valueText(answers) }];
  }

  /* ------------------------------------------------------------------ DOM builders */

  function el(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== '') node.textContent = text;
    return node;
  }

  /* ---- safe Markdown for final assistant messages ---- */

  function appendText(doc, parent, text) {
    if (text == null || text === '') return;
    if (doc.createTextNode) parent.appendChild(doc.createTextNode(String(text)));
    else parent.appendChild(el(doc, 'span', '', String(text)));
  }

  function markdownSafeUrl(value) {
    var url = String(value || '').trim();
    if (/^(https?:|mailto:)/i.test(url)) return url;
    if (/^(\/|#|\.\.?\/)/.test(url)) return url;
    return null;
  }

  // Agent final messages are untrusted input. This renderer creates DOM nodes and assigns all
  // content through textContent; raw HTML is therefore shown as text rather than executed.
  function renderMarkdownInline(doc, parent, value) {
    var text = String(value == null ? '' : value);
    var re = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
    var last = 0;
    var match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) appendText(doc, parent, text.slice(last, match.index));
      if (match[1] !== undefined) {
        parent.appendChild(el(doc, 'code', 'lf-md-code', match[1]));
      } else if (match[2] !== undefined && match[3] !== undefined) {
        var href = markdownSafeUrl(match[3]);
        if (href) {
          var link = el(doc, 'a', 'lf-md-link');
          link.setAttribute('href', href);
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
          renderMarkdownInline(doc, link, match[2]);
          parent.appendChild(link);
        } else {
          appendText(doc, parent, match[0]);
        }
      } else if (match[4] !== undefined || match[5] !== undefined) {
        var strong = el(doc, 'strong', 'lf-md-strong');
        renderMarkdownInline(doc, strong, match[4] !== undefined ? match[4] : match[5]);
        parent.appendChild(strong);
      } else if (match[6] !== undefined) {
        var del = el(doc, 'del', 'lf-md-del');
        renderMarkdownInline(doc, del, match[6]);
        parent.appendChild(del);
      } else {
        var em = el(doc, 'em', 'lf-md-em');
        renderMarkdownInline(doc, em, match[7] !== undefined ? match[7] : match[8]);
        parent.appendChild(em);
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) appendText(doc, parent, text.slice(last));
  }

  function tableCells(line) {
    var text = String(line || '').trim();
    if (text.charAt(0) === '|') text = text.slice(1);
    if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1);
    var cells = [];
    var current = '';
    var escaped = false;
    var inCode = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '`') {
        inCode = !inCode;
        current += ch;
      } else if (ch === '|' && !inCode) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (escaped) current += '\\';
    cells.push(current.trim());
    return cells;
  }

  function tableAlignments(line, expectedCells) {
    if (String(line || '').indexOf('|') === -1) return null;
    var cells = tableCells(line);
    if (cells.length !== expectedCells) return null;
    var alignments = [];
    for (var i = 0; i < cells.length; i++) {
      var marker = cells[i];
      if (!/^:?-{3,}:?$/.test(marker)) return null;
      alignments.push(marker.charAt(0) === ':' && marker.charAt(marker.length - 1) === ':'
        ? 'center'
        : marker.charAt(marker.length - 1) === ':' ? 'right' : 'left');
    }
    return alignments;
  }

  function isMarkdownTable(lines, index) {
    if (index + 1 >= lines.length || String(lines[index]).indexOf('|') === -1) return false;
    var headers = tableCells(lines[index]);
    return headers.length > 1 && !!tableAlignments(lines[index + 1], headers.length);
  }

  function appendTableCell(doc, row, tag, text, alignment) {
    var cell = el(doc, tag, 'lf-md-cell lf-md-align-' + alignment);
    renderMarkdownInline(doc, cell, text);
    row.appendChild(cell);
  }

  function renderMarkdownTable(doc, container, lines, index) {
    var headers = tableCells(lines[index]);
    var alignments = tableAlignments(lines[index + 1], headers.length);
    var wrap = el(doc, 'div', 'lf-md-table-wrap');
    var table = el(doc, 'table', 'lf-md-table');
    var thead = el(doc, 'thead', 'lf-md-thead');
    var headRow = el(doc, 'tr', 'lf-md-tr');
    for (var h = 0; h < headers.length; h++) appendTableCell(doc, headRow, 'th', headers[h], alignments[h]);
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el(doc, 'tbody', 'lf-md-tbody');
    var i = index + 2;
    while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
      var cells = tableCells(lines[i]);
      var row = el(doc, 'tr', 'lf-md-tr');
      for (var c = 0; c < headers.length; c++) appendTableCell(doc, row, 'td', cells[c] || '', alignments[c]);
      tbody.appendChild(row);
      i += 1;
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
    return i;
  }

  function isMarkdownBlockStart(lines, index) {
    var line = lines[index] || '';
    if (!line.trim()) return true;
    if (/^\s{0,3}(```|~~~)/.test(line)) return true;
    if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
    if (/^\s{0,3}([-+*]|\d+[.)])\s+/.test(line)) return true;
    if (/^\s{0,3}>\s?/.test(line)) return true;
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) return true;
    return isMarkdownTable(lines, index);
  }

  function renderMarkdownParagraph(doc, container, lines) {
    var paragraph = el(doc, 'p', 'lf-md-p');
    for (var i = 0; i < lines.length; i++) {
      var hardBreak = / {2,}$/.test(lines[i]);
      renderMarkdownInline(doc, paragraph, lines[i].replace(/\s+$/, ''));
      if (i < lines.length - 1) {
        if (hardBreak) paragraph.appendChild(el(doc, 'br', ''));
        else appendText(doc, paragraph, ' ');
      }
    }
    container.appendChild(paragraph);
  }

  function renderMarkdownInto(doc, container, value) {
    container.textContent = '';
    var source = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
    var lines = source.split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      var fence = /^\s{0,3}(```|~~~)\s*([^\s]*)/.exec(line);
      if (fence) {
        var fenceMark = fence[1];
        var language = String(fence[2] || '').replace(/[^a-z0-9_-]/gi, '');
        var body = [];
        i += 1;
        while (i < lines.length && !new RegExp('^\\s{0,3}' + fenceMark + '\\s*$').test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        var pre = el(doc, 'pre', 'lf-md-pre');
        var code = el(doc, 'code', 'lf-md-pre-code', body.join('\n'));
        if (language) code.setAttribute('data-language', language);
        pre.appendChild(code);
        container.appendChild(pre);
        continue;
      }

      var heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        var level = heading[1].length;
        var headingEl = el(doc, 'h' + level, 'lf-md-heading lf-md-h' + level);
        renderMarkdownInline(doc, headingEl, heading[2]);
        container.appendChild(headingEl);
        i += 1;
        continue;
      }

      if (isMarkdownTable(lines, i)) {
        i = renderMarkdownTable(doc, container, lines, i);
        continue;
      }

      var bullet = /^\s{0,3}[-+*]\s+(.*)$/.exec(line);
      var numbered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        var ordered = !!numbered;
        var list = el(doc, ordered ? 'ol' : 'ul', ordered ? 'lf-md-list lf-md-ol' : 'lf-md-list lf-md-ul');
        while (i < lines.length) {
          var itemMatch = ordered
            ? /^\s{0,3}\d+[.)]\s+(.*)$/.exec(lines[i])
            : /^\s{0,3}[-+*]\s+(.*)$/.exec(lines[i]);
          if (!itemMatch) break;
          var item = el(doc, 'li', 'lf-md-li');
          var check = /^\[([ xX])\]\s+(.*)$/.exec(itemMatch[1]);
          if (check) {
            item.appendChild(el(doc, 'span', 'lf-md-check', check[1].toLowerCase() === 'x' ? '☑' : '☐'));
            renderMarkdownInline(doc, item, check[2]);
          } else {
            renderMarkdownInline(doc, item, itemMatch[1]);
          }
          list.appendChild(item);
          i += 1;
        }
        container.appendChild(list);
        continue;
      }

      if (/^\s{0,3}>\s?/.test(line)) {
        var quote = el(doc, 'blockquote', 'lf-md-quote');
        while (i < lines.length) {
          var quoteLine = /^\s{0,3}>\s?(.*)$/.exec(lines[i]);
          if (!quoteLine) break;
          if (quote.children.length) quote.appendChild(el(doc, 'br', ''));
          renderMarkdownInline(doc, quote, quoteLine[1]);
          i += 1;
        }
        container.appendChild(quote);
        continue;
      }

      if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
        container.appendChild(el(doc, 'hr', 'lf-md-rule'));
        i += 1;
        continue;
      }

      var paragraphLines = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isMarkdownBlockStart(lines, i)) {
        paragraphLines.push(lines[i]);
        i += 1;
      }
      renderMarkdownParagraph(doc, container, paragraphLines);
    }
    return container;
  }

  /** pixel-bot at a fixed scale (chip = 1, card = 2), independent of the model's level. */
  function botElScaled(doc, model, scale) {
    var bot = doc.createElement('pixel-bot');
    bot.setAttribute('provider', model.botProvider);
    bot.setAttribute('state', model.botState);
    bot.setAttribute('scale', String(scale));
    if (model.browser) bot.setAttribute('browser', '');
    return bot;
  }

  /** Root class list for the expanded live-feed card (state drives the highlight colour). */
  function cardClassName(model) {
    var cls = 'task-live-card lf-expanded lf-state-' + model.state;
    if (model.state === 'blocked') cls += ' lf-coral';
    return cls;
  }

  /**
   * A cheap signature of the card's OVERALL structure (not its history rows). When this is
   * unchanged between polls the card can be left standing and only the history rows reconciled —
   * see rerenderTask's incremental path. A change here (a state/gate transition) forces a full
   * rebuild so the new L1 body renders.
   */
  function cellStructSig(model) {
    var l1 = model.l1 || {};
    return [model.level, model.state, l1.kind || ''].join('|');
  }

  var CHEVRON_SVG =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>';

  /**
   * (Re)build the expanded live-feed card into `card` — the L1 body (+ optional L2 history). The
   * card drops UNDER the task row; the chip stays inline. `handlers.onToggleHistory` toggles L2.
   */
  function renderCardInto(doc, card, model, handlers) {
    card.className = cardClassName(model);
    card.textContent = '';
    if (card.dataset) card.dataset.lfTask = model.taskId;
    else card.setAttribute('data-lf-task', model.taskId);
    // Stamp the structural signature so the next poll can tell whether an in-place history
    // reconcile is safe (structure unchanged) or a full rebuild is required (state transition).
    if (card.setAttribute) card.setAttribute('data-lf-struct', cellStructSig(model));

    card.appendChild(botElScaled(doc, model, 2));
    var body = el(doc, 'div', 'lf-body');
    card.appendChild(body);
    renderCard(doc, body, model, handlers);
    return card;
  }

  function registerLine(doc, reg) {
    var line = el(doc, 'div', 'lf-register' + (reg.switched ? ' lf-switch' : ''));
    line.appendChild(el(doc, 'span', 'lf-dot' + (reg.running ? ' running' : '')));
    var text = el(doc, 'span', 'lf-reg-text', reg.text);
    text.setAttribute('data-lf-reg-text', '');
    line.appendChild(text);
    var suffix = el(doc, 'span', 'lf-reg-suffix', reg.suffix);
    suffix.setAttribute('data-lf-reg-suffix', '');
    line.appendChild(suffix);
    return line;
  }

  function metaLineEl(doc, model) {
    if (model.metaElapsedText == null && model.metaRestText == null) return null;
    var meta = el(doc, 'div', 'lf-meta');
    if (model.metaElapsedText != null) {
      var elapsed = el(doc, 'span', 'lf-elapsed', model.metaElapsedText);
      elapsed.setAttribute('data-lf-elapsed', '');
      meta.appendChild(elapsed);
    }
    if (model.metaRestText != null) {
      meta.appendChild(el(doc, 'span', 'lf-meta-rest', (model.metaElapsedText != null ? ' · ' : '') + model.metaRestText));
    }
    return meta;
  }

  /* ---- L1 card (+ optional L2 history) ---- */
  function renderCard(doc, body, model, handlers) {
    var l1 = model.l1 || { kind: 'working' };
    if (l1.kind === 'questions' || l1.kind === 'permission' || l1.kind === 'blocked-bare') {
      var head = el(doc, 'div', 'lf-strip-label');
      head.appendChild(el(doc, 'span', 'lf-strip-text', l1.head.label));
      if (l1.head.waitText != null) {
        head.appendChild(el(doc, 'span', 'lf-strip-sep', ' · waiting '));
        var wait = el(doc, 'span', 'lf-wait', l1.head.waitText);
        wait.setAttribute('data-lf-wait', '');
        head.appendChild(wait);
      }
      body.appendChild(head);
    }

    if (l1.kind === 'questions') {
      // Numbered header chips (▤ badge only where the multi flag exists), then the full stack:
      // option rows label + description — read-only, answer in the agent.
      var chips = el(doc, 'div', 'lf-chips');
      for (var c = 0; c < l1.questions.length; c++) {
        var q = l1.questions[c];
        var chipText = (c + 1) + ' · ' + (q.header || q.question || 'Q' + (c + 1));
        if (q.multi === true) chipText += ' ▤';
        chips.appendChild(el(doc, 'span', 'lf-chip', chipText));
      }
      if (l1.questions.length > 1) body.appendChild(chips);
      var stack = el(doc, 'div', 'lf-qstack');
      for (var i = 0; i < l1.questions.length; i++) {
        stack.appendChild(questionBlock(doc, l1.questions[i], i));
      }
      body.appendChild(stack);
      body.appendChild(el(doc, 'div', 'lf-readonly-hint', l1.readonlyHint));
    } else if (l1.kind === 'permission') {
      if (l1.justification) body.appendChild(el(doc, 'div', 'lf-just', l1.justification));
      if (l1.command) body.appendChild(el(doc, 'div', 'lf-cmd', l1.command));
      body.appendChild(el(doc, 'div', 'lf-readonly-hint', l1.readonlyHint));
    } else if (l1.kind === 'done') {
      body.appendChild(el(doc, 'div', 'lf-done-label', (model.done && model.done.label) || 'DONE'));
      if (l1.text) {
        var fullMessage = el(doc, 'div', 'lf-full-msg lf-markdown');
        renderMarkdownInto(doc, fullMessage, l1.text);
        body.appendChild(fullMessage);
      }
    } else {
      // working card: register line + meta + last note (when the platform ships notes)
      if (model.register) body.appendChild(registerLine(doc, model.register));
      var metaLine = metaLineEl(doc, model);
      if (metaLine) body.appendChild(metaLine);
      if (l1.lastNote) body.appendChild(el(doc, 'div', 'lf-note-line', '❝ ' + l1.lastNote));
    }

    if (model.todo) {
      var todoLine = el(doc, 'div', 'lf-todo');
      var segs = el(doc, 'span', 'lf-todo-segs');
      for (var s = 0; s < Math.min(model.todo.total, 12); s++) {
        segs.appendChild(el(doc, 'span', 'lf-todo-seg' + (s < model.todo.done ? ' done' : '')));
      }
      todoLine.appendChild(segs);
      var todoText = model.todo.active
        ? model.todo.active + ' (' + model.todo.done + '/' + model.todo.total + ')'
        : model.todo.done + '/' + model.todo.total;
      todoLine.appendChild(el(doc, 'span', 'lf-todo-label', todoText));
      body.appendChild(todoLine);
    }

    if (model.contextNote) {
      var ctx = el(doc, 'div', 'lf-context');
      ctx.appendChild(el(doc, 'span', 'lf-context-glyph', '✎'));
      ctx.appendChild(el(doc, 'span', 'lf-context-text', model.contextNote));
      body.appendChild(ctx);
    }

    if (model.history && model.historyModel) {
      body.appendChild(historySection(doc, model.historyModel));
    }

    if (model.foot) {
      var foot = el(doc, 'div', 'lf-foot');
      if (model.foot.model) foot.appendChild(el(doc, 'span', 'lf-model-chip', model.foot.model));
      if (model.foot.metaText) foot.appendChild(el(doc, 'span', 'lf-foot-meta', model.foot.metaText));
      foot.appendChild(el(doc, 'span', 'lf-foot-spacer'));
      if (model.foot.showHistoryButton) {
        var hbtn = el(doc, 'button', 'lf-history-btn', model.foot.historyLabel);
        hbtn.setAttribute('type', 'button');
        hbtn.addEventListener('click', function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          if (handlers && handlers.onToggleHistory) handlers.onToggleHistory(model.taskId);
        });
        foot.appendChild(hbtn);
      }
      body.appendChild(foot);
    }
  }

  function questionBlock(doc, q, index) {
    var block = el(doc, 'div', 'lf-qblock');
    var head = el(doc, 'div', 'lf-qhead');
    var headLabel = q.header ? (index + 1) + ' · ' + String(q.header).toUpperCase() : String(index + 1);
    head.appendChild(el(doc, 'span', 'lf-qhead-label', headLabel));
    if (q.multi === true) head.appendChild(el(doc, 'span', 'lf-multi-badge', 'select all that apply'));
    block.appendChild(head);
    block.appendChild(el(doc, 'div', 'lf-qtext', q.question || ''));
    if (Array.isArray(q.options) && q.options.length) {
      var opts = el(doc, 'div', 'lf-opts');
      for (var i = 0; i < q.options.length; i++) {
        var opt = q.options[i];
        var row = el(doc, 'div', 'lf-opt');
        row.appendChild(el(doc, 'span', 'lf-opt-mark', q.multi === true ? '□' : '○'));
        var textWrap = el(doc, 'span', 'lf-opt-text');
        textWrap.appendChild(el(doc, 'span', 'lf-opt-label', opt.label || ''));
        if (opt.description) textWrap.appendChild(el(doc, 'span', 'lf-opt-desc', ' — ' + opt.description));
        row.appendChild(textWrap);
        opts.appendChild(row);
      }
      block.appendChild(opts);
    }
    return block;
  }

  /* ---- L2 history ---- */
  function historySection(doc, historyModel) {
    var section = el(doc, 'div', 'lf-history');
    var timeline = el(doc, 'div', 'lf-timeline');
    for (var i = 0; i < historyModel.rows.length; i++) {
      timeline.appendChild(historyRow(doc, historyModel.rows[i]));
    }
    section.appendChild(timeline);
    var foot = historyFoot(doc, historyModel);
    if (foot) section.appendChild(foot);
    return section;
  }

  /** The history foot chip row (model chip + meta), or null when there's nothing to show. */
  function historyFoot(doc, historyModel) {
    if (!historyModel || (!historyModel.footModel && !historyModel.footText)) return null;
    var foot = el(doc, 'div', 'lf-history-foot');
    if (historyModel.footModel) foot.appendChild(el(doc, 'span', 'lf-model-chip', historyModel.footModel));
    if (historyModel.footText) foot.appendChild(el(doc, 'span', 'lf-foot-meta', historyModel.footText));
    return foot;
  }

  /** Stable per-row identity — two rows with the same signature render byte-identically, so the
   * incremental reconciler can leave an unchanged row's DOM node (and its scroll) untouched. */
  function historyRowSig(row) {
    try { return JSON.stringify(row); } catch (e) { return String(row && row.kind); }
  }

  /** First DIRECT child of `node` whose class list contains `cls` (works on real DOM + the test
   * shim — both expose `.children` + `.className`, unlike querySelector which the shim lacks). */
  function directChild(node, cls) {
    var kids = node && node.children;
    if (!kids) return null;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c && String(c.className || '').split(/\s+/).indexOf(cls) !== -1) return c;
    }
    return null;
  }

  /**
   * Reconcile an already-mounted `.lf-history` section against a fresh historyModel WITHOUT tearing
   * it down: unchanged rows keep their exact DOM node (so the user's scroll position and any active
   * scroll gesture survive), only new or genuinely-changed rows are (re)built, trailing rows that
   * disappeared are removed, and the foot is refreshed. This is what lets an open history stay
   * readable while a live agent streams new events every poll.
   */
  function updateHistoryInPlace(doc, section, historyModel) {
    var timeline = directChild(section, 'lf-timeline');
    if (!timeline) return false;
    var rows = (historyModel && historyModel.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      var sig = historyRowSig(rows[i]);
      var node = timeline.children[i];
      if (!node) {
        timeline.appendChild(historyRow(doc, rows[i]));
      } else if (node.getAttribute && node.getAttribute('data-lf-rowsig') !== sig) {
        timeline.replaceChild(historyRow(doc, rows[i]), node);
      }
    }
    while (timeline.children.length > rows.length) {
      timeline.removeChild(timeline.children[timeline.children.length - 1]);
    }
    var oldFoot = directChild(section, 'lf-history-foot');
    var newFoot = historyFoot(doc, historyModel);
    if (oldFoot && newFoot) section.replaceChild(newFoot, oldFoot);
    else if (oldFoot && !newFoot) section.removeChild(oldFoot);
    else if (!oldFoot && newFoot) section.appendChild(newFoot);
    return true;
  }

  function historyRow(doc, row) {
    var wrap = el(doc, 'div', 'lf-hrow lf-h-' + row.kind);
    if (wrap.setAttribute) wrap.setAttribute('data-lf-rowsig', historyRowSig(row));
    wrap.appendChild(el(doc, 'span', 'lf-hdot lf-hdot-' + row.kind));
    switch (row.kind) {
      case 'prompt':
        wrap.appendChild(el(doc, 'div', 'lf-hlabel', row.label));
        wrap.appendChild(el(doc, 'div', 'lf-htext lf-clamp2', row.text || ''));
        break;
      case 'tool': {
        var line = el(doc, 'div', 'lf-htool');
        line.appendChild(el(doc, 'span', 'lf-htool-name', row.name));
        if (row.detail) line.appendChild(el(doc, 'span', 'lf-htool-detail', row.detail));
        if (row.durationText) line.appendChild(el(doc, 'span', 'lf-htool-dur', row.durationText));
        if (row.failed) line.appendChild(el(doc, 'span', 'lf-htool-failed', '× failed'));
        wrap.appendChild(line);
        break;
      }
      case 'chip':
        wrap.appendChild(el(doc, 'div', 'lf-hchip', row.label));
        break;
      case 'gate-answered': {
        var box = el(doc, 'div', 'lf-gatebox');
        box.appendChild(el(doc, 'div', 'lf-gatebox-label', row.label));
        if (row.pairs) {
          for (var p = 0; p < row.pairs.length; p++) {
            var pairRow = el(doc, 'div', 'lf-answer-row');
            pairRow.appendChild(el(doc, 'span', 'lf-answer-q', row.pairs[p].header + ' →'));
            pairRow.appendChild(el(doc, 'span', 'lf-answer-a', row.pairs[p].answer));
            box.appendChild(pairRow);
          }
        } else {
          box.appendChild(el(doc, 'div', 'lf-answer-none', 'answered — resumed'));
        }
        wrap.appendChild(box);
        break;
      }
      case 'gate-open': {
        var obox = el(doc, 'div', 'lf-gatebox');
        obox.appendChild(el(doc, 'div', 'lf-gatebox-label', row.label));
        if (row.text) obox.appendChild(el(doc, 'div', 'lf-gatebox-text', row.text));
        wrap.appendChild(obox);
        break;
      }
      case 'resumed':
        wrap.appendChild(el(doc, 'div', 'lf-hresumed', row.text));
        break;
      case 'note':
        wrap.appendChild(el(doc, 'div', 'lf-hnote', '❝ ' + (row.text || '')));
        if (row.timeText) wrap.appendChild(el(doc, 'div', 'lf-htime', row.timeText));
        break;
      case 'todo':
        wrap.appendChild(el(doc, 'div', 'lf-htodo', row.text));
        break;
      case 'stop': {
        // Stop cards show WHY in full — upstream owns the bounded payload; the UI does not re-clamp.
        var sbox = el(doc, 'div', 'lf-stopbox');
        sbox.appendChild(el(doc, 'div', 'lf-stopbox-label', row.label));
        if (row.text) {
          var stopMessage = el(doc, 'div', 'lf-stopbox-text lf-markdown');
          renderMarkdownInto(doc, stopMessage, row.text);
          sbox.appendChild(stopMessage);
        }
        wrap.appendChild(sbox);
        break;
      }
      default:
        break;
    }
    return wrap;
  }

  /* ------------------------------------------------------------------ browser controller */

  /**
   * The app.js glue. Everything below touches the real DOM/network and is exercised by the
   * visual checks (the pure layer above carries the unit tests).
   *
   * init({ getProject, rerenderPane, isTaskProgressHidden, taskListEl, documentRef?, storage?,
   *        fetchJson?, derive?, now? })
   */
  function createController() {
    var glue = null;
    var doc = null;
    var storage = null;
    var fetchJson = null;
    var derive = null;
    var now = function () { return Date.now(); };
    var store = createFeedStore();
    var uiState = new Map(); // taskId → { expanded, history }
    var pollInFlight = false;
    var tickerId = null;

    function init(options) {
      glue = options || {};
      doc = glue.documentRef || (typeof document !== 'undefined' ? document : null);
      storage = glue.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      derive = glue.derive || (typeof window !== 'undefined' && window.LiveFeedDerive) || null;
      if (glue.now) now = glue.now;
      fetchJson =
        glue.fetchJson ||
        function (url) {
          return fetch(url).then(function (res) {
            if (!res.ok) throw new Error('live-feed ' + res.status);
            return res.json();
          });
        };
    }

    function isLive(project) {
      if (!project) return false;
      return readLiveMode(storage, project.id) === 'live';
    }

    function setMode(project, mode) {
      if (!project) return;
      writeLiveMode(storage, project.id, mode);
      if (mode !== 'live') {
        store.clear();
        uiState.clear();
      }
      if (glue && glue.rerenderPane) glue.rerenderPane();
      if (mode === 'live') pollTick();
    }

    /**
     * Called from renderPane: scope the narrow-reflow container class and run/stop the 1s count-up
     * ticker. The mode is toggled from the Edit-project form (per project); pass null when no
     * project is shown.
     */
    function applyPaneState(project) {
      var live = !!project && isLive(project);
      if (glue && glue.taskListEl) glue.taskListEl.classList.toggle('live-mode', live);
      if (live) {
        startTicker();
        // Cold start (page load / project switch into live): don't sit blank until the next 2s
        // tick — fetch now. The in-flight guard + store size keep this a one-shot.
        if (store.size() === 0) pollTick();
      } else {
        stopTicker();
      }
    }

    function uiFor(taskId) {
      var ui = uiState.get(taskId);
      if (!ui) {
        ui = { expanded: false, history: false };
        uiState.set(taskId, ui);
      }
      return ui;
    }

    var handlers = {
      onToggleExpand: function (taskId) { toggleExpand(taskId); },
      onToggleHistory: function (taskId) {
        var ui = uiFor(taskId);
        ui.history = !ui.history;
        if (ui.history) ui.expanded = true;
        rerenderTask(taskId);
      },
      onOpenTracking: function (taskId) {
        if (glue && glue.openTracking) glue.openTracking(taskId);
      },
      onToggleHideProgress: function (taskId) {
        if (glue && glue.toggleHideProgress) glue.toggleHideProgress(taskId);
      }
    };

    function toggleExpand(taskId) {
      var ui = uiFor(taskId);
      ui.expanded = !ui.expanded;
      if (!ui.expanded) ui.history = false;
      rerenderTask(taskId);
    }

    /**
     * Decorate the STANDARD monitor pill (built by app.js) with the live additions: a caret that
     * toggles the inline live-feed card, and — while working — a live timer (M:SS, ticked in place).
     * Both are appended INSIDE the pill button so it stays the same size. The caret stops
     * propagation so clicking it toggles the feed instead of opening the pill's tracking picker.
     * No-op for untracked tasks. app.js calls this in live mode for non-hidden tracked rows.
     */
    function decoratePill(pillEl, project, task) {
      if (!pillEl || !task || !taskLiveBinding(task)) return;
      var model = buildCellModel(task, store.entry(task.id), uiFor(task.id), now(), derive);
      if (!model) return;
      // Live timer — working only. Tagged for the 1s ticker (data-lf-elapsed + data-lf-task).
      if (model.state === 'working' && model.chipTimerText != null) {
        var timer = el(doc, 'span', 'lf-pill-timer');
        var t = el(doc, 'span', 'lf-pill-time', model.chipTimerText);
        t.setAttribute('data-lf-elapsed', '');
        if (t.dataset) t.dataset.lfTask = task.id;
        else t.setAttribute('data-lf-task', task.id);
        timer.appendChild(t);
        pillEl.appendChild(timer);
      }
      // Caret — toggles the live-feed card. A span (the pill is already a <button>); its click
      // stops propagation so the pill's own click (tracking picker) doesn't also fire.
      var caret = el(doc, 'span', 'lf-pill-caret' + (uiFor(task.id).expanded ? ' open' : ''));
      if (caret.setAttribute) caret.setAttribute('title', uiFor(task.id).expanded ? 'Hide the live feed' : 'Show the live feed');
      if ('innerHTML' in caret) caret.innerHTML = CHEVRON_SVG;
      caret.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        toggleExpand(task.id);
      });
      pillEl.appendChild(caret);
    }

    /**
     * Build the expanded live-feed card, or null when this task isn't expanded (or untracked). The
     * card drops UNDER the task row; app.js appends it after the row content so it wraps full-width.
     */
    function buildCard(project, task) {
      if (!task || !taskLiveBinding(task)) return null;
      var ui = uiFor(task.id);
      if (!ui.expanded) return null;
      var model = buildCellModel(task, store.entry(task.id), ui, now(), derive);
      if (!model) return null;
      var card = doc.createElement('div');
      renderCardInto(doc, card, model, handlers);
      return card;
    }

    function findTask(taskId) {
      var project = glue && glue.getProject && glue.getProject();
      if (!project) return { project: null, task: null };
      var tasks = project.tasks || [];
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].id === taskId) return { project: project, task: tasks[i] };
      }
      return { project: project, task: null };
    }

    /**
     * Re-render ONE task's live surface in place (the poll path never rebuilds the whole list): the
     * expanded card is created/updated when the task is expanded and removed when collapsed, and the
     * pill's caret open-state is synced. The pill itself is owned by app.js (rebuilt on /api/state
     * refresh). The card's open history is reconciled in place so its scroll survives.
     */
    function rerenderTask(taskId) {
      if (!doc || !doc.querySelector) return;
      var found = findTask(taskId);
      if (!found.project || !isLive(found.project)) return;
      var li = doc.querySelector('.task-item[data-id="' + taskId + '"]');
      if (!li) return;
      var task = found.task;
      if (!task || !taskLiveBinding(task)) return;
      if (glue.isTaskProgressHidden && glue.isTaskProgressHidden(taskId)) return; // hidden beats live
      var model = buildCellModel(task, store.entry(taskId), uiFor(taskId), now(), derive);
      if (!model) return;
      var main = li.querySelector('.task-item-main');

      // Sync the pill caret's open state (the pill is owned by app.js; here we just flip the class).
      var pillCaret = li.querySelector('.lf-pill-caret');
      if (pillCaret && pillCaret.classList) pillCaret.classList.toggle('open', model.level >= 1);

      // Card — only while expanded; dropped when the caret collapses.
      var card = li.querySelector('.task-live-card');
      if (model.level < 1) {
        if (card && card.parentNode) card.parentNode.removeChild(card);
        return;
      }
      if (!card && main) {
        card = doc.createElement('div');
        main.appendChild(card);
      }
      if (!card) return;
      // Incremental poll patch. renderCardInto does `card.textContent = ''` + a full rebuild of
      // every child, INCLUDING the open L2 history. A live agent lands in `changed` on nearly every
      // 2s poll, so a full rebuild each tick tears the open history down and recreates it — that is
      // the "keeps refreshing / can't scroll" bug: the teardown flashes and interrupts any in-flight
      // scroll gesture (restoring scrollTop afterward is not enough). So when the history is open AND
      // the card's overall structure is unchanged (same state/gate), skip the destructive rebuild and
      // reconcile only the history ROWS in place — untouched rows keep their DOM node (scroll +
      // gesture preserved). The 1s ticker keeps the register/elapsed counters live independently.
      if (
        card.getAttribute &&
        model.history &&
        model.historyModel &&
        card.getAttribute('data-lf-struct') === cellStructSig(model)
      ) {
        var openSection = card.querySelector ? card.querySelector('.lf-history') : null;
        if (openSection) {
          updateHistoryInPlace(doc, openSection, model.historyModel);
          return;
        }
      }
      // Full rebuild path (first open, a state transition, or history closed). Preserve the history
      // scroll offset across the one-off rebuild; if the user was pinned to the bottom (following
      // live), keep them pinned.
      var prevHistory = card.querySelector ? card.querySelector('.lf-history') : null;
      var prevScrollTop = prevHistory ? prevHistory.scrollTop : 0;
      var prevAtBottom = prevHistory
        ? (prevHistory.scrollHeight - prevHistory.scrollTop - prevHistory.clientHeight) <= 4
        : false;
      renderCardInto(doc, card, model, handlers);
      if (prevHistory) {
        var newHistory = card.querySelector ? card.querySelector('.lf-history') : null;
        if (newHistory) {
          newHistory.scrollTop = prevAtBottom ? newHistory.scrollHeight : prevScrollTop;
        }
      }
    }

    /**
     * The 2s poll piggyback (called from startLinkedWaitingRefresh's tick). Live mode only;
     * delta cursor via ?since; endpoint failure ⇒ cells quietly show nothing new.
     */
    function pollTick() {
      var project = glue && glue.getProject && glue.getProject();
      if (!project || !isLive(project) || !projectHasTrackedTasks(project)) return Promise.resolve();
      if (pollInFlight) return Promise.resolve();
      pollInFlight = true;
      var url = '/api/projects/' + encodeURIComponent(project.id) + '/live-feed';
      var since = store.sinceParam();
      if (since) url += '?since=' + encodeURIComponent(JSON.stringify(since));
      return fetchJson(url)
        .then(function (payload) {
          // Endpoint failures above are quiet (cells keep what they have); a CLIENT bug in
          // apply/render must not hide behind the same catch — surface it on the console
          // (never in the pane) and keep the poll loop alive.
          try {
            var result = store.applyResponse(payload, now());
            for (var i = 0; i < result.changed.length; i++) rerenderTask(result.changed[i]);
          } catch (err) {
            if (typeof console !== 'undefined' && console.error) console.error('live-feed apply failed', err);
          }
        })
        .catch(function () { /* fail-safe: endpoint error/timeout ⇒ cells quietly show nothing new */ })
        .then(function () { pollInFlight = false; });
    }

    /* 1s display ticker: count-ups (elapsed / waiting) + the register hold, without rebuilding
     * cell structure. Runs only while live mode is on. */
    function startTicker() {
      if (tickerId != null || !doc) return;
      tickerId = setInterval(tickCells, 1000);
    }

    function stopTicker() {
      if (tickerId != null) {
        clearInterval(tickerId);
        tickerId = null;
      }
    }

    function tickCells() {
      if (!doc || !doc.querySelectorAll) return;
      var project = glue && glue.getProject && glue.getProject();
      if (!project || !isLive(project)) return;
      var nowMs = now();

      // Standalone pill timers (working state) — count the elapsed clock up in place.
      var pillTimers = doc.querySelectorAll('.lf-pill-time[data-lf-task][data-lf-elapsed]');
      for (var p = 0; p < pillTimers.length; p++) {
        var pt = pillTimers[p];
        var pentry = store.entry(pt.getAttribute('data-lf-task'));
        if (pentry && pentry.state === 'working' && pentry.lifecycle && typeof pentry.lifecycle.elapsed_ms === 'number') {
          pt.textContent = formatClock(pentry.lifecycle.elapsed_ms + Math.max(0, nowMs - pentry.received_at));
        }
      }

      var cells = doc.querySelectorAll('.task-live-card[data-lf-task]');
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var taskId = cell.getAttribute('data-lf-task');
        var entry = store.entry(taskId);
        if (!entry) continue;
        // elapsed count-up (working strips/cards)
        var elapsedEl = cell.querySelector('[data-lf-elapsed]');
        if (elapsedEl && entry.lifecycle && typeof entry.lifecycle.elapsed_ms === 'number' && entry.state === 'working') {
          elapsedEl.textContent = formatClock(entry.lifecycle.elapsed_ms + Math.max(0, nowMs - entry.received_at));
        }
        // waiting count-up (blocked)
        var waitEl = cell.querySelector('[data-lf-wait]');
        if (waitEl && entry.lifecycle && entry.lifecycle.waiting_since) {
          var w = nowMs - Date.parse(entry.lifecycle.waiting_since);
          if (isFinite(w)) waitEl.textContent = formatClock(Math.max(0, w));
        }
        // register hold: text may switch only via the register's own holdMs logic
        if (entry.state === 'working' && entry.tier >= 1 && derive) {
          if (!entry.register) entry.register = derive.createActivityRegister({ holdMs: HOLD_MS });
          var tNow = turnNowMs(entry, nowMs);
          var view = entry.register.update(entry.events, tNow);
          var regText = cell.querySelector('[data-lf-reg-text]');
          var regSuffix = cell.querySelector('[data-lf-reg-suffix]');
          var dot = cell.querySelector('.lf-dot');
          if (view && regText && regSuffix && dot) {
            var text = view.detail ? view.name + ' · ' + view.detail : view.name;
            if (regText.textContent !== text) regText.textContent = text;
            regSuffix.textContent = view.running
              ? formatCountUp(tNow - (typeof view.started_t === 'number' ? view.started_t : tNow))
              : formatAgo(tNow - (typeof view.settled_t === 'number' ? view.settled_t : tNow));
            dot.classList.toggle('running', !!view.running);
          }
        }
      }
    }

    return {
      init: init,
      isLive: isLive,
      setMode: setMode,
      applyPaneState: applyPaneState,
      decoratePill: decoratePill,
      buildCard: buildCard,
      pollTick: pollTick,
      rerenderTask: rerenderTask,
      startTicker: startTicker,
      stopTicker: stopTicker,
      _store: store,
      _uiState: uiState,
      _toggleExpand: toggleExpand
    };
  }

  /* ------------------------------------------------------------------ exports */

  var controller = createController();

  return {
    // pure layer (unit-tested)
    liveModeStorageKey: liveModeStorageKey,
    readLiveMode: readLiveMode,
    writeLiveMode: writeLiveMode,
    taskLiveBinding: taskLiveBinding,
    projectHasTrackedTasks: projectHasTrackedTasks,
    botCharacterFor: botCharacterFor,
    botStateFor: botStateFor,
    taskFallbackState: taskFallbackState,
    formatClock: formatClock,
    formatCountUp: formatCountUp,
    formatAgo: formatAgo,
    formatToolCount: formatToolCount,
    stoppedLabel: stoppedLabel,
    gateFirstLine: gateFirstLine,
    createFeedStore: createFeedStore,
    turnNowMs: turnNowMs,
    buildCellModel: buildCellModel,
    buildHistoryModel: buildHistoryModel,
    answerPairs: answerPairs,
    markdownSafeUrl: markdownSafeUrl,
    renderMarkdownInto: renderMarkdownInto,
    cardClassName: cardClassName,
    cellStructSig: cellStructSig,
    renderCardInto: renderCardInto,
    historySection: historySection,
    updateHistoryInPlace: updateHistoryInPlace,
    createController: createController,
    // browser singleton (app.js glue)
    init: controller.init,
    isLive: controller.isLive,
    setMode: controller.setMode,
    applyPaneState: controller.applyPaneState,
    decoratePill: controller.decoratePill,
    buildCard: controller.buildCard,
    pollTick: controller.pollTick,
    _controller: controller
  };
});
