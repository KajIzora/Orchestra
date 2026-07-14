'use strict';

/*
 * Cold agy (Antigravity) in-flight discovery for the gemini run picker (in-flight generation fix).
 *
 * Hook snapshots are in-memory only: an agy agent (agy-cli or agy-app — both report as provider
 * `gemini`) that started generating while Orchestra was down never delivered its start hook, so
 * the hook-store-only local picker cannot see it. The authoritative cold signal is the
 * per-conversation SQLite DB agy maintains ITSELF (steps table, independent of hook delivery):
 *   ~/.gemini/antigravity-cli/conversations/<conversationId>.db   (agy-cli)
 *   ~/.gemini/antigravity/conversations/<conversationId>.db       (agy-app)
 * One routine covers both surfaces — the picker row shape is identical, only the directory
 * differs (the hook path does not label cli vs app either).
 *
 * Classification (locked in Step2Plan.md decision 8): a conversation surfaces iff
 * countsFromStatuses(statuses).blocking > 0 — i.e. it has a step at status 2 (tool executing),
 * 8 (model streaming) or 9 (awaiting-user gate). All-terminal (3) conversations finished on
 * their own (agy flips steps to 3 itself even when hooks are lost), and delegation-only (7)
 * markers can linger forever after the children finish — neither is an in-flight run.
 *
 * Bounding: ~900+ historical DBs live in these dirs on a long-lived machine. The enumerator
 * (listRecentAgyConversationDbs via readLocalAgyDbStepStatusSignals) mtime-sorts and caps at
 * maxFiles per dir, and the sinceMs option drops DBs whose (db|-wal) mtime is older than the
 * stale window BEFORE any sqlite open. Callers debounce with a short-TTL memo on top.
 *
 * Staleness / HOLE 1 (killed process): a killed agy process leaves its last step frozen at 2/8
 * with no cold PID to check (the conversation DB stores no pid — metadata is protobuf blobs).
 * Ruling: a TIGHTER discovery-only stale window (5 min) for 2/8-blocking conversations, so a
 * killed process reads in-flight for at most ~5 min. Cadence evidence (the 2026-07-08 idle-cap
 * backtest, lib/antigravity_transcript_idle.js): across 121 archived recordings with the DB
 * step-status channel, the longest LEGITIMATE frozen in-flight window was 4.0 min (p99 = 50s),
 * and a 5-min cap false-cleared 0/94 legitimate runs — the same trade the maintainer already
 * accepted for DEFAULT_INFLIGHT_MAX_MS (5 min). A real foreground tool frozen >5 min drops out
 * of discovery and reappears on the DB's next write (recoverable flicker, mirroring the idle
 * cap). Status-9 gates keep the FULL window (default 15 min, matching the hook path's stale
 * cutoff): a kill cannot forge a 9 — it is a stable awaiting-user state written by a live
 * process — so tightening it would only hide pending gates from the cold picker.
 *
 * Fail-safe: a locked/corrupt/missing DB skips that conversation (per-DB try/catch inside the
 * shared reader), an unreadable dir contributes zero rows, and reads are strictly read-only
 * (`sqlite3 -readonly`, same as the live tracker — never a write, never a held lock). A
 * checkpointed WAL-mode DB with no -wal/-shm sidecars fails the -readonly open (SQLITE_CANTOPEN);
 * it is NOT only the cleanly-finished case — agy 1.1.1 checkpoints a GATE-BLOCKED conversation
 * ~30 s into the block while its status-9 step is still pending (agy-cli/findings4.md Run A), so
 * the shared reader retries exactly that sidecar-less case via an `immutable=1` open (see
 * readAgyStepStatusRows in lib/antigravity_cli_tracker.js for the invariant); a DB that fails the
 * -readonly open WITH sidecars present is still skipped, never immutable-opened. The immutable
 * read is a frozen snapshot per open — fine here: every scan re-opens, and the mtime staleness
 * tiers below apply unchanged.
 *
 * Workspace gating: FAIL-OPEN (locked decision; cowork precedent). The conversation DB has no
 * queryable workspace column, so discovered rows carry workspace_path '' and are NOT gated by a
 * project's localWorkspaces — an in-flight run being invisible is the bug this fixes; the
 * bounded cost is that a foreign-workspace in-flight agy run can appear in a workspace-gated
 * project's picker until its hooks arrive.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getAgyCliConversationsDir,
  getAgyAppConversationsDir,
  readLocalAgyDbStepStatusSignals,
} = require('./antigravity_cli_tracker');
const { countsFromStatuses } = require('./antigravity_db_status');
const {
  getAntigravityBrainRoots,
  transcriptPathFromArtifactDirectory,
} = require('./antigravity_hook_signals');
const { ACTIVE_GENERATION_STALE_MS, applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const { parseSubAgentChildren } = require('./antigravity_subagents');
const {
  parseGeminiTranscriptText,
  latestGeminiUserPreviewFromConversation,
} = require('./gemini_tracker');

// Newest-by-mtime DBs considered per conversations dir (an in-flight conversation is by
// definition freshly written, so it is always inside this cap). Matches the cli log/DB fan-out
// cap in lib/antigravity_cli_tracker.js (DEFAULT_MAX_FILES) rather than the 5-DB default the
// status reader uses for scoped polling.
const AGY_DISCOVERY_MAX_DBS_PER_DIR = 32;
// HOLE-1 ruling: discovery-only stale window for 2/8-blocking (streaming/tool) conversations.
const AGY_DISCOVERY_STREAM_STALE_MS = 5 * 60 * 1000;
// A structured question gate is a status-9 step of this step_type (see AGY_QUESTION_STEP_TYPE,
// lib/agy_app_auto_flow.js) — label it question_pending; every other status-9 is a tool gate.
const AGY_QUESTION_GATE_STEP_TYPE = 138;

function normalizeAgyConversationId(id) {
  return String(id || '').trim().toLowerCase();
}

// conversationId = DB basename = brain-dir name, so the transcript is derivable cold the same
// way the hook path derives it (see localAgySnapshotTranscriptPath in server.js): try each
// brain root (cli + app) and keep the first existing transcript.jsonl.
function localAgyDiscoveryTranscriptPath(conversationId, homeDir) {
  const id = String(conversationId || '').trim();
  if (!id) return '';
  for (const brainRoot of getAntigravityBrainRoots(homeDir)) {
    const candidate = transcriptPathFromArtifactDirectory(path.join(brainRoot, id), homeDir);
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next brain root
    }
  }
  return '';
}

/**
 * Discover local in-flight agy conversations from their SQLite DBs (both surfaces).
 *
 * Returns picker-shaped rows (field parity with pickerRunsFromGeminiSnapshots local output —
 * the wrapper mergeLocalGeminiDiscoveryPickerRuns stamps the remaining location fields and the
 * discovered marker). Rows past the stale window come back generating:false/'stale' so the
 * wrapper's generating-only filter drops them, mirroring the claude discovery split.
 *
 * @param {object} [options]
 * @param {string[]} [options.conversationsDirs] - defaults to the cli + app conversations dirs
 * @param {string}   [options.homeDir]           - for brain-root transcript resolution (tests)
 * @param {number}   [options.nowMs]
 * @param {number}   [options.activeStaleMs]     - enumeration bound + gate-row stale window
 * @param {number}   [options.streamStaleMs]     - 2/8-only stale window (HOLE-1 ruling)
 * @param {number}   [options.maxFilesPerDir]
 * @returns {Promise<object[]>} rows sorted by mtime desc
 */
async function discoverLocalAgyRuns(options = {}) {
  const homeDir =
    typeof options.homeDir === 'string' && options.homeDir.trim() ? options.homeDir : os.homedir();
  const conversationsDirs =
    Array.isArray(options.conversationsDirs) && options.conversationsDirs.length
      ? options.conversationsDirs.filter(Boolean)
      : [getAgyCliConversationsDir(homeDir), getAgyAppConversationsDir(homeDir)];
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const activeStaleMs =
    Number.isFinite(options.activeStaleMs) && options.activeStaleMs >= 0
      ? options.activeStaleMs
      : ACTIVE_GENERATION_STALE_MS;
  const streamStaleMs =
    Number.isFinite(options.streamStaleMs) && options.streamStaleMs >= 0
      ? options.streamStaleMs
      : AGY_DISCOVERY_STREAM_STALE_MS;
  const maxFiles =
    Number.isInteger(options.maxFilesPerDir) && options.maxFilesPerDir > 0
      ? options.maxFilesPerDir
      : AGY_DISCOVERY_MAX_DBS_PER_DIR;

  const candidates = [];
  const seenIds = new Set();
  for (const conversationsDir of conversationsDirs) {
    // FRESH state map per scan: the reader emits every in-window conversation's baseline vector
    // (its cold snapshot) instead of only changes, and records each file's (db|-wal) mtime under
    // the documented `<file>::status_mtime` key — read back below for the row's activity stamp.
    const state = new Map();
    let events = [];
    try {
      ({ events } = await readLocalAgyDbStepStatusSignals(state, {
        conversationsDir,
        maxFiles,
        // mtime-bound BEFORE any sqlite open: DBs untouched for the whole stale window cannot
        // be in-flight (and per-DB read errors inside the reader skip just that DB).
        sinceMs: nowMs - activeStaleMs,
      }));
    } catch {
      continue; // unreadable dir — contribute zero rows from this surface, keep the other
    }
    for (const ev of events) {
      const conversationId = normalizeAgyConversationId(ev && ev.conversationId);
      if (!conversationId || seenIds.has(conversationId)) continue;
      const counts = countsFromStatuses(ev.statuses);
      if (!(counts.blocking > 0)) continue; // all-terminal (3) / delegation-only (7): not in-flight
      seenIds.add(conversationId);
      const mtimeMs = Number(state.get(`${ev.source_file}::status_mtime`)) || 0;
      const gateSteps = (Array.isArray(ev.non_terminal_steps) ? ev.non_terminal_steps : []).filter(
        (step) => Number(step && step.status) === 9
      );
      const gatePending = Number((ev.statuses || {})[9] || 0) > 0;
      const questionPending =
        gatePending &&
        gateSteps.length > 0 &&
        gateSteps.every((step) => Number(step.step_type) === AGY_QUESTION_GATE_STEP_TYPE);
      const activeGen = applyActiveGenerationStaleCutoff(
        {
          generating: true,
          start_signal_at: toIso(mtimeMs),
          last_activity_at: toIso(mtimeMs),
          inactive_reason: '',
        },
        {
          mtimeMs,
          nowMs,
          // HOLE-1 tier (see header): kills can only forge 2/8, so gate-free blocking rows get
          // the tighter window; a pending gate keeps the full one.
          activeStaleMs: gatePending ? activeStaleMs : Math.min(streamStaleMs, activeStaleMs),
        }
      );
      candidates.push({ conversationId, mtimeMs, gatePending, questionPending, activeGen });
    }
  }

  // One transcript read per candidate (cold analog of the snapshot path's sub-agent collector +
  // preview enrichment): INVOKE_SUBAGENT children of a discovered parent must not surface as
  // top-level rows themselves, and the latest USER_INPUT is the row preview.
  const childIds = new Set();
  const rows = [];
  for (const candidate of candidates) {
    const transcriptPath = localAgyDiscoveryTranscriptPath(candidate.conversationId, homeDir);
    let preview = '';
    if (transcriptPath) {
      try {
        const text = await fs.promises.readFile(transcriptPath, 'utf8');
        for (const child of parseSubAgentChildren(text)) {
          const childId = normalizeAgyConversationId(child && child.conversationId);
          if (childId) childIds.add(childId);
        }
        const convo = parseGeminiTranscriptText(text, transcriptPath);
        preview = latestGeminiUserPreviewFromConversation(convo, 10) || '';
      } catch {
        // transcript unreadable — keep the DB-derived row
      }
    }
    rows.push({
      kind: 'ide_agent',
      provider: 'gemini',
      source: 'local',
      session_id: candidate.conversationId,
      transcript_path: transcriptPath,
      title: '',
      workspace_path: '', // not recoverable cold — fail-open, see header
      updated_at: toIso(candidate.mtimeMs),
      mtime_ms: candidate.mtimeMs,
      last_user_preview: preview || 'Awaiting user message',
      notification_type: candidate.gatePending && !candidate.questionPending ? 'ToolPermission' : '',
      question_pending: candidate.questionPending,
      ...candidate.activeGen,
    });
  }

  const out = rows.filter((row) => !childIds.has(normalizeAgyConversationId(row.session_id)));
  out.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return out;
}

module.exports = {
  AGY_DISCOVERY_MAX_DBS_PER_DIR,
  AGY_DISCOVERY_STREAM_STALE_MS,
  discoverLocalAgyRuns,
};
