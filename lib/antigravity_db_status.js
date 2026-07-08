'use strict';

/**
 * agy conversation-DB step-status channel.
 *
 * agy writes every conversation's progress into its own SQLite DB (`steps` table); the process
 * itself maintains it, independent of hook delivery. Measured semantics (2026-07-03 measurement
 * round, docs/TestingFrameworkUpdate/FinalSteps/PerPlatform/agy-cli/fixes.md):
 *
 *   status 3 = step terminal/complete     status 8 = model streaming this step
 *   status 2 = tool executing             status 9 = awaiting the user (permission gate)
 *   status 7 = sub-agent-delegation / background-spawn marker (observed on step_type=9 parent
 *              steps, round-2 2026-07-03): the parent's "I handed work to children" bookmark.
 *              It routinely NEVER resolves to terminal even after every child conversation is
 *              fully terminal, so it must not be treated as "a step is still executing" — a
 *              plain status!==3 rule held watches busy unboundedly (agy-app round-2 Orchestra
 *              Gap: parallel/background/robust-sub-agent never-clears). It still holds busy
 *              while FRESH (covers the spawn→child-discovery window); see the consumers'
 *              delegation-stale handling in lib/gemini_hook_store.js conversationBusyUntil.
 *
 * Two facts make it a strong cascade busy/settle signal:
 *   - BUSY is positive and bridges hook-silent gaps: a `schedule`/blocking tool holds status 2
 *     for its whole silent wait (observed 24s), and a lost PostToolUse hook does NOT strand it —
 *     agy flips the step to 3 itself when the tool returns.
 *   - ALL-TERMINAL is necessary-but-not-sufficient for done: between steps the vector reads
 *     all-3 for up to ~2.5s (observed max) before the next step row appears. Any settle decision
 *     must therefore require the vector to be STABLE for a window with margin — we reuse the 6s
 *     quiescence scale (2.4x the observed maximum inter-step window).
 *
 * Consumers read per-conversation snapshots `{ present, nonTerminalCount, lastChangeMs }` and
 * apply AGY_DB_STATUS_STABILITY_MS. Three tracker implementations share that shape:
 *   - createLocalAgyDbStatusTracker: live server / harness — real sqlite reads, mtime-gated and
 *     CACHED: `read()` is synchronous on the cache and kicks an async refresh at most once per
 *     refreshMs, so sync poller deps can consume it without blocking on sqlite.
 *   - createRemoteAgyDbStatusTracker: live server, ssh watches — a per-host cache over the
 *     remote reader (readRemoteAgyCliDbStepStatusSignals); refresh is driven from the server's
 *     remote polling loop (never from the sync read), scoped to the active ssh watches + their
 *     cascade sub_agents.
 *   - createReplayAgyDbStatusTracker: replay — computed from the recording's captured
 *     `db_status_events` at the virtual clock, fully synchronous.
 */

const path = require('path');
const { promises: fsp } = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SQLITE_BIN = '/usr/bin/sqlite3';
const AGY_DB_STATUS_STABILITY_MS = 6000;
const AGY_DB_TERMINAL_STATUS = 3;
const AGY_DB_DELEGATION_STATUS = 7;
const DEFAULT_REFRESH_MS = 1500;

function emptySnapshot() {
  return { present: false, nonTerminalCount: 0, blockingNonTerminalCount: 0, lastChangeMs: 0 };
}

// blocking = non-terminal steps that mean real in-progress work (2 tool / 8 streaming / 9 gate…);
// a status-7 delegation marker is EXCLUDED — it can linger forever after the children finish, so
// only its freshness (not its existence) may hold a watch busy.
function countsFromStatuses(statuses) {
  let nonTerminal = 0;
  let blocking = 0;
  for (const [status, count] of Object.entries(statuses || {})) {
    const s = Number(status);
    const n = Number(count) || 0;
    if (s === AGY_DB_TERMINAL_STATUS) continue;
    nonTerminal += n;
    if (s !== AGY_DB_DELEGATION_STATUS) blocking += n;
  }
  return { nonTerminal, blocking };
}

async function readStepStatusVector(dbPath) {
  const sql = 'SELECT idx, status FROM steps ORDER BY idx ASC;';
  const { stdout } = await execFileAsync(SQLITE_BIN, ['-readonly', '-json', dbPath, sql], { timeout: 2500 });
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  const rows = JSON.parse(trimmed);
  if (!Array.isArray(rows) || !rows.length) return null;
  const nonTerminalRows = rows.filter((r) => Number(r.status) !== AGY_DB_TERMINAL_STATUS);
  return {
    vector: rows.map((r) => `${r.idx}:${r.status}`).join(','),
    nonTerminalCount: nonTerminalRows.length,
    blockingNonTerminalCount: nonTerminalRows.filter((r) => Number(r.status) !== AGY_DB_DELEGATION_STATUS).length,
  };
}

/**
 * Live tracker. `read(conversationIds, nowMs)` returns Map<convId, snapshot> from the cache and
 * schedules a background refresh when the cache is older than refreshMs. First reads for a
 * conversation are therefore `present:false` for one refresh cycle (~1.5s) — callers treat
 * absent as "no DB signal, use hook inference", so warm-up is safe.
 */
function createLocalAgyDbStatusTracker(options = {}) {
  const conversationsDirs = (options.conversationsDirs || []).filter(Boolean);
  const refreshMs = Number.isFinite(options.refreshMs) ? options.refreshMs : DEFAULT_REFRESH_MS;
  const byConv = new Map(); // convId -> {present, nonTerminalCount, lastChangeMs, vector, mtimeMs}
  let lastRefreshMs = 0;
  let refreshing = false;

  async function refresh(conversationIds, nowMs) {
    for (const convId of conversationIds) {
      const id = String(convId || '').trim();
      if (!id) continue;
      let found = null;
      for (const dir of conversationsDirs) {
        const file = path.join(dir, `${id}.db`);
        try {
          const st = await fsp.stat(file);
          let mtimeMs = st.mtimeMs || 0;
          try {
            const wal = await fsp.stat(`${file}-wal`);
            mtimeMs = Math.max(mtimeMs, wal.mtimeMs || 0);
          } catch { /* WAL absent between checkpoints */ }
          found = { file, mtimeMs };
          break;
        } catch { /* not in this dir */ }
      }
      if (!found) continue;
      const prev = byConv.get(id);
      if (prev && prev.mtimeMs === found.mtimeMs) continue; // unchanged since last look
      let statusRow = null;
      try {
        statusRow = await readStepStatusVector(found.file);
      } catch { continue; }
      if (!statusRow) continue;
      if (prev && prev.vector === statusRow.vector) {
        // File churn without a semantic change (checkpointing) — keep the original change time.
        byConv.set(id, { ...prev, mtimeMs: found.mtimeMs });
        continue;
      }
      byConv.set(id, {
        present: true,
        nonTerminalCount: statusRow.nonTerminalCount,
        blockingNonTerminalCount: statusRow.blockingNonTerminalCount,
        // The write stamp, not the poll stamp: stability windows anchor at the real change.
        lastChangeMs: found.mtimeMs || nowMs,
        vector: statusRow.vector,
        mtimeMs: found.mtimeMs,
      });
    }
  }

  return {
    read(conversationIds, nowMs = Date.now()) {
      const ids = [...(conversationIds || [])].map((v) => String(v || '').trim()).filter(Boolean);
      if (ids.length && !refreshing && nowMs - lastRefreshMs >= refreshMs) {
        refreshing = true;
        lastRefreshMs = nowMs;
        refresh(ids, nowMs)
          .catch(() => {})
          .finally(() => { refreshing = false; });
      }
      const out = new Map();
      for (const id of ids) out.set(id, byConv.get(id) || emptySnapshot());
      return out;
    },
  };
}

/**
 * Remote (--source ssh) tracker: a per-host cache over readRemoteAgyCliDbStepStatusSignals
 * (lib/antigravity_cli_tracker.js) with the SAME snapshot shape/contract as the local tracker,
 * so the gemini-hook-store consumers (blocking busy hold, in-flight release,
 * terminal-corroborated settle; status-7 delegation markers never hold) work unchanged over ssh.
 *
 * Split responsibilities (unlike the local tracker, read() cannot kick its own refresh — an ssh
 * round-trip inside the sync poller tick is exactly what must never happen):
 *   - refreshHost(host, conversationIds, {runSsh}) — async, driven from the server's existing
 *     ~1s pollRemoteHookLogs loop, scoped by the caller to the active ssh watches + their
 *     cascade sub_agents (never a whole-dir scan). Rate-limited per host; failures (ssh down,
 *     python3/sqlite missing on the remote) are swallowed and leave the cache as-is.
 *   - read(host, conversationIds, nowMs) — synchronous on the cache. A cold miss, an unknown
 *     host, or a host whose refreshes all failed reads {present:false}: indistinguishable from
 *     "no DB", the same degradation contract as the local tracker's warm-up (callers fall back
 *     to pure hook inference).
 *   - forHost(host) — a host-bound {read(conversationIds, nowMs)} view matching the shared
 *     tracker contract, for buildGeminiPollerDeps's per-watch dbStatusForWatch router.
 *
 * lastChangeMs anchors at the REMOTE write stamp translated onto the LOCAL clock via the write's
 * age (remote now - remote mtime, computed on the remote in one response): clock-skew-free, and
 * a cold first read of a long-idle DB is correctly OLD — so the ~15s in-flight release and the
 * 30s delegation-stale window behave at watch-link time like they do locally, instead of
 * restarting from the first poll.
 */
function createRemoteAgyDbStatusTracker(options = {}) {
  const readRemote =
    options.readRemote ||
    // Lazy: only the live server path needs the cli tracker (replay/local never call refresh).
    ((...args) => require('./antigravity_cli_tracker').readRemoteAgyCliDbStepStatusSignals(...args));
  const refreshMs = Number.isFinite(options.refreshMs) ? options.refreshMs : DEFAULT_REFRESH_MS;
  const byHost = new Map(); // host -> { readerState, byConv: Map<convIdLower, snapshot>, lastRefreshMs, refreshing }

  function entryFor(host, create) {
    const h = String(host || '').trim();
    if (!h) return null;
    let entry = byHost.get(h);
    if (!entry && create) {
      entry = { readerState: new Map(), byConv: new Map(), lastRefreshMs: 0, refreshing: false };
      byHost.set(h, entry);
    }
    return entry || null;
  }

  async function refreshHost(host, conversationIds, opts = {}) {
    const entry = entryFor(host, true);
    if (!entry) return;
    const ids = [...new Set([...(conversationIds || [])].map((v) => String(v || '').trim()).filter(Boolean))];
    if (!ids.length) return;
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    if (entry.refreshing || nowMs - entry.lastRefreshMs < refreshMs) return;
    entry.refreshing = true;
    entry.lastRefreshMs = nowMs;
    try {
      const out = await readRemote({ host: String(host).trim() }, entry.readerState, {
        runSsh: opts.runSsh,
        timeoutMs: opts.timeoutMs,
        conversationIds: ids,
      });
      const receivedAtMs = Date.now();
      for (const ev of out?.events || []) {
        const id = String(ev?.conversationId || '').trim().toLowerCase();
        if (!id) continue;
        const counts = countsFromStatuses(ev.statuses);
        const ageMs = Number.isFinite(ev.age_ms) ? Math.max(0, ev.age_ms) : 0;
        // The reader dedupes on the status vector, so every event IS a semantic change (or the
        // first observation) — checkpoint churn without a vector change never reaches here and
        // therefore never refreshes lastChangeMs (same rule as the local tracker).
        entry.byConv.set(id, {
          present: true,
          nonTerminalCount: Number.isFinite(ev.non_terminal_count) ? ev.non_terminal_count : counts.nonTerminal,
          blockingNonTerminalCount: counts.blocking,
          lastChangeMs: receivedAtMs - ageMs,
          vector: typeof ev.status_vector === 'string' ? ev.status_vector : '',
        });
      }
    } catch {
      // ssh failure / no python3 / unreadable DB: keep the last snapshots; never-seen
      // conversations keep reading {present:false}. Never thrown into the poller.
    } finally {
      entry.refreshing = false;
    }
  }

  function read(host, conversationIds, nowMs = Date.now()) {
    void nowMs; // cache-only: the write-age translation happened at refresh time
    const entry = entryFor(host, false);
    const out = new Map();
    for (const convId of conversationIds || []) {
      const id = String(convId || '').trim();
      if (!id) continue;
      out.set(id, (entry && entry.byConv.get(id.toLowerCase())) || emptySnapshot());
    }
    return out;
  }

  return {
    refreshHost,
    read,
    forHost(host) {
      const h = String(host || '').trim();
      if (!h) return null;
      return { read: (conversationIds, nowMs) => read(h, conversationIds, nowMs) };
    },
  };
}

/**
 * Replay tracker over the recording's captured `db_status_events`
 * ([{t_ms, conversationId, non_terminal_count}] — written by the session's measurement probe and
 * copied into the recording by the converter). Same read() contract at the virtual clock.
 */
function createReplayAgyDbStatusTracker(events = []) {
  const byConv = new Map();
  for (const ev of events) {
    const id = String(ev?.conversationId || ev?.conversation_id || '').trim();
    const t = Number(ev?.t_ms);
    if (!id || !Number.isFinite(t)) continue;
    if (!byConv.has(id)) byConv.set(id, []);
    const nonTerminalCount = Number(ev.non_terminal_count) || 0;
    // Blocking count (status-7 delegation markers excluded): derived from the recorded per-status
    // count map when present. A recording without `statuses` (pre-round-2 capture) falls back to
    // treating every non-terminal step as blocking — the original (over-holding) behavior, so old
    // bank recordings replay exactly as they were graded.
    let blockingNonTerminalCount = nonTerminalCount;
    if (ev.statuses && typeof ev.statuses === 'object') {
      blockingNonTerminalCount = countsFromStatuses(ev.statuses).blocking;
    }
    byConv.get(id).push({ t_ms: t, nonTerminalCount, blockingNonTerminalCount });
  }
  for (const rows of byConv.values()) rows.sort((a, b) => a.t_ms - b.t_ms);
  return {
    read(conversationIds, nowMs = 0) {
      const out = new Map();
      for (const convId of conversationIds || []) {
        const id = String(convId || '').trim();
        const rows = byConv.get(id);
        if (!rows || !rows.length || rows[0].t_ms > nowMs) {
          out.set(id, emptySnapshot());
          continue;
        }
        let latest = rows[0];
        for (const row of rows) {
          if (row.t_ms > nowMs) break;
          latest = row;
        }
        out.set(id, {
          present: true,
          nonTerminalCount: latest.nonTerminalCount,
          blockingNonTerminalCount: latest.blockingNonTerminalCount,
          lastChangeMs: latest.t_ms,
        });
      }
      return out;
    },
  };
}

module.exports = {
  AGY_DB_STATUS_STABILITY_MS,
  AGY_DB_TERMINAL_STATUS,
  AGY_DB_DELEGATION_STATUS,
  countsFromStatuses,
  createLocalAgyDbStatusTracker,
  createRemoteAgyDbStatusTracker,
  createReplayAgyDbStatusTracker,
};
