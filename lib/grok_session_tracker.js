'use strict';

/*
 * grok_session_tracker.js — production tracking for grok CLI sessions (live-feed campaign R2c).
 *
 * The file-based ide_agent watch for grok, modeled on lib/claude_cowork_tracker.js (the closest
 * precedent: no hook tap, a per-session on-disk log is the whole channel). A grok session lives at
 * ~/.grok/sessions/<url-encoded-cwd>/<uuidv7>/ (ReconPlaybook §7); the files this module reads:
 *
 *   events.jsonl  — LIVE-flushed lifecycle log (the flagship channel; R2b campaign-verified):
 *                   turn_started {session_id, model_id, yolo_mode} · tool_started/tool_completed
 *                   {tool_name, outcome} · permission_requested/permission_resolved
 *                   {tool_name, decision, wait_ms} · turn_ended {outcome, cancellation_category}
 *   summary.json  — rewritten during the turn; header one-stop-shop {info.cwd, current_model_id,
 *                   head_branch, ...}
 *   updates.jsonl — ACP session/update mirror, flushed INCREMENTALLY at message/tool boundaries
 *                   (LIVE mid-turn — re-verified 2026-07-12 L5 with a 100ms file-size sampler in
 *                   headless, ACP AND TUI modes on 0.2.93: the mid-turn agent_message_chunk was on
 *                   disk seconds before the next tool finished. This SUPERSEDES the R2a
 *                   "turn-end flush" claim — that probe's turn was too fast to distinguish the
 *                   flush boundaries; evidence: ClosureCampaign/evidence/l5/t2-liveness/):
 *                   user_message_chunk (prompt) · agent_thought_chunk / agent_message_chunk
 *                   (mid-turn narrative — the T2 note channel, parseGrokUpdatesRecords below;
 *                   the LAST agent_message_chunk is the stop-text source) · tool_call/… ;
 *                   chat_history.jsonl — raw model messages (prompt fallback).
 *
 * GATE SEMANTICS (campaign-verified, platforms/grok-cli/livefeed-mapping.proposed.json):
 *   - EVERY tool call logs a permission_requested → permission_resolved {decision:'allow',
 *     wait_ms:0} pair, even under always-approve. A REAL permission gate is a permission_requested
 *     left UNRESOLVED (pending = requested-without-resolved); a held gate resolves with wait_ms ≈
 *     the human dwell.
 *   - The ask_user_question tool is the QUESTION gate: pending = tool_started ask_user_question
 *     without its tool_completed. It ALSO logs an instant permission pair (wait_ms 0) — permission
 *     events on tool_name 'ask_user_question' are attributed to the question, never to a
 *     permission gate.
 *   - Question/permission PAYLOADS ride the agent→client RPCs only (tier-1 honesty; the disk
 *     carries kind-level markers).
 *
 * SAFETY: session dirs are only ever read under <grok home>/sessions (assertAllowedGrokSessionDir);
 * ~/.grok/auth.json is a secret and lives OUTSIDE that subtree. Local-only this wave (R2d runs ssh).
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { truncateCleanHumanPromptPreview } = require('./human_prompt_preview');
const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');
const {
  clamp,
  CAPS,
} = require('./live_turn_normalizer');

const DEFAULT_MAX_RUNS = 30;
const DEFAULT_TAIL_BYTES = 1024 * 1024; // events.jsonl tail cap (mirrors the cowork audit cap)
const DEFAULT_UPDATES_TAIL_BYTES = 1024 * 1024; // updates.jsonl tail for the stop-text pull
const GROK_QUESTION_TOOL = 'ask_user_question';
// A resolved permission pair faster than this is grok's own auto-approve bookkeeping (observed
// 0–4ms under always-approve; the driver's held gates resolve at ≈ the dwell, e.g. wait_ms 4004).
// Only pairs at/over the threshold render as real gate_open/gate_answered feed rows.
const GROK_INSTANT_GATE_MS = 1000;

/** The real grok state home (auth + sessions). GROK_HOME env overrides (fake-HOME shim safe). */
function getGrokHome(homeDir = os.homedir()) {
  const env = typeof process.env.GROK_HOME === 'string' ? process.env.GROK_HOME.trim() : '';
  return env || path.join(homeDir, '.grok');
}

function getGrokSessionsRoot(homeDir = os.homedir()) {
  return path.join(getGrokHome(homeDir), 'sessions');
}

/**
 * Path guard: a watchable grok session dir must live DIRECTLY under <grok home>/sessions/<group>/
 * (two levels below the root — the url-encoded-cwd group, then the uuid session dir). Throws on
 * anything else so a hostile session_dir can never read outside the grok sessions tree.
 */
function assertAllowedGrokSessionDir(sessionDir, homeDir = os.homedir()) {
  const raw = typeof sessionDir === 'string' ? sessionDir.trim() : '';
  if (!raw) throw new Error('Grok session dir is required');
  const resolved = path.resolve(raw);
  const root = path.resolve(getGrokSessionsRoot(homeDir));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Grok session dir must live under the grok sessions root');
  }
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length !== 2) {
    throw new Error('Grok session dir must be <sessions root>/<workspace group>/<session id>');
  }
  return resolved;
}

/** Resolve a session dir from a bare session id by scanning the two-level sessions tree. */
function resolveGrokSessionDirById(sessionId, homeDir = os.homedir()) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid || sid.includes('/') || sid.includes('\\') || sid === '.' || sid === '..') return '';
  const root = getGrokSessionsRoot(homeDir);
  let groups = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return '';
  }
  for (const group of groups) {
    const candidate = path.join(root, group.name, sid);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not in this group */
    }
  }
  return '';
}

function grokEventsPath(sessionDir) {
  return path.join(sessionDir, 'events.jsonl');
}

function grokUpdatesPath(sessionDir) {
  return path.join(sessionDir, 'updates.jsonl');
}

function grokSummaryPath(sessionDir) {
  return path.join(sessionDir, 'summary.json');
}

async function readTailText(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}

function parseJsonlLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      /* partial/garbled line — skip */
    }
  }
  return out;
}

function eventTimeMs(obj) {
  const ts = obj && typeof obj.ts === 'string' ? Date.parse(obj.ts) : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

function isQuestionTool(obj) {
  return !!obj && typeof obj.tool_name === 'string' && obj.tool_name.trim() === GROK_QUESTION_TOOL;
}

/*
 * Fold one events.jsonl record into the shared scan state used by BOTH the completion check and
 * the active-generation classifier (one vocabulary, two projections):
 *   reason: '' | 'permission' | 'question' | 'done' | 'cancelled'
 */
function foldGrokEvent(st, obj, ts) {
  switch (obj.type) {
    case 'turn_started':
      st.reason = '';
      st.generating = true;
      st.startMs = ts || st.lastMs || st.startMs;
      break;
    case 'tool_started':
      if (isQuestionTool(obj)) {
        st.reason = 'question';
        st.generating = false;
      }
      break;
    case 'tool_completed':
      if (isQuestionTool(obj) && st.reason === 'question') {
        st.reason = '';
        st.generating = true;
        st.startMs = ts || st.lastMs || st.startMs;
      }
      break;
    case 'permission_requested':
      // ask_user_question's own instant permission pair belongs to the QUESTION channel.
      if (!isQuestionTool(obj)) {
        st.reason = 'permission';
        st.generating = false;
      }
      break;
    case 'permission_resolved':
      if (!isQuestionTool(obj) && st.reason === 'permission') {
        st.reason = '';
        st.generating = true;
        st.startMs = ts || st.lastMs || st.startMs;
      }
      break;
    case 'turn_ended':
      st.reason = obj.outcome === 'cancelled' ? 'cancelled' : 'done';
      st.generating = false;
      break;
    default:
      break; // phase_changed / loop_started / first_token / yolo_toggled: no state content
  }
}

/**
 * @returns {''|'done'|'cancelled'|'permission'|'question'} the reason the watch should clear
 *   (falsy = keep waiting), scanning events.jsonl records at/after linked_at. Mirrors
 *   coworkTurnCompletedSince: the LAST state wins, so answered gates and a follow-up
 *   turn_started re-arm the scan back to "working".
 */
async function grokTurnCompletedSince(sessionDir, linkedAtIso, options = {}) {
  const resolved = options.skipPathValidation
    ? path.resolve(String(sessionDir || ''))
    : assertAllowedGrokSessionDir(sessionDir, options.homeDir);
  const text = await readTailText(grokEventsPath(resolved), options.maxBytes || DEFAULT_TAIL_BYTES);
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  const st = { reason: '', generating: false, startMs: 0, lastMs: 0 };
  for (const obj of parseJsonlLines(text)) {
    const ts = eventTimeMs(obj);
    if (linkedAtMs && ts && ts < linkedAtMs) continue;
    if (linkedAtMs && !ts) continue;
    if (ts) st.lastMs = ts;
    foldGrokEvent(st, obj, ts);
  }
  return st.reason;
}

/** Active-generation classification of a session's events.jsonl text (resume + picker + re-arm). */
function classifyGrokActiveGenerationFromText(raw, options = {}) {
  const st = {
    reason: '',
    generating: false,
    startMs: 0,
    lastMs: Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0,
  };
  for (const obj of parseJsonlLines(raw)) {
    const ts = eventTimeMs(obj);
    if (ts) st.lastMs = ts;
    foldGrokEvent(st, obj, ts);
  }
  let inactiveReason = '';
  if (!st.generating) {
    if (st.reason === 'permission' || st.reason === 'question') inactiveReason = 'awaiting_user_input';
    else if (st.reason === 'cancelled') inactiveReason = 'cancelled';
    else if (st.reason === 'done') inactiveReason = 'completion_signal';
    else inactiveReason = 'no_start_signal';
  }
  return applyActiveGenerationStaleCutoff(
    {
      generating: st.generating,
      start_signal_at: toIso(st.startMs),
      last_activity_at: toIso(st.lastMs),
      inactive_reason: inactiveReason,
    },
    options
  );
}

/**
 * Active-generation snapshot for a paused/finished grok watch (resume + done→working re-arm).
 * null when the session's events.jsonl does not exist (yet).
 */
async function grokWatchActiveGenerationSince(sessionDir, options = {}) {
  const resolved = options.skipPathValidation
    ? path.resolve(String(sessionDir || ''))
    : assertAllowedGrokSessionDir(sessionDir, options.homeDir);
  const eventsPath = grokEventsPath(resolved);
  let text = '';
  let mtimeMs = 0;
  try {
    const stat = await fsp.stat(eventsPath);
    mtimeMs = stat.mtimeMs || 0;
    text = await readTailText(eventsPath, options.maxBytes || DEFAULT_TAIL_BYTES);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return classifyGrokActiveGenerationFromText(text, { mtimeMs, ...options });
}

async function readGrokSummary(sessionDir) {
  try {
    const json = JSON.parse(await fsp.readFile(grokSummaryPath(sessionDir), 'utf8'));
    if (!json || typeof json !== 'object') return null;
    const info = json.info && typeof json.info === 'object' ? json.info : {};
    return {
      session_id: typeof info.id === 'string' ? info.id : '',
      cwd: typeof info.cwd === 'string' ? info.cwd : '',
      model: typeof json.current_model_id === 'string' ? json.current_model_id : '',
      branch: typeof json.head_branch === 'string' ? json.head_branch : '',
      session_summary: typeof json.session_summary === 'string' ? json.session_summary.trim() : '',
      updated_at: typeof json.last_active_at === 'string' ? json.last_active_at : '',
    };
  } catch {
    return null;
  }
}

function stripUserQueryEnvelope(text) {
  const raw = String(text || '');
  const matches = [...raw.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)];
  const body = matches.length ? matches.map((m) => m[1] || '').join(' ') : raw;
  return body.replace(/\s+/g, ' ').trim();
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * User prompts from a session, newest-capable sources first:
 *   updates.jsonl user_message_chunk (per-session ACP mirror — the declared source; TURN-END flush)
 *   chat_history.jsonl user records (live at request time; <user_query> envelope stripped)
 * Returns { first, last } ('' when nothing readable — e.g. mid-first-turn before any flush).
 */
async function grokSessionPrompts(sessionDir, options = {}) {
  const prompts = [];
  try {
    const text = await readTailText(grokUpdatesPath(sessionDir), options.maxBytes || DEFAULT_UPDATES_TAIL_BYTES);
    for (const obj of parseJsonlLines(text)) {
      const update = obj && obj.params && obj.params.update && typeof obj.params.update === 'object'
        ? obj.params.update
        : null;
      if (!update || update.sessionUpdate !== 'user_message_chunk') continue;
      const t = stripUserQueryEnvelope(textFromContent(update.content));
      if (t) prompts.push(t);
    }
  } catch {
    /* updates.jsonl absent (turn-end flush) — fall through */
  }
  if (!prompts.length) {
    try {
      const text = await readTailText(path.join(sessionDir, 'chat_history.jsonl'), options.maxBytes || DEFAULT_UPDATES_TAIL_BYTES);
      for (const obj of parseJsonlLines(text)) {
        if (!obj || obj.type !== 'user') continue;
        const raw = textFromContent(obj.content);
        if (!/<user_query>/i.test(raw)) continue; // non-query user records are env/system context
        const t = stripUserQueryEnvelope(raw);
        if (t) prompts.push(t);
      }
    } catch {
      /* absent too — prompts stay empty */
    }
  }
  return { first: prompts[0] || '', last: prompts[prompts.length - 1] || '' };
}

/*
 * updates.jsonl records → LiveTurnEvents for the T2 narrative channel (prompt + note). PURE +
 * incremental, the parseGrokSessionEvents sibling: `state` carries the prompt-echo dedupe key and
 * the last agent message (the stop-text source) across bounded incremental reads; the adapter owns
 * the poll-guarded read and ring.append.
 *
 * What one record looks like (probe-verified, one FULL message per line):
 *   { timestamp: <epoch seconds>, method: 'session/update',
 *     params: { sessionId, update: { sessionUpdate: 'user_message_chunk'|'agent_thought_chunk'|
 *               'agent_message_chunk'|'tool_call'|'tool_call_update'|'turn_completed',
 *               content?: {type:'text', text} } } }
 *
 * Emission map (DATA HONESTY — only text-bearing narrative records become feed rows):
 *   user_message_chunk  → prompt ( <user_query> envelope stripped; consecutive identical prompts
 *                          deduped — a session reopen re-mirrors the same prompt )
 *   agent_thought_chunk → note (the model's reasoning — the pipeline groups thoughts under note)
 *   agent_message_chunk → note + state.lastAgentText (the adapter's stop text at turn_ended; the
 *                          final message therefore appears as BOTH the last note and stop.text —
 *                          the claude MessageDisplay/Stop.last_assistant_message precedent)
 *   tool_call / tool_call_update / turn_completed → nothing (the register + stop ride the LIVE
 *                          events.jsonl channel; double-emitting them here would duplicate rows)
 */
function parseGrokUpdatesRecords(records, state) {
  const st = state && typeof state === 'object' ? state : {};
  const events = [];
  for (const obj of Array.isArray(records) ? records : []) {
    if (!obj || typeof obj !== 'object') continue;
    const params = obj.params && typeof obj.params === 'object' ? obj.params : null;
    const update = params && params.update && typeof params.update === 'object' ? params.update : null;
    if (!update || typeof update.sessionUpdate !== 'string') continue;
    const tsRaw = Number(obj.timestamp);
    // updates.jsonl stamps epoch SECONDS (probe-verified); tolerate ms just in case.
    const absMs = Number.isFinite(tsRaw) && tsRaw > 0
      ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000)
      : st.lastUpdateMs || 0;
    if (absMs) st.lastUpdateMs = absMs;
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const text = stripUserQueryEnvelope(textFromContent(update.content));
        if (!text) break;
        const clamped = clamp(text, CAPS.promptText);
        if (!clamped || st.lastPromptText === clamped) break; // reopen echo — not a new turn
        st.lastPromptText = clamped;
        events.push({ abs_ms: absMs, kind: 'prompt', text: clamped });
        break;
      }
      case 'agent_thought_chunk': {
        const text = clamp(textFromContent(update.content), CAPS.noteText);
        if (text) events.push({ abs_ms: absMs, kind: 'note', text });
        break;
      }
      case 'agent_message_chunk': {
        const raw = textFromContent(update.content);
        if (raw && raw.trim()) st.lastAgentText = raw;
        const text = clamp(raw, CAPS.noteText);
        if (text) events.push({ abs_ms: absMs, kind: 'note', text });
        break;
      }
      default:
        break;
    }
  }
  return { events };
}

/**
 * The FINAL assistant text of the most recent completed turn: the last agent_message_chunk in
 * updates.jsonl (one full message per line — campaign-verified; on disk by turn end, so it is
 * always complete when the events.jsonl turn_ended has landed).
 */
async function grokStopTextFromUpdates(sessionDir, options = {}) {
  let text = '';
  try {
    text = await readTailText(grokUpdatesPath(sessionDir), options.maxBytes || DEFAULT_UPDATES_TAIL_BYTES);
  } catch {
    return '';
  }
  let last = '';
  for (const obj of parseJsonlLines(text)) {
    const update = obj && obj.params && obj.params.update && typeof obj.params.update === 'object'
      ? obj.params.update
      : null;
    if (!update || update.sessionUpdate !== 'agent_message_chunk') continue;
    const t = textFromContent(update.content);
    if (t && t.trim()) last = t;
  }
  return last;
}

/** Picker discovery: every session under the grok sessions root, newest first. */
async function discoverGrokRuns(homeDir = os.homedir(), options = {}) {
  const root = options.root ? path.resolve(options.root) : getGrokSessionsRoot(homeDir);
  const maxRuns = Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  let groups = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const runs = [];
  for (const group of groups) {
    let sessions = [];
    try {
      sessions = fs
        .readdirSync(path.join(root, group.name), { withFileTypes: true })
        .filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const sessionDir = path.join(root, group.name, session.name);
      const eventsPath = grokEventsPath(sessionDir);
      let st;
      try {
        st = fs.statSync(eventsPath);
      } catch {
        continue; // no events.jsonl yet — nothing watchable
      }
      let tailText = '';
      try {
        tailText = await readTailText(eventsPath, options.maxBytes || DEFAULT_TAIL_BYTES);
      } catch {
        tailText = '';
      }
      const summary = await readGrokSummary(sessionDir);
      const prompts = await grokSessionPrompts(sessionDir, options);
      const title = (summary && summary.session_summary) || clamp(prompts.first, CAPS.promptText) || '';
      runs.push({
        kind: 'ide_agent',
        provider: 'grok',
        source: 'local',
        surface: 'cli',
        session_id: (summary && summary.session_id) || session.name,
        session_dir: sessionDir,
        transcript_path: '',
        title,
        workspace_path: (summary && summary.cwd) || '',
        model: (summary && summary.model) || '',
        updated_at: (summary && summary.updated_at) || st.mtime.toISOString(),
        mtime_ms: st.mtimeMs || 0,
        last_user_preview: truncateCleanHumanPromptPreview(prompts.last, 10) || session.name,
        ...classifyGrokActiveGenerationFromText(tailText, {
          mtimeMs: st.mtimeMs || 0,
          nowMs: options.nowMs,
          activeStaleMs: options.activeStaleMs,
        }),
      });
    }
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return runs.slice(0, maxRuns);
}

/* ------------------------------------------------------------------ live feed
 * events.jsonl records → LiveTurnEvents (the parseCoworkAuditRecords analog). PURE + incremental:
 * `state` carries open tools / the pending gate / meta dedup / the held stop across bounded
 * incremental reads. NO disk I/O here — lib/grok_live_adapter.js owns the poll-guarded read,
 * the summary.json meta fields, the updates.jsonl stop-text pull, and ring.append.
 *
 * TIER-1 HONESTY: events.jsonl carries tool NAMES and gate KINDS only (no args, no question
 * payloads — those ride the agent→client RPCs). detail stays '', gate_open carries gate_kind
 * without questions, gate_answered carries waited_ms only (grok's own wait_ms when resolved).
 */

// Grok's always-approve bookkeeping logs a permission pair on EVERY tool call (wait_ms 0-4ms).
// Emitting those as gate rows would render a false gate flash per tool. The parser therefore
// HOLDS a permission_requested until either (a) its permission_resolved arrives in-batch —
// emitted as a gate pair only when wait_ms >= GROK_INSTANT_GATE_MS — or (b) the batch ends with
// it still pending (the live blocked case: emit gate_open now, gate_answered on resolution).
function parseGrokSessionEvents(records, state, extras = {}) {
  const st = state && typeof state === 'object' ? state : {};
  if (!Array.isArray(st.openTools)) st.openTools = []; // [{name, start_ms}] FIFO (no ids on disk)
  const events = [];
  const summary = extras.summary && typeof extras.summary === 'object' ? extras.summary : null;

  const emitMetaIfChanged = (absMs, model, cwd) => {
    const m = typeof model === 'string' ? model.trim() : '';
    const c = typeof cwd === 'string' ? cwd.trim() : '';
    if (!m && !c) return;
    const key = `${m}|${c}`;
    if (st.metaKey === key) return;
    st.metaKey = key;
    const ev = { abs_ms: absMs, kind: 'meta' };
    if (m) ev.model = m;
    if (c) ev.cwd = c;
    events.push(ev);
  };

  const emitPendingPermissionGateOpen = () => {
    const p = st.pendingPermission;
    if (!p || p.gateOpenEmitted) return;
    p.gateOpenEmitted = true;
    const gate = { abs_ms: p.start_ms, kind: 'gate_open', gate_kind: 'permission' };
    if (p.tool_name) gate.command = p.tool_name; // events.jsonl carries the tool name only
    events.push(gate);
  };

  for (const obj of Array.isArray(records) ? records : []) {
    if (!obj || typeof obj !== 'object') continue;
    const ts = eventTimeMs(obj) || st.lastTs || 0;
    if (ts) st.lastTs = ts;
    const toolName = typeof obj.tool_name === 'string' ? obj.tool_name.trim() : '';

    switch (obj.type) {
      case 'turn_started': {
        emitMetaIfChanged(
          ts,
          (typeof obj.model_id === 'string' && obj.model_id) || (summary && summary.model) || '',
          summary ? summary.cwd : ''
        );
        break;
      }
      case 'tool_started': {
        if (!toolName) break;
        if (toolName === GROK_QUESTION_TOOL) {
          events.push({ abs_ms: ts, kind: 'tool_start', name: toolName, detail: '' });
          events.push({ abs_ms: ts, kind: 'gate_open', gate_kind: 'question' });
          st.pendingQuestion = { start_ms: ts };
          break;
        }
        events.push({ abs_ms: ts, kind: 'tool_start', name: toolName, detail: '' });
        st.openTools.push({ name: toolName, start_ms: ts });
        break;
      }
      case 'permission_requested': {
        if (!toolName || toolName === GROK_QUESTION_TOOL) break; // question channel owns its pair
        st.pendingPermission = { tool_name: toolName, start_ms: ts, gateOpenEmitted: false };
        break;
      }
      case 'permission_resolved': {
        if (!toolName || toolName === GROK_QUESTION_TOOL) break;
        const p = st.pendingPermission;
        if (!p || p.tool_name !== toolName) break;
        const waited = Number.isFinite(obj.wait_ms) ? Math.max(0, obj.wait_ms) : Math.max(0, ts - p.start_ms);
        if (p.gateOpenEmitted || waited >= GROK_INSTANT_GATE_MS) {
          emitPendingPermissionGateOpen();
          events.push({ abs_ms: ts, kind: 'gate_answered', waited_ms: waited });
        }
        st.pendingPermission = null;
        break;
      }
      case 'tool_completed': {
        if (!toolName) break;
        const ok = obj.outcome !== 'error';
        if (toolName === GROK_QUESTION_TOOL) {
          const q = st.pendingQuestion;
          events.push({
            abs_ms: ts,
            kind: 'gate_answered',
            waited_ms: q ? Math.max(0, ts - q.start_ms) : 0,
          });
          events.push({ abs_ms: ts, kind: 'tool_end', name: toolName, detail: '', ok });
          st.pendingQuestion = null;
          break;
        }
        const idx = st.openTools.findIndex((t) => t && t.name === toolName);
        if (idx !== -1) st.openTools.splice(idx, 1);
        events.push({ abs_ms: ts, kind: 'tool_end', name: toolName, detail: '', ok });
        break;
      }
      case 'turn_ended': {
        // The adapter attaches stop text (updates.jsonl pull) and may HOLD a completed stop one
        // poll while the turn-end flush lands — parser just reports the terminal record.
        st.openTools = [];
        st.pendingPermission = null;
        st.pendingQuestion = null;
        if (obj.outcome === 'completed') {
          st.pendingStop = { abs_ms: ts, retries: 0 };
        }
        // cancelled turns emit no stop row (cowork precedent: cancel clears via task state)
        break;
      }
      default:
        break; // phase_changed / loop_started / first_token / yolo_toggled: no feed content
    }
  }
  // Batch ended with a permission still pending: this is a LIVE held gate — render it blocked.
  if (st.pendingPermission && !st.pendingPermission.gateOpenEmitted) emitPendingPermissionGateOpen();
  return { events };
}

module.exports = {
  DEFAULT_MAX_RUNS,
  DEFAULT_TAIL_BYTES,
  DEFAULT_UPDATES_TAIL_BYTES,
  GROK_QUESTION_TOOL,
  GROK_INSTANT_GATE_MS,
  getGrokHome,
  getGrokSessionsRoot,
  assertAllowedGrokSessionDir,
  resolveGrokSessionDirById,
  grokEventsPath,
  grokUpdatesPath,
  grokSummaryPath,
  parseJsonlLines,
  eventTimeMs,
  classifyGrokActiveGenerationFromText,
  grokTurnCompletedSince,
  grokWatchActiveGenerationSince,
  readGrokSummary,
  stripUserQueryEnvelope,
  grokSessionPrompts,
  grokStopTextFromUpdates,
  discoverGrokRuns,
  parseGrokSessionEvents,
  parseGrokUpdatesRecords,
};
