'use strict';

/*
 * cursor_subagent_gate_probe.js — detect a Cursor SUB-AGENT permission gate from state.vscdb.
 *
 * When a sub agent (not the main composer) hits a shell-approval gate, Cursor emits NO renderer
 * `user-approval-requested` wakelock and NO hook — the only Orchestra-consumable trace is the
 * global-storage SQLite (`…/User/globalStorage/state.vscdb`), ItemTable key `composer.composerHeaders`.
 * That blob is `{allComposers:[…]}`; each composer header carries a boolean `hasBlockingPendingActions`
 * ("parked at a gate") and, for sub agents, a `subagentInfo` object with `rootParentConversationId`.
 * So a blocked sub-agent composer + its parent id is a first-class, readable gate signal.
 *
 * CAVEAT (measured): the blob is a ~3.8MB row inside a multi-GB DB, so Cursor flushes it on a heavy
 * debounce (>15s) — a short/quickly-answered gate may never land on disk. Callers that need reliable
 * capture must hold the gate longer than the debounce (see the cursor-ide session's flip timeout).
 *
 * This module mirrors cursor_renderer_permission_probe's factory shape (init/pollOnce/getState) so it
 * plugs into cursor_live_probe alongside the renderer + agent-exec probes, and emits the SAME
 * `permission_requested` / `permission_cleared` event types (conversation_id = the PARENT watch) so the
 * recorder and replay treat it identically to the renderer-derived permission signal.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const COMPOSER_HEADERS_KEY = 'composer.composerHeaders';
// Ignore composers not touched recently: abandoned mid-gate runs leave hasBlockingPendingActions=true
// forever, and we must not resurface those stale flags as live gates.
const DEFAULT_RECENCY_MS = 10 * 60 * 1000;

function defaultGlobalStateDbPath() {
  return path.join(
    os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'
  );
}

function composerUpdatedMs(composer) {
  return Number(
    composer.conversationCheckpointLastUpdatedAt || composer.lastUpdatedAt || composer.createdAt || 0
  ) || 0;
}

/**
 * Pure filter (no I/O — unit-testable): given the `allComposers` array, return the sub-agent
 * composers currently parked at a gate and recent enough to be live.
 * @returns {{composerId:string, parentConversationId:string, name:string, updatedMs:number,
 *            subagentType:(number|undefined), toolCallId:(string|undefined)}[]}
 */
function blockedSubagentGates(allComposers, { nowMs, recencyMs = DEFAULT_RECENCY_MS } = {}) {
  if (!Array.isArray(allComposers)) return [];
  const cutoff = Number.isFinite(nowMs) ? nowMs - recencyMs : null;
  const out = [];
  for (const composer of allComposers) {
    if (!composer || !composer.hasBlockingPendingActions) continue;
    const info = composer.subagentInfo;
    if (!info) continue; // top-level gate → renderer wakelock already covers it; skip here
    const parentConversationId = String(
      info.rootParentConversationId || info.parentComposerId || ''
    ).toLowerCase();
    const composerId = String(composer.composerId || '').toLowerCase();
    if (!parentConversationId || !composerId) continue;
    const updatedMs = composerUpdatedMs(composer);
    if (cutoff != null && updatedMs && updatedMs < cutoff) continue; // stale/abandoned
    out.push({
      composerId,
      parentConversationId,
      name: composer.name || '',
      updatedMs,
      subagentType: info.subagentType,
      toolCallId: info.toolCallId,
    });
  }
  return out;
}

/** Parse the composer.composerHeaders JSON blob into its `allComposers` array (`[]` on any error). */
function parseComposerHeaders(rawJson) {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    return Array.isArray(parsed.allComposers) ? parsed.allComposers : [];
  } catch {
    return [];
  }
}

// Copy the (live) DB + WAL to a temp file on the same tmp volume, then read the single ItemTable row
// via the sqlite3 CLI. Copying first means we never lock Cursor's DB; on macOS APFS the copy is a
// near-instant clonefile. Returns the raw blob string, or '' on any failure.
function readComposerHeadersRaw(stateDbPath, { sqlite3Path = 'sqlite3' } = {}) {
  if (!fs.existsSync(stateDbPath)) return '';
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curgate-'));
    const dest = path.join(tmpDir, 'state.vscdb');
    fs.copyFileSync(stateDbPath, dest);
    for (const ext of ['-wal', '-shm']) {
      try {
        if (fs.existsSync(stateDbPath + ext)) fs.copyFileSync(stateDbPath + ext, dest + ext);
      } catch { /* best-effort WAL copy */ }
    }
    const res = spawnSync(
      sqlite3Path,
      [dest, `SELECT value FROM ItemTable WHERE key='${COMPOSER_HEADERS_KEY}';`],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15000 }
    );
    if (res.status !== 0) return '';
    return String(res.stdout || '').trim();
  } catch {
    return '';
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

/** Read + filter in one call: the live blocked sub-agent gates from a state.vscdb. */
function readBlockedSubagentGates(stateDbPath, { nowMs, recencyMs, sqlite3Path } = {}) {
  const raw = readComposerHeadersRaw(stateDbPath, { sqlite3Path });
  return blockedSubagentGates(parseComposerHeaders(raw), { nowMs, recencyMs });
}

// Cheap change-detector so poll loops skip the expensive copy+parse when Cursor hasn't written the
// DB since the last poll (mtime+size of the main file and its WAL). Returns '' if the DB is missing.
function stateDbFingerprint(stateDbPath) {
  let fp = '';
  for (const p of [stateDbPath, `${stateDbPath}-wal`]) {
    try {
      const st = fs.statSync(p);
      fp += `${st.mtimeMs}:${st.size};`;
    } catch { /* missing file → contributes nothing */ }
  }
  return fp;
}

/**
 * Factory mirroring createRendererPermissionProbe: init()/pollOnce(wrap)/getState().
 * Emits `permission_requested` when a blocked sub-agent gate first appears for a parent, and
 * `permission_cleared` when it goes away — both with conversation_id = the PARENT conversation, so
 * the recorder/replay attribute the needs-input to the parent watch exactly like the renderer signal.
 */
function createComposerHeadersGateProbe(opts = {}) {
  const stateDbPath = opts.stateDbPath || defaultGlobalStateDbPath();
  const recencyMs = Number.isFinite(opts.recencyMs) ? opts.recencyMs : DEFAULT_RECENCY_MS;
  const nowIso = typeof opts.nowIso === 'function' ? opts.nowIso : () => new Date().toISOString();
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : () => Date.now();
  const sqlite3Path = opts.sqlite3Path || 'sqlite3';
  // Injectable for tests: return the current blocked-gate list without touching a real DB.
  const usingRealDb = typeof opts.readGates !== 'function';
  const readGates = usingRealDb
    ? () => readBlockedSubagentGates(stateDbPath, { nowMs: nowMs(), recencyMs, sqlite3Path })
    : opts.readGates;
  // Skip the expensive read when the DB is unchanged. Tests (injected readGates) always read.
  const fingerprint = typeof opts.fingerprint === 'function'
    ? opts.fingerprint
    : (usingRealDb ? () => stateDbFingerprint(stateDbPath) : () => null);
  let lastFingerprint = null;
  // Read at most once per interval (the debounced flush changes no faster than ~15s, so even a few
  // seconds of throttle can't miss a transition) — caps CPU when Cursor is writing the DB constantly.
  const minReadIntervalMs = Number.isFinite(opts.minReadIntervalMs) ? opts.minReadIntervalMs : 0;
  let lastPollMs = null;

  // childComposerId → { parentConversationId, name } for gates currently observed as blocked.
  const pendingByComposer = new Map();

  async function init() {
    // Seed pending with whatever is ALREADY blocked, so a pre-existing (stale-but-recent) gate at
    // baseline doesn't emit a spurious permission_requested on the first poll.
    pendingByComposer.clear();
    let gates = [];
    try { gates = readGates(); } catch { gates = []; }
    lastFingerprint = fingerprint();
    lastPollMs = nowMs(); // init IS a read → seed the throttle clock so the next poll respects it
    for (const g of gates) pendingByComposer.set(g.composerId, g);
    return {
      composer_headers_db: stateDbPath,
      composer_headers_baseline_ok: fs.existsSync(stateDbPath),
      composer_headers_pending_count: pendingByComposer.size,
    };
  }

  async function pollOnce(wrap) {
    const events = [];
    // Throttle: don't even stat the DB more than once per minReadIntervalMs.
    const t = nowMs();
    if (minReadIntervalMs > 0 && lastPollMs != null && (t - lastPollMs) < minReadIntervalMs) return events;
    lastPollMs = t;
    // Cheap skip: if the DB hasn't changed since the last poll, the gate state can't have changed,
    // so there are no transitions to emit — avoid the multi-GB copy+parse.
    const fp = fingerprint();
    if (fp !== null && fp === lastFingerprint) return events;
    lastFingerprint = fp;
    let gates = [];
    try { gates = readGates(); } catch { gates = []; }
    const seen = new Set();
    for (const gate of gates) {
      seen.add(gate.composerId);
      if (pendingByComposer.has(gate.composerId)) continue; // still blocked — already emitted
      pendingByComposer.set(gate.composerId, gate);
      const event = {
        type: 'permission_requested',
        conversation_id: gate.parentConversationId,
        composer_id: gate.parentConversationId,
        subagent_composer_id: gate.composerId,
        subagent: true,
        gate_type: 'permission',
        source: 'composer_headers',
        subagent_name: gate.name,
        t_iso: nowIso(),
      };
      events.push(event);
      if (typeof wrap === 'function') wrap(event);
    }
    for (const [composerId, gate] of [...pendingByComposer.entries()]) {
      if (seen.has(composerId)) continue;
      pendingByComposer.delete(composerId);
      const event = {
        type: 'permission_cleared',
        conversation_id: gate.parentConversationId,
        composer_id: gate.parentConversationId,
        subagent_composer_id: composerId,
        subagent: true,
        gate_type: 'permission',
        source: 'composer_headers',
        // `hasBlockingPendingActions` flips false exactly when the gate is resolved (the harness
        // approves it), so this is the resume-to-working edge. Use the canonical 'approved' reason so
        // the shared applyCursorRendererPermissionEvents resume path fires (same as the exec probe);
        // keep the raw trigger in cleared_via for diagnostics.
        clear_reason: 'approved',
        cleared_via: 'blocking_pending_actions_cleared',
        t_iso: nowIso(),
      };
      events.push(event);
      if (typeof wrap === 'function') wrap(event);
    }
    return events;
  }

  function getState() {
    return {
      composer_headers_db: stateDbPath,
      composer_headers_pending_count: pendingByComposer.size,
      composer_headers_pending: [...pendingByComposer.values()].map((g) => ({
        subagent_composer_id: g.composerId,
        parent_conversation_id: g.parentConversationId,
      })),
    };
  }

  return { init, pollOnce, getState };
}

module.exports = {
  COMPOSER_HEADERS_KEY,
  DEFAULT_RECENCY_MS,
  defaultGlobalStateDbPath,
  blockedSubagentGates,
  parseComposerHeaders,
  readComposerHeadersRaw,
  readBlockedSubagentGates,
  stateDbFingerprint,
  createComposerHeadersGateProbe,
};
