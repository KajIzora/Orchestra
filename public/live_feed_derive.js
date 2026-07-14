/*
 * live_feed_derive.js — pure, dependency-free client-side derivations over a task's
 * LiveTurnEvent buffer (Lane C §6e; Phase 2a shared core, consumed by the Phase 2b UI).
 *
 * Loadable BOTH ways:
 *   - browser: <script src="live_feed_derive.js"> → window.LiveFeedDerive
 *   - node:    const { createActivityRegister, groupFeedEvents } = require('../public/live_feed_derive');
 *
 * Inputs are LiveTurnEvents as served by GET /api/projects/:id/live-feed:
 *   { seq, t, kind, ...payload } with kind ∈ prompt | tool_start | tool_end | note | todo |
 *   gate_open | gate_answered | stop | meta. All `t` are ms since the turn's prompt.
 *
 * IMPORTANT for callers: both derivations are PER-TURN. On a turn change (`turn_id` bump or
 * `reset: true` from the endpoint) drop the event buffer and call register.reset().
 *
 * API (stable for the 2b UI agent):
 *
 *   latestToolView(events) → view | null
 *     Pure snapshot of the newest tool in the data:
 *     { key, name, detail, running, started_t|null, settled_t|null, ok|null }
 *     - `running`: no matching tool_end has landed after its tool_start.
 *     - Platforms with tool_end only (claude today): the view is the last tool_end
 *       (running:false, started_t:null) — the register still shows "what just ran".
 *
 *   createActivityRegister({ holdMs = 2000 }) → { update(events, nowT), current(), reset() }
 *     The L0 "now line" register: always holds the LAST tool; when tools chain sub-second it
 *     SKIPS intermediates and lands on the newest — the shown tool only switches after it has
 *     been displayed ≥ holdMs (debounce the DISPLAY, not the data). update() returns:
 *     { name, detail, running, started_t, settled_t, ok, shown_since_t, switched } | null.
 *     The shown tool's running/settled status refreshes in place while held (dot + suffix
 *     change, text never swaps mid-hold). `nowT` is the caller's clock in turn-relative ms
 *     (e.g. Date.now() - turn_t0).
 *
 *   groupFeedEvents(events) → { rows, meta, counts }
 *     The L2 history reducer:
 *     - consecutive tool calls fold into ONE chip row {type:'tool_group', count, total_ms,
 *       running, items[]}; a group of ONE renders the call itself {type:'tool', item};
 *     - any row-emitting non-tool event (note / gate / stop / todo / prompt) BREAKS the group;
 *       `meta` events emit NO row (they feed the footer) and do NOT break groups;
 *     - an answered gate collapses to one {type:'gate', gate_kind, open, answered, waited_ms}
 *       header→answer pair; an unanswered gate stays {type:'gate_open', open};
 *     - rows: {type:'prompt'|'tool'|'tool_group'|'gate'|'gate_open'|'gate_answered'|'note'|
 *              'todo'|'stop', t, ...};
 *     - meta: last-wins {model, cwd, remote_host}; counts: {tools, notes, gates}.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveFeedDerive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_HOLD_MS = 2000;

  function toolKey(ev, index) {
    return ev && ev.seq != null ? 'seq:' + ev.seq : 'idx:' + index;
  }

  /** Pure: the newest tool in the buffer (see header doc). */
  function latestToolView(events) {
    var list = Array.isArray(events) ? events : [];
    var lastStartIdx = -1;
    var lastEndIdx = -1;
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev) continue;
      if (ev.kind === 'tool_start') lastStartIdx = i;
      else if (ev.kind === 'tool_end') lastEndIdx = i;
    }
    if (lastStartIdx === -1 && lastEndIdx === -1) return null;
    if (lastStartIdx === -1 || lastEndIdx > lastStartIdx) {
      // Ends-only platform, or the last start already closed: show the completed call. When the
      // last event is an end for a DIFFERENT name than the last start (overlapping calls), the
      // newest signal is still that end.
      var end = list[lastEndIdx];
      if (lastStartIdx !== -1 && end.name === list[lastStartIdx].name) {
        var start0 = list[lastStartIdx];
        return {
          key: toolKey(start0, lastStartIdx),
          name: start0.name || '',
          detail: start0.detail || end.detail || '',
          running: false,
          started_t: start0.t,
          settled_t: end.t,
          ok: typeof end.ok === 'boolean' ? end.ok : null,
        };
      }
      return {
        key: toolKey(end, lastEndIdx),
        name: end.name || '',
        detail: end.detail || '',
        running: false,
        started_t: null,
        settled_t: end.t,
        ok: typeof end.ok === 'boolean' ? end.ok : null,
      };
    }
    // Last start is the newest tool; running until a same-name end lands after it.
    var start = list[lastStartIdx];
    var settled = null;
    var ok = null;
    for (var j = lastStartIdx + 1; j < list.length; j++) {
      var e2 = list[j];
      if (e2 && e2.kind === 'tool_end' && (!e2.name || !start.name || e2.name === start.name)) {
        settled = e2.t;
        ok = typeof e2.ok === 'boolean' ? e2.ok : null;
        break;
      }
    }
    return {
      key: toolKey(start, lastStartIdx),
      name: start.name || '',
      detail: start.detail || '',
      running: settled == null,
      started_t: start.t,
      settled_t: settled,
      ok: ok,
    };
  }

  /** The L0 register (stateful hold; see header doc). */
  function createActivityRegister(options) {
    var holdMs = options && typeof options.holdMs === 'number' && options.holdMs >= 0
      ? options.holdMs
      : DEFAULT_HOLD_MS;
    var shown = null; // { key, shownAtT }

    function update(events, nowT) {
      var target = latestToolView(events);
      if (!target) {
        shown = null;
        return null;
      }
      var switched = false;
      if (!shown || shown.key === target.key) {
        if (!shown) {
          shown = { key: target.key, shownAtT: nowT };
          switched = true;
        }
        return render(target, nowT, switched);
      }
      // A newer tool exists. Hold the current one until it has been shown >= holdMs, then land
      // directly on the NEWEST (intermediates are skipped by construction — target is the newest).
      if (nowT - shown.shownAtT >= holdMs || nowT < shown.shownAtT) {
        shown = { key: target.key, shownAtT: nowT };
        return render(target, nowT, true);
      }
      // Keep showing the held tool, with its status refreshed from the data.
      var heldView = findViewByKey(events, shown.key);
      if (!heldView) {
        // Evicted from the buffer (FIFO/turn roll): fall through to the newest immediately.
        shown = { key: target.key, shownAtT: nowT };
        return render(target, nowT, true);
      }
      return render(heldView, nowT, false);
    }

    function findViewByKey(events, key) {
      var list = Array.isArray(events) ? events : [];
      for (var i = 0; i < list.length; i++) {
        var ev = list[i];
        if (!ev || ev.kind !== 'tool_start' && ev.kind !== 'tool_end') continue;
        if (toolKey(ev, i) !== key) continue;
        if (ev.kind === 'tool_end') {
          return { key: key, name: ev.name || '', detail: ev.detail || '', running: false, started_t: null, settled_t: ev.t, ok: typeof ev.ok === 'boolean' ? ev.ok : null };
        }
        var settled = null;
        var ok = null;
        for (var j = i + 1; j < list.length; j++) {
          var e2 = list[j];
          if (e2 && e2.kind === 'tool_end' && (!e2.name || !ev.name || e2.name === ev.name)) {
            settled = e2.t;
            ok = typeof e2.ok === 'boolean' ? e2.ok : null;
            break;
          }
        }
        return { key: key, name: ev.name || '', detail: ev.detail || '', running: settled == null, started_t: ev.t, settled_t: settled, ok: ok };
      }
      return null;
    }

    function render(view, nowT, switched) {
      return {
        name: view.name,
        detail: view.detail,
        running: view.running,
        started_t: view.started_t,
        settled_t: view.settled_t,
        ok: view.ok,
        shown_since_t: shown ? shown.shownAtT : nowT,
        switched: switched,
      };
    }

    return {
      update: update,
      current: function () { return shown ? { key: shown.key, shownAtT: shown.shownAtT } : null; },
      reset: function () { shown = null; },
    };
  }

  /** The L2 grouping reducer (see header doc). */
  function groupFeedEvents(events) {
    var list = Array.isArray(events) ? events : [];
    var rows = [];
    var meta = { model: null, cwd: null, remote_host: null };
    var counts = { tools: 0, notes: 0, gates: 0 };
    var group = null; // { items: [], firstT }
    var openGateRow = null; // the most recent unanswered gate_open row

    function flushGroup() {
      if (!group) return;
      var items = group.items;
      if (items.length === 1) {
        rows.push({ type: 'tool', t: items[0].start_t != null ? items[0].start_t : items[0].end_t, item: items[0] });
      } else if (items.length > 1) {
        var first = items[0];
        var last = items[items.length - 1];
        var firstT = first.start_t != null ? first.start_t : first.end_t;
        var lastT = last.end_t != null ? last.end_t : last.start_t;
        rows.push({
          type: 'tool_group',
          t: firstT,
          count: items.length,
          total_ms: Math.max(0, (lastT || 0) - (firstT || 0)),
          running: last.end_t == null && last.start_t != null,
          items: items,
        });
      }
      group = null;
    }

    function groupItemForStart(ev) {
      return { name: ev.name || '', detail: ev.detail || '', start_t: ev.t, end_t: null, ok: null, duration_ms: null };
    }

    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev || !ev.kind) continue;
      switch (ev.kind) {
        case 'meta':
          if (ev.model) meta.model = ev.model;
          if (ev.cwd) meta.cwd = ev.cwd;
          if (ev.remote_host) meta.remote_host = ev.remote_host;
          break; // row-less: does NOT break a tool group
        case 'tool_start': {
          if (!group) group = { items: [] };
          group.items.push(groupItemForStart(ev));
          counts.tools += 1;
          break;
        }
        case 'tool_end': {
          if (!group) group = { items: [] };
          var openItem = null;
          for (var k = group.items.length - 1; k >= 0; k--) {
            var it = group.items[k];
            if (it.end_t == null && it.start_t != null && (!it.name || !ev.name || it.name === ev.name)) {
              openItem = it;
              break;
            }
          }
          if (openItem) {
            openItem.end_t = ev.t;
            openItem.ok = typeof ev.ok === 'boolean' ? ev.ok : null;
            openItem.duration_ms = Math.max(0, ev.t - openItem.start_t);
            if (!openItem.detail && ev.detail) openItem.detail = ev.detail;
          } else {
            // End without a start in the window (claude today / delta window): its own item.
            group.items.push({ name: ev.name || '', detail: ev.detail || '', start_t: null, end_t: ev.t, ok: typeof ev.ok === 'boolean' ? ev.ok : null, duration_ms: null });
            counts.tools += 1;
          }
          break;
        }
        case 'gate_open': {
          flushGroup();
          var gateRow = { type: 'gate_open', t: ev.t, open: ev };
          rows.push(gateRow);
          openGateRow = gateRow;
          counts.gates += 1;
          break;
        }
        case 'gate_answered': {
          flushGroup();
          if (openGateRow) {
            // Collapse to the header→answer pair (5c mockup): upgrade the open row in place.
            openGateRow.type = 'gate';
            openGateRow.gate_kind = openGateRow.open.gate_kind || null;
            openGateRow.answered = ev;
            openGateRow.waited_ms = typeof ev.waited_ms === 'number' ? ev.waited_ms : null;
            openGateRow = null;
          } else {
            rows.push({ type: 'gate_answered', t: ev.t, answered: ev });
          }
          break;
        }
        case 'prompt':
          flushGroup();
          rows.push({ type: 'prompt', t: ev.t, text: ev.text || '' });
          break;
        case 'note':
          flushGroup();
          rows.push({ type: 'note', t: ev.t, text: ev.text || '' });
          counts.notes += 1;
          break;
        case 'todo':
          flushGroup();
          rows.push({ type: 'todo', t: ev.t, done: ev.done, total: ev.total, active: ev.active || '' });
          break;
        case 'stop':
          flushGroup();
          rows.push({ type: 'stop', t: ev.t, text: ev.text || '' });
          break;
        default:
          break; // unknown kinds are ignored (forward-compatible)
      }
    }
    flushGroup();
    return { rows: rows, meta: meta, counts: counts };
  }

  return {
    DEFAULT_HOLD_MS: DEFAULT_HOLD_MS,
    latestToolView: latestToolView,
    createActivityRegister: createActivityRegister,
    groupFeedEvents: groupFeedEvents,
  };
});
