const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { assertValidRemoteSource, createSshRunner } = require('./remote_cursor_tracker');
const { applyActiveGenerationStaleCutoff, toIso } = require('./active_generation');

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_TAIL_BYTES = 512 * 1024;
const REMOTE_CODEX_ROOT = '$HOME/.codex/sessions';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizePosixAbsolute(p) {
  if (typeof p !== 'string') throw new Error('Path must be a string');
  const trimmed = p.trim();
  if (!trimmed.startsWith('/')) throw new Error('Path must be absolute');
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.') throw new Error('Path must be absolute');
  return normalized;
}

function posixPrefix(root) {
  return root.endsWith('/') ? root : `${root}/`;
}

function getCodexRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(homeDir, '.codex'));
}

function getCodexSessionsRoot(homeDir = os.homedir()) {
  return path.resolve(path.join(getCodexRoot(homeDir), 'sessions'));
}

function assertAllowedCodexTranscriptPath(transcriptPath, homeDir = os.homedir()) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) {
    throw new Error('transcript_path is required');
  }
  const resolved = path.resolve(transcriptPath.trim());
  const allowedRoot = getCodexSessionsRoot(homeDir);
  const prefix = allowedRoot.endsWith(path.sep) ? allowedRoot : `${allowedRoot}${path.sep}`;
  if (resolved !== allowedRoot && !resolved.startsWith(prefix)) {
    throw new Error('transcript_path must be under ~/.codex/sessions');
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('transcript_path must be a .jsonl file');
  }
  return resolved;
}

async function readTailText(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0 && text.length) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}

function parseCodexSessionIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return [];
  const raw = fs.readFileSync(indexPath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const sessionId = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!sessionId) continue;
    out.push({
      session_id: sessionId,
      title: typeof obj.thread_name === 'string' ? obj.thread_name.trim() : '',
      updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : '',
    });
  }
  return out;
}

function walkJsonlFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && full.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  return out;
}

function firstWords(text, maxWords = 10) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  const words = one.split(' ');
  if (words.length <= maxWords) return one;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

/**
 * Drop pasted terminal session lines (conda env, user@host, cwd, % prompt, command)
 * so the watch list shows the actual follow-up question when present on later lines.
 */
function stripLeadingShellSessionLines(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const isShellPromptLine = (line) => {
    const t = line.trim();
    if (!t) return false;
    const withConda = /^\([^)]*\)\s+\S+@\S+\s+\S+\s+[%$#>]\s*/.test(t);
    const noConda = /^\S+@\S+\s+\S+\s+[%$#>]\s*/.test(t);
    if (!(withConda || noConda)) return false;
    // Same line as a real question (e.g. after `% python … Can you …`) — do not drop the whole line.
    if (/\b(Can|Could|Why|How|What|Please|Is|Does|Did|Will|Would|Should|Explain|Summarize|Help|Check|Review)\b/i.test(t)) {
      return false;
    }
    return true;
  };
  let i = 0;
  while (i < lines.length && isShellPromptLine(lines[i])) i += 1;
  while (i < lines.length && !lines[i].trim()) i += 1;
  return lines.slice(i).join('\n');
}

function stripInlineShellPromptPrefix(text) {
  const t = String(text || '');
  if (t.includes('\n')) return t;
  return t.replace(/^(?:\([^)]*\)\s+)?\S+@\S+\s+\S+\s+[%$#>]\s+/, '').trim();
}

/** After zsh-style prompt removal, drop a pasted `python path/script.py` when real prose follows. */
function stripLeadingInterpreterLineBeforeProse(text) {
  const t = String(text || '').trim();
  const startsAsRun =
    /^(python3?|conda(?:\s+run)?|pip|npm|npx|node|yarn|pnpm)\s+\S/i.test(t) && (t.includes('/') || /\.(py|sh|mjs|cjs)\b/i.test(t));
  if (!startsAsRun) return t;
  const prose = /\s+(Can|Could|Why|How|What|Please|Is|Does|Did|Will|Would|Should|If|When|Where|Explain|Summarize|Help|Look|Check|Review|Tell|Give|Show|Walk|Debug|Fix)\b/i;
  const idx = t.search(prose);
  if (idx === -1) return '';
  return t.slice(idx).trim();
}

function cleanCodexPromptText(text) {
  let cleaned = String(text || '').trim();
  cleaned = stripLeadingShellSessionLines(cleaned);
  cleaned = stripInlineShellPromptPrefix(cleaned);
  cleaned = stripLeadingInterpreterLineBeforeProse(cleaned);
  const requestMatch = cleaned.match(/(?:^|\n)## My request for Codex:\s*([\s\S]*)$/i);
  if (requestMatch) cleaned = requestMatch[1].trim();
  const userQueryMatch = cleaned.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (userQueryMatch) cleaned = userQueryMatch[1].trim();
  return cleaned.replace(/\s+/g, ' ').trim();
}

function extractCodexUserText(obj) {
  const payload = obj?.payload;
  if (!payload || payload.type !== 'message' || payload.role !== 'user') return '';
  const content = payload.content;
  if (typeof content === 'string') return cleanCodexPromptText(content);
  if (!Array.isArray(content)) return '';
  const pieces = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') pieces.push(block.text);
    if (typeof block.content === 'string') pieces.push(block.content);
  }
  return cleanCodexPromptText(pieces.join('\n'));
}

/** Clean IDE scaffolding from a raw hook/transcript prompt, then truncate to maxWords. */
function codexPromptPreviewFromText(text, maxWords = 10) {
  const cleaned = cleanCodexPromptText(text);
  if (!cleaned) return '';
  return firstWords(cleaned, maxWords);
}

function latestCodexUserPreviewFromTailText(tailText, maxWords = 10) {
  if (!tailText) return '';
  const lines = tailText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = extractCodexUserText(obj);
    if (text) return firstWords(text, maxWords);
  }
  return '';
}

function extractCodexSessionMeta(tailText) {
  const out = { workspace_path: '' };
  if (!tailText) return out;
  for (const line of tailText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.type !== 'session_meta') continue;
    if (typeof obj.payload?.cwd === 'string') out.workspace_path = obj.payload.cwd;
    break;
  }
  return out;
}

function codexEventTimeMs(obj) {
  return Date.parse(obj?.timestamp || obj?.payload?.timestamp || '') || 0;
}

function parseCodexFunctionArguments(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.arguments && typeof payload.arguments === 'object') return payload.arguments;
  if (typeof payload.arguments !== 'string' || !payload.arguments.trim()) return null;
  try {
    return JSON.parse(payload.arguments);
  } catch {
    return null;
  }
}

function isCodexPermissionRequestFunctionCall(obj) {
  if (!obj || obj.type !== 'response_item') return false;
  const payload = obj.payload;
  if (!payload || payload.type !== 'function_call') return false;
  const args = parseCodexFunctionArguments(payload);
  return args?.sandbox_permissions === 'require_escalated';
}

// Codex sub-agent lifecycle in the PARENT rollout transcript:
//   spawn:  function_call name=spawn_agent → its function_call_output carries {"agent_id":"…"}
//   finish: a message whose text embeds <subagent_notification>{"agent_path":"<agent_id>",…}
// The notification is injected even when the parent turn already ended (task_complete), which is
// exactly what lets a watch held open for a still-running sub-agent clear at the real finish.
function isCodexSpawnAgentCall(obj) {
  return obj?.type === 'response_item'
    && obj?.payload?.type === 'function_call'
    && obj?.payload?.name === 'spawn_agent';
}

function codexSubagentNotificationId(obj) {
  const payload = obj?.payload;
  if (obj?.type !== 'response_item' || payload?.type !== 'message') return '';
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const part of content) {
    const text = typeof part?.text === 'string' ? part.text : '';
    if (!text.includes('<subagent_notification>')) continue;
    const m = text.match(/"agent_path"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return '';
}

function codexAgentIdFromSpawnOutput(payload) {
  const output = typeof payload?.output === 'string' ? payload.output : '';
  if (!output) return '';
  try {
    const parsed = JSON.parse(output);
    return typeof parsed?.agent_id === 'string' ? parsed.agent_id.trim() : '';
  } catch {
    const m = output.match(/"agent_id"\s*:\s*"([^"]+)"/);
    return m ? m[1] : '';
  }
}

// ---------------------------------------------------------------------------
// Self-scheduled wakeup automations ("heartbeats").
//
// codex can schedule a heartbeat automation (rollout: function_call name=automation_update,
// namespace=codex_app; hooks: tool_name=codex_appautomation_update) to wake its own thread,
// then END the turn — the model's message literally says "not marking it complete before that
// check", but codex has no way to signal "yielding, not done", so a task_complete follows and
// Orchestra used to clear the watch (codex-desktop background-wakeup false-clear, −188s/−209s,
// 2/2). Unlike claude's background shells there IS tool-specific knowledge here: the automation
// carries its own fire time (DTSTART), so the hold is naturally bounded — no timeout guessing.
//   - HOLD: a done that lands while an ACTIVE near-future heartbeat is pending is held until the
//     heartbeat fires (fresh records after the stale task_complete void it) or DTSTART + grace
//     passes with no wake (app quit — bounded release).
//   - HORIZON: only near-future fires hold (fire − done ≤ 10min). A far-future automation is a
//     scheduled job, not "coming right back" — same semantics as claude's session_crons, which
//     never block done.
const CODEX_HEARTBEAT_HOLD_HORIZON_MS = 10 * 60_000;
const CODEX_HEARTBEAT_FIRE_GRACE_MS = 120_000;

function isCodexAutomationToolName(name) {
  const n = String(name || '').trim();
  return n === 'codex_appautomation_update' || n === 'automation_update';
}

// The rollout's function_call arguments are a JSON STRING; hook bodies carry the same fields as
// an object (tool_input). Accept both.
function parseCodexAutomationArgs(value) {
  let args = value;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (!args || typeof args !== 'object') return null;
  return {
    mode: String(args.mode || '').toLowerCase(),
    kind: String(args.kind || '').toLowerCase(),
    status: String(args.status || '').toUpperCase(),
    id: String(args.id || '').trim(),
    name: String(args.name || '').trim(),
    rrule: String(args.rrule || ''),
  };
}

// Parse the automation's schedule. Both DTSTART forms occur in real rollouts:
//   "DTSTART:20260706T001251Z\nRRULE:FREQ=MINUTELY;COUNT=1"                       (UTC)
//   "DTSTART;TZID=America/Los_Angeles:20260706T094250\nRRULE:FREQ=DAILY;COUNT=1"  (local)
// The TZID form is parsed as THIS machine's local time (the codex app runs here; a remote in a
// different zone yields an imprecise fireAt, which the frequency-aware hold rule tolerates).
// period_ms is the RRULE FREQ's recurrence period — it decides what a MISSED first occurrence
// means (see codexHeartbeatHoldsDone).
const CODEX_RRULE_FREQ_PERIOD_MS = {
  SECONDLY: 1_000,
  MINUTELY: 60_000,
  HOURLY: 3_600_000,
  DAILY: 86_400_000,
  WEEKLY: 604_800_000,
  MONTHLY: 2_592_000_000,
  YEARLY: 31_536_000_000,
};

function codexHeartbeatScheduleFromRrule(rrule) {
  const text = String(rrule || '');
  const m = text.match(/DTSTART(?:;[^:\n]*)?:(\d{8}T\d{6})(Z?)/);
  let fireAtMs = 0;
  if (m) {
    const s = m[1];
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}${m[2] ? 'Z' : ''}`;
    fireAtMs = Date.parse(iso) || 0; // no Z → parsed as machine-local time
  }
  const f = text.match(/FREQ=([A-Z]+)/);
  const periodMs = f ? CODEX_RRULE_FREQ_PERIOD_MS[f[1]] || 0 : 0;
  return { fire_at_ms: fireAtMs, period_ms: periodMs };
}

// Back-compat helper (tests + callers that only need the instant).
function codexHeartbeatFireAtMs(rrule) {
  return codexHeartbeatScheduleFromRrule(rrule).fire_at_ms;
}

// Shared hold rule (transcript + hook store) — HYBRID semantics (2026-07-06):
//   - NEAR-FUTURE fire → HOLD, window anchored at the YIELD: codex defers heartbeat delivery
//     until the turn ends (a DTSTART that passed mid-turn fires only after the Stop; observed
//     wake lags: yield+38–56s), so the wait is measured from the yield Stop/task_complete, NOT
//     from the automation's creation. The first shipped version anchored at creation and missed
//     a live run whose model scheduled the heartbeat 146s before yielding (created+grace had
//     already lapsed at the Stop). Window: max(fireAt, yield) + grace.
//   - FAR-FUTURE fire (fireAt − yield > horizon) → NO hold: a wake scheduled that far out is a
//     scheduled job, not "coming right back" — claude session_crons semantics. The watch clears
//     at the yield and the wake's UserPromptSubmit re-arms done→working (applyCodexHookResume),
//     which also serves as the safety net for any hold miss.
//
// Clock note: DTSTART is an absolute stamp on the RECORDING clock, while yield/now are on the
// CALLER's clock (live: wall; replay: virtual — the replay rebases event times but cannot
// rewrite the DTSTART embedded in the tool arguments, so fireAt can sit far behind the anchor
// there). max(fireAt, anchor) makes fireAt an EXTENSION only when it is coherently ahead on the
// caller clock; under skew it degrades to yield+grace, which covers every observed wake lag.
//
// MISSED FIRST OCCURRENCE (fireAt already behind the anchor) is frequency-aware: codex delivers
// a missed short-period heartbeat (MINUTELY) as soon as the turn ends (observed yield+38–56s) —
// that is the genuine "coming right back" yield, hold anchor+grace. A missed LONG-period
// occurrence (DAILY etc. — the 16-41 live run scheduled a DAILY backup check and finished
// in-turn) fires at the NEXT period (tomorrow), which is a scheduled job: never hold; the wake
// re-arms when it eventually comes. Replay skew lands in the same branch and therefore grades
// exactly like live.
function codexHeartbeatHoldsDone(hb, yieldMs, nowMs) {
  if (!hb) return false;
  const anchor = yieldMs || hb.hold_started_ms || hb.holdStartedMs || hb.created_ms || hb.createdMs || 0;
  if (!anchor) return false;
  const fireAt = hb.fire_at_ms || hb.fireAtMs || 0;
  const periodMs = hb.period_ms || hb.periodMs || 0;
  if (fireAt && fireAt - anchor > CODEX_HEARTBEAT_HOLD_HORIZON_MS) return false;
  if (fireAt && fireAt < anchor && periodMs > CODEX_HEARTBEAT_HOLD_HORIZON_MS) return false;
  return nowMs < Math.max(fireAt, anchor) + CODEX_HEARTBEAT_FIRE_GRACE_MS;
}

/**
 * Sub-agent lifecycle state parsed from a parent Codex rollout transcript.
 * @returns {{spawned: Set<string>, pending: Set<string>, notified: Set<string>, last_notification_ms: number}}
 */
function codexTranscriptSubagentState(raw) {
  const spawnCallIds = new Set();
  const spawned = new Set();
  const pending = new Set();
  const notified = new Set();
  let lastNotificationMs = 0;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const payload = obj?.payload;
    if (isCodexSpawnAgentCall(obj)) {
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (callId) spawnCallIds.add(callId);
      continue;
    }
    if (obj?.type === 'response_item' && payload?.type === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (callId && spawnCallIds.has(callId)) {
        spawnCallIds.delete(callId);
        const agentId = codexAgentIdFromSpawnOutput(payload);
        if (agentId) {
          spawned.add(agentId);
          pending.add(agentId);
        }
      }
      continue;
    }
    const notifiedId = codexSubagentNotificationId(obj);
    if (notifiedId) {
      pending.delete(notifiedId);
      notified.add(notifiedId);
      const ts = codexEventTimeMs(obj);
      if (ts > lastNotificationMs) lastNotificationMs = ts;
    }
  }
  return { spawned, pending, notified, last_notification_ms: lastNotificationMs };
}

// Async local-file variant (watch poller): notified sub-agent ids from the watch's rollout file.
async function codexSubagentStateSince(transcriptPath, homeDir = os.homedir()) {
  const resolved = assertAllowedCodexTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return codexTranscriptSubagentState('');
    throw err;
  }
  return codexTranscriptSubagentState(raw);
}

// ---- Spawned-worker rollout liveness -------------------------------------------------------
// A spawn_agent worker writes its OWN rollout (rollout-<ts>-<agent_id>.jsonl) but — on the desktop
// surface — fires NO hooks, even for its tool calls. While it runs, the parent transcript is silent
// too (the <subagent_notification> lands only at the end). That rollout is therefore the ONLY live
// channel for "is the worker still going": task_complete/turn_aborted = finished; a recent record =
// working; a function_call without its output = command in flight (observed 27s+ execs). The watch
// poller uses these facts to hold a parent-Stop done-clear without a blind fixed backstop.

/** Pure facts from a worker rollout's parsed records: [{t_ms?, record}] or raw record rows. */
function codexAgentRolloutFactsFromRecords(rows) {
  let lastRecordMs = 0;
  let terminalMs = 0;
  const openCalls = new Set();
  for (const rowEntry of rows || []) {
    const record = rowEntry && typeof rowEntry === 'object' && rowEntry.record ? rowEntry.record : rowEntry;
    if (!record || typeof record !== 'object') continue;
    const ts = Number(rowEntry?.t_ms) || codexEventTimeMs(record) || 0;
    if (ts > lastRecordMs) lastRecordMs = ts;
    const payload = record.payload || {};
    const payloadType = payload.type;
    if (record.type === 'event_msg' && (payloadType === 'task_complete' || payloadType === 'turn_aborted')) {
      if (ts > terminalMs) terminalMs = ts;
      openCalls.clear();
      continue;
    }
    if (record.type !== 'response_item') continue;
    const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
    if (!callId) continue;
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') openCalls.add(callId);
    else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') openCalls.delete(callId);
  }
  return {
    found: lastRecordMs > 0,
    terminal_ms: terminalMs,
    last_record_ms: lastRecordMs,
    open_call: openCalls.size > 0,
  };
}

/** Find a worker's rollout file by its agent id (rollout filenames end in the id). */
function findCodexAgentRolloutPath(agentId, homeDir = os.homedir()) {
  const id = String(agentId || '').trim();
  if (!id) return '';
  const root = getCodexSessionsRoot(homeDir);
  if (!fs.existsSync(root)) return '';
  const suffix = `-${id}.jsonl`;
  for (const file of walkJsonlFiles(root)) {
    if (file.endsWith(suffix)) return file;
  }
  return '';
}

/** Live facts for a spawned worker: read its rollout (when discoverable) and parse. */
async function codexAgentRolloutFacts(agentId, homeDir = os.homedir()) {
  const rolloutPath = findCodexAgentRolloutPath(agentId, homeDir);
  if (!rolloutPath) return { found: false, terminal_ms: 0, last_record_ms: 0, open_call: false };
  let raw = '';
  try {
    raw = await fsp.readFile(rolloutPath, 'utf8');
  } catch {
    return { found: false, terminal_ms: 0, last_record_ms: 0, open_call: false };
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* partial trailing line */ }
  }
  return { ...codexAgentRolloutFactsFromRecords(rows), path: rolloutPath };
}

// ---- Remote (ssh) worker-rollout reader ----------------------------------------------------
// codex over ssh (CLI and the codex-desktop watch-only surface): a hook-silent spawn_agent
// worker's rollout lives in the REMOTE ~/.codex/sessions, so the local reader above can never
// find it — which used to leave ssh watches with only the 30s quiet backstop (early/late clears).
// This reader locates the worker rollout on the remote host by its `…-<agent_id>.jsonl` filename
// suffix and bounded-reads its tail in ONE ssh exec, then parses via the same pure
// codexAgentRolloutFactsFromRecords the local reader and replay use. The records that decide the
// hold (terminal task_complete/turn_aborted, recent activity, in-flight calls) live at the end of
// the file, and the JSONL parser skips a partial first line, so a tail read is safe; the only
// tail-vs-full divergence is an open call whose function_call record scrolled out of the window,
// which degrades to the same recency-based quiet hold the hooks-only view uses.
const CODEX_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function remoteCodexAgentRolloutFacts(remote, agentId, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const id = String(agentId || '').trim();
  // The id lands inside a remote shell command — refuse anything outside the rollout filename
  // charset rather than trying to quote around it.
  if (!id || !CODEX_AGENT_ID_RE.test(id)) {
    return { found: false, terminal_ms: 0, last_record_ms: 0, open_call: false };
  }
  const runSsh = options.runSsh || createSshRunner();
  const tailBytes =
    Number.isInteger(options.tailBytes) && options.tailBytes > 0 ? options.tailBytes : DEFAULT_TAIL_BYTES;
  const cmd =
    `f=$(find ${REMOTE_CODEX_ROOT} -type f -name '*-${id}.jsonl' 2>/dev/null | head -n 1); ` +
    `if [ -n "$f" ]; then tail -c ${String(tailBytes)} "$f" 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  const rows = [];
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* partial tail-boundary line */ }
  }
  return codexAgentRolloutFactsFromRecords(rows);
}

/**
 * Background-refreshed cache over remoteCodexAgentRolloutFacts, keyed per (host, agentId).
 * The watch poller's 2s tick must never block on a cold ssh exec, so `get` is synchronous:
 * cold cache returns null (the caller degrades to the quiet backstop — today's ssh behavior)
 * and schedules an async refresh; a warm cache returns the last-fetched facts for a precise
 * hold/release. Once a worker reads terminal it can never un-finish, so refreshes stop.
 * Mirrors the server's cursorChatDbRemoteCache pattern (in-flight dedupe + TTL).
 */
function createRemoteCodexAgentRolloutCache(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 3000;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 4000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const fetchFacts =
    typeof options.fetchFacts === 'function' ? options.fetchFacts : remoteCodexAgentRolloutFacts;
  const runSsh = options.runSsh; // optional injection; default resolved inside the fetch
  const cache = new Map(); // key (host\0agentId) -> { facts, at }
  const inFlight = new Set();

  function schedule(key, remote, agentId) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    Promise.resolve()
      .then(() => fetchFacts(remote, agentId, { runSsh, timeoutMs }))
      .then((facts) => {
        cache.set(key, { facts: facts || null, at: now() });
      })
      .catch(() => {
        // Transient ssh failure: keep the previous facts warm (a held worker must not lose its
        // hold to a dropped connection), but stamp the time so we do not hammer the remote.
        const prev = cache.get(key);
        cache.set(key, { facts: prev ? prev.facts : null, at: now() });
      })
      .finally(() => {
        inFlight.delete(key);
      });
  }

  function get(remote, agentId) {
    const host = remote && typeof remote.host === 'string' ? remote.host.trim() : '';
    const id = String(agentId || '').trim();
    if (!host || !id) return null;
    const key = `${host}\0${id}`;
    const cached = cache.get(key);
    const isTerminal = !!(cached && cached.facts && cached.facts.terminal_ms);
    if (!isTerminal && (!cached || now() - cached.at >= ttlMs)) schedule(key, remote, id);
    return cached ? cached.facts : null;
  }

  return { get };
}

function classifyCodexActiveGenerationFromText(raw, options = {}) {
  let generating = false;
  let startMs = 0;
  let lastMs = Number.isFinite(options.mtimeMs) ? options.mtimeMs : 0;
  let inactiveReason = 'no_start_signal';
  let pendingRequestCallId = null;
  let pendingPermissionCallId = null;

  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = codexEventTimeMs(obj);
    if (ts) lastMs = ts;
    const payload = obj?.payload;
    const payloadType = payload?.type;
    const userText = extractCodexUserText(obj);

    if (userText || payloadType === 'user_message' || payloadType === 'task_started') {
      generating = true;
      startMs = ts || lastMs || startMs;
      lastMs = ts || lastMs;
      inactiveReason = '';
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'task_complete') {
      generating = false;
      inactiveReason = 'completion_signal';
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'turn_aborted') {
      generating = false;
      inactiveReason = 'aborted';
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (isCodexPermissionRequestFunctionCall(obj)) {
      const callId = typeof payload.call_id === 'string' && payload.call_id.trim()
        ? payload.call_id.trim()
        : '__permission_request__';
      pendingPermissionCallId = callId;
      generating = false;
      inactiveReason = 'blocked_on_permission';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call' && payload?.name === 'request_user_input') {
      pendingRequestCallId = typeof payload.call_id === 'string' && payload.call_id.trim()
        ? payload.call_id.trim()
        : '__request_user_input__';
      generating = false;
      inactiveReason = 'blocked_on_user_input';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call_output') {
      const outCallId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (outCallId && pendingRequestCallId && outCallId === pendingRequestCallId) {
        pendingRequestCallId = null;
        generating = true;
        inactiveReason = '';
        startMs = ts || lastMs || startMs;
      }
      if (outCallId && pendingPermissionCallId && outCallId === pendingPermissionCallId) {
        pendingPermissionCallId = null;
        generating = true;
        inactiveReason = '';
        startMs = ts || lastMs || startMs;
      }
      continue;
    }
  }

  if (pendingPermissionCallId) {
    generating = false;
    inactiveReason = 'blocked_on_permission';
  } else if (pendingRequestCallId) {
    generating = false;
    inactiveReason = 'blocked_on_user_input';
  }

  return applyActiveGenerationStaleCutoff(
    {
      generating,
      start_signal_at: toIso(startMs),
      last_activity_at: toIso(lastMs),
      inactive_reason: inactiveReason,
    },
    options
  );
}

async function discoverCodexRuns(homeDir = os.homedir(), options = {}) {
  const sessionsRoot = getCodexSessionsRoot(homeDir);
  const indexPath = path.join(getCodexRoot(homeDir), 'session_index.jsonl');
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const fromIndex = parseCodexSessionIndex(indexPath);
  const indexById = new Map(fromIndex.map((row) => [row.session_id, row]));
  const files = walkJsonlFiles(sessionsRoot);
  const runs = [];
  for (const transcriptPath of files) {
    let st;
    try {
      st = fs.statSync(transcriptPath);
    } catch {
      continue;
    }
    const sessionId = path.basename(transcriptPath, '.jsonl');
    const idx = indexById.get(sessionId);
    runs.push({
      kind: 'ide_agent',
      provider: 'codex',
      source: 'local',
      session_id: sessionId,
      transcript_path: transcriptPath,
      title: idx?.title || '',
      workspace_path: '',
      updated_at: idx?.updated_at || '',
      mtime_ms: st.mtimeMs || 0,
      last_user_preview: '',
    });
  }
  runs.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  const top = runs.slice(0, maxRuns);
  await Promise.all(
    top.map(async (run) => {
      try {
        const tail = await readTailText(run.transcript_path);
        run.last_user_preview = latestCodexUserPreviewFromTailText(tail, 10);
        const meta = extractCodexSessionMeta(tail);
        run.workspace_path = meta.workspace_path || run.workspace_path;
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText(tail, {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
        if (!run.last_user_preview) {
          run.last_user_preview = run.title || run.session_id;
        }
      } catch {
        run.last_user_preview = run.title || run.session_id;
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText('', {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
      }
    })
  );
  return top;
}

async function codexTaskCompletedSince(transcriptPath, linkedAtIso, homeDir = os.homedir()) {
  const resolved = assertAllowedCodexTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.payload?.type !== 'task_complete') continue;
    const eventTs = Date.parse(obj.timestamp || '') || 0;
    if (!linkedAtMs || eventTs >= linkedAtMs) return true;
  }
  return false;
}

/**
 * Whether a Codex session transcript indicates the watch should clear: task finished after link,
 * user cancelled the turn after link, or Codex is blocked on user action
 * (`request_user_input` or a permission request not yet answered in the log).
 * @param {string} raw full transcript JSONL text
 * @param {string} linkedAtIso watch linked_at ISO time
 * @returns {''|'done'|'permission'|'question'} reason the watch should clear (falsy = keep waiting)
 */
function codexTranscriptShouldClearWatch(raw, linkedAtIso, opts = {}) {
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  // Latest terminal reason after link: 'done' (task_complete) or 'cancelled' (turn_aborted).
  let terminalReason = '';
  /** @type {string|null} */
  let pendingRequestCallId = null;
  /** @type {string|null} */
  let pendingPermissionCallId = null;
  // Sub-agent lifecycle: spawn_agent output opens an agent, its <subagent_notification> closes it.
  // A parent task_complete with a still-pending sub-agent must NOT clear the watch (the sub-agent
  // keeps working after the parent's Stop — the subagent-outlives-parent false clear).
  const spawnCallIds = new Set();
  const pendingSubagents = new Set();
  let sawSpawn = false;
  let sawTaskCompleteEver = false;
  let lastNotificationMs = 0;
  // Self-scheduled heartbeat automations (see the helpers above): call_id → pending entry while
  // the create's output has not landed; key (automationId|name|call_id) → entry once created.
  const heartbeatCalls = new Map();
  const pendingHeartbeats = new Map();
  let lastDoneMs = 0;

  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || '') || 0;
    const payload = obj?.payload;
    const payloadType = payload?.type;

    // Heartbeat wake detection: fresh MEANINGFUL records after a task_complete while a heartbeat
    // is pending mean the wake landed — the stale done is no longer the session's last word.
    // Void it (the wake turn's own task_complete re-sets it) and consume the heartbeat. Scoped to
    // pending-heartbeat sessions so ordinary post-Stop bookkeeping never voids a real done.
    if (
      pendingHeartbeats.size &&
      terminalReason === 'done' &&
      lastDoneMs &&
      ts > lastDoneMs &&
      (obj.type === 'response_item' || payloadType === 'task_started' || payloadType === 'user_message' || payloadType === 'agent_message')
    ) {
      pendingHeartbeats.clear();
      heartbeatCalls.clear();
      terminalReason = '';
    }

    if (payloadType === 'task_complete') {
      sawTaskCompleteEver = true;
      if (!linkedAtMs || ts >= linkedAtMs) {
        terminalReason = 'done';
        lastDoneMs = ts;
      }
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'turn_aborted') {
      if (!linkedAtMs || ts >= linkedAtMs) {
        terminalReason = 'cancelled';
      }
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      continue;
    }

    if (payloadType === 'user_message' || payloadType === 'task_started') {
      pendingRequestCallId = null;
      pendingPermissionCallId = null;
      // A genuinely new turn starts fresh sub-agent tracking; notification messages are
      // response_item/message records, so they never hit this reset.
      if (payloadType === 'task_started') {
        spawnCallIds.clear();
        pendingSubagents.clear();
        sawSpawn = false;
        lastNotificationMs = 0;
      }
      continue;
    }

    if (isCodexSpawnAgentCall(obj)) {
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (callId) spawnCallIds.add(callId);
      continue;
    }

    if (isCodexPermissionRequestFunctionCall(obj)) {
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      pendingPermissionCallId = callId || '__permission_request__';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call' && payload?.name === 'request_user_input') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      pendingRequestCallId = callId || '__request_user_input__';
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call' && isCodexAutomationToolName(payload?.name)) {
      const args = parseCodexAutomationArgs(payload.arguments);
      const callId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (args && args.mode === 'create' && args.kind === 'heartbeat' && args.status !== 'PAUSED') {
        const schedule = codexHeartbeatScheduleFromRrule(args.rrule);
        const hb = { created_ms: ts, fire_at_ms: schedule.fire_at_ms, period_ms: schedule.period_ms, name: args.name, id: args.id };
        pendingHeartbeats.set(args.id || args.name || callId || `__hb_${ts}__`, hb);
        if (callId) heartbeatCalls.set(callId, hb);
      } else if (args && args.mode && args.mode !== 'create') {
        // delete / pause / update: the model changed its plan (or the wake turn cleaned up) —
        // release the matching pending heartbeat (by id, then name; a bare op releases all).
        if (args.id && pendingHeartbeats.has(args.id)) pendingHeartbeats.delete(args.id);
        else if (args.name && pendingHeartbeats.has(args.name)) pendingHeartbeats.delete(args.name);
        else if (!args.id && !args.name) pendingHeartbeats.clear();
      }
      continue;
    }

    if (obj.type === 'response_item' && payloadType === 'function_call_output') {
      const outCallId = typeof payload.call_id === 'string' ? payload.call_id.trim() : '';
      if (outCallId && pendingRequestCallId && outCallId === pendingRequestCallId) {
        pendingRequestCallId = null;
      }
      if (outCallId && pendingPermissionCallId && outCallId === pendingPermissionCallId) {
        pendingPermissionCallId = null;
      }
      if (outCallId && spawnCallIds.has(outCallId)) {
        spawnCallIds.delete(outCallId);
        const agentId = codexAgentIdFromSpawnOutput(payload);
        if (agentId) {
          pendingSubagents.add(agentId);
          sawSpawn = true;
        }
      }
      if (outCallId && heartbeatCalls.has(outCallId)) {
        // The create's output carries the app-assigned automationId — re-key the pending entry
        // so a later delete/update (which references that id) can release it.
        const hb = heartbeatCalls.get(outCallId);
        heartbeatCalls.delete(outCallId);
        const output = Array.isArray(payload.output)
          ? payload.output.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
          : (typeof payload.output === 'string' ? payload.output : '');
        const m = output.match(/"automationId"\s*:\s*"([^"]+)"/);
        if (m && m[1]) {
          for (const [k, v] of pendingHeartbeats.entries()) {
            if (v === hb) pendingHeartbeats.delete(k);
          }
          pendingHeartbeats.set(m[1], { ...hb, id: m[1] });
        }
      }
      continue;
    }

    const notifiedId = codexSubagentNotificationId(obj);
    if (notifiedId) {
      pendingSubagents.delete(notifiedId);
      if (ts > lastNotificationMs) lastNotificationMs = ts;
      continue;
    }
  }

  // A pending permission / input request means the agent stopped blocked on you;
  // otherwise the latest terminal event decides done vs cancelled.
  if (pendingPermissionCallId !== null) return 'permission';
  if (pendingRequestCallId !== null) return 'question';
  // Parent finished but a spawned sub-agent has no completion notification yet: hold the
  // done — the sub-agent is (or may still be) working. Cancel is never held.
  if (terminalReason === 'done' && pendingSubagents.size) return '';
  // Parent finished but an ACTIVE near-future heartbeat it scheduled has not fired yet: hold —
  // the agent told us it is coming right back (the yield is a pause, not a finish). Bounded by
  // the heartbeat's own DTSTART + grace; a wake voids the stale done above instead.
  if (terminalReason === 'done' && pendingHeartbeats.size) {
    for (const hb of pendingHeartbeats.values()) {
      if (codexHeartbeatHoldsDone(hb, lastDoneMs, nowMs)) return '';
    }
  }
  // Parent's task_complete predates the link (e.g. the watch resumed after a post-Stop
  // sub-agent gate) but every spawned sub-agent has now notified completion after the link:
  // the last notification is the fresh done evidence.
  if (
    !terminalReason &&
    sawSpawn &&
    !pendingSubagents.size &&
    sawTaskCompleteEver &&
    lastNotificationMs &&
    (!linkedAtMs || lastNotificationMs >= linkedAtMs)
  ) {
    return 'done';
  }
  return terminalReason;
}

async function codexWatchShouldClearSince(transcriptPath, linkedAtIso, homeDir = os.homedir(), opts = {}) {
  const resolved = assertAllowedCodexTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return codexTranscriptShouldClearWatch(raw, linkedAtIso, opts);
}

// Active-generation classification of a local Codex transcript — used to detect that
// a paused (needs-input) watch has resumed.
async function codexWatchActiveGenerationSince(transcriptPath, homeDir = os.homedir()) {
  const resolved = assertAllowedCodexTranscriptPath(transcriptPath, homeDir);
  let raw = '';
  try {
    raw = await readTailText(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return classifyCodexActiveGenerationFromText(raw, {});
}

function assertAllowedRemoteCodexTranscriptPath(transcriptPath, codexRoot = REMOTE_CODEX_ROOT) {
  const resolved = normalizePosixAbsolute(transcriptPath);
  const rawRoot = String(codexRoot || REMOTE_CODEX_ROOT);
  if (rawRoot.includes('$HOME')) {
    const marker = '/.codex/sessions/';
    const exact = '/.codex/sessions';
    if (!resolved.includes(marker) && !resolved.endsWith(exact)) {
      throw new Error('Remote Codex transcript path must stay under ~/.codex/sessions');
    }
  } else {
    const root = normalizePosixAbsolute(rawRoot);
    const allowedPrefix = posixPrefix(root);
    if (resolved !== root && !resolved.startsWith(allowedPrefix)) {
      throw new Error('Remote Codex transcript path must stay under ~/.codex/sessions');
    }
  }
  if (!resolved.endsWith('.jsonl')) {
    throw new Error('Remote Codex transcript path must be a .jsonl file');
  }
  return resolved;
}

function parseRemoteCodexFindOutput(output) {
  const rows = [];
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [mtimeRaw, transcriptPathRaw] = line.split('\t');
    if (!mtimeRaw || !transcriptPathRaw) continue;
    const transcriptPath = transcriptPathRaw.trim();
    if (!transcriptPath.endsWith('.jsonl')) continue;
    const sessionId = path.posix.basename(transcriptPath, '.jsonl');
    rows.push({
      kind: 'ide_agent',
      provider: 'codex',
      source: 'ssh',
      session_id: sessionId,
      transcript_path: transcriptPath,
      title: '',
      workspace_path: '',
      updated_at: '',
      mtime_ms: Math.max(0, Number.parseFloat(mtimeRaw) * 1000) || 0,
      last_user_preview: '',
    });
  }
  rows.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return rows;
}

async function discoverRemoteCodexRuns(remote, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const maxRuns =
    Number.isInteger(options.maxRuns) && options.maxRuns > 0 ? options.maxRuns : DEFAULT_MAX_RUNS;
  const cmd =
    `find ${REMOTE_CODEX_ROOT} -type f -name '*.jsonl' -printf '%T@\\t%p\\n' 2>/dev/null | sort -nr | head -n ${String(
      maxRuns
    )}`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs);
  const runs = parseRemoteCodexFindOutput(stdout).slice(0, maxRuns);
  await Promise.all(
    runs.map(async (run) => {
      const q = shellQuote(run.transcript_path);
      const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
      try {
        const tail = await runSsh(cfg.host, tailCmd, options.timeoutMs);
        run.last_user_preview = latestCodexUserPreviewFromTailText(tail, 10) || run.session_id;
        const meta = extractCodexSessionMeta(tail);
        run.workspace_path = meta.workspace_path || '';
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText(tail, {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
      } catch {
        run.last_user_preview = run.session_id;
        Object.assign(
          run,
          classifyCodexActiveGenerationFromText('', {
            mtimeMs: run.mtime_ms,
            nowMs: options.nowMs,
            activeStaleMs: options.activeStaleMs,
          })
        );
      }
      run.host = cfg.host;
      run.projects_root = cfg.projects_root;
    })
  );
  return runs;
}

async function remoteCodexTaskCompletedSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  const linkedAtMs = Date.parse(linkedAtIso || '') || 0;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj?.payload?.type !== 'task_complete') continue;
    const eventTs = Date.parse(obj.timestamp || '') || 0;
    if (!linkedAtMs || eventTs >= linkedAtMs) return true;
  }
  return false;
}

async function remoteCodexWatchShouldClearSince(remote, transcriptPath, linkedAtIso, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const quotedPath = shellQuote(transcriptPath);
  const cmd = `if [ -f ${quotedPath} ]; then cat ${quotedPath} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  return codexTranscriptShouldClearWatch(raw, linkedAtIso, { nowMs: options.nowMs });
}

// Active-generation classification of a remote (ssh) Codex transcript — used to detect
// that a paused (needs-input) watch has resumed.
async function remoteCodexWatchActiveGenerationSince(remote, transcriptPath, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const runSsh = options.runSsh || createSshRunner();
  const q = shellQuote(transcriptPath);
  const cmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
  const raw = await runSsh(cfg.host, cmd, options.timeoutMs);
  if (!String(raw || '').trim()) return null;
  return classifyCodexActiveGenerationFromText(raw, {});
}

/**
 * Reconcile hook-store picker rows with the Codex session transcript so cancelled or
 * completed turns do not stay "active" when hooks never fired Stop.
 */
async function enrichCodexPickerRunWithTranscript(run, options = {}) {
  if (!run || typeof run !== 'object') return run;
  const out = { ...run };
  const transcriptPath = typeof run.transcript_path === 'string' ? run.transcript_path.trim() : '';
  if (!transcriptPath) return out;

  try {
    let tail = '';
    if (run.source === 'ssh' && options.remote) {
      const cfg = assertValidRemoteSource(options.remote);
      const runSsh = options.runSsh || createSshRunner();
      const q = shellQuote(transcriptPath);
      const tailCmd = `if [ -f ${q} ]; then tail -c ${DEFAULT_TAIL_BYTES} ${q} 2>/dev/null || true; fi`;
      tail = await runSsh(cfg.host, tailCmd, options.timeoutMs);
    } else {
      const resolved = assertAllowedCodexTranscriptPath(transcriptPath, options.homeDir);
      tail = await readTailText(resolved);
    }
    if (!String(tail || '').trim()) return out;
    const preview = latestCodexUserPreviewFromTailText(tail, 10);
    if (preview) out.last_user_preview = preview;
    Object.assign(
      out,
      classifyCodexActiveGenerationFromText(tail, {
        mtimeMs: run.mtime_ms,
        nowMs: options.nowMs,
        activeStaleMs: options.activeStaleMs,
      })
    );
    if (out.generating) {
      out.completion_hint = false;
    } else if (out.inactive_reason === 'completion_signal') {
      out.completion_hint = true;
    }
  } catch {
    // Keep hook-derived generation when the transcript is missing or unreadable.
  }
  return out;
}

module.exports = {
  DEFAULT_MAX_RUNS,
  assertAllowedCodexTranscriptPath,
  assertAllowedRemoteCodexTranscriptPath,
  discoverCodexRuns,
  discoverRemoteCodexRuns,
  codexTaskCompletedSince,
  codexTranscriptShouldClearWatch,
  codexTranscriptSubagentState,
  codexSubagentStateSince,
  codexAgentRolloutFactsFromRecords,
  findCodexAgentRolloutPath,
  codexAgentRolloutFacts,
  remoteCodexAgentRolloutFacts,
  createRemoteCodexAgentRolloutCache,
  codexSubagentNotificationId,
  CODEX_HEARTBEAT_HOLD_HORIZON_MS,
  CODEX_HEARTBEAT_FIRE_GRACE_MS,
  isCodexAutomationToolName,
  parseCodexAutomationArgs,
  codexHeartbeatFireAtMs,
  codexHeartbeatScheduleFromRrule,
  codexHeartbeatHoldsDone,
  codexWatchShouldClearSince,
  codexWatchActiveGenerationSince,
  remoteCodexTaskCompletedSince,
  remoteCodexWatchShouldClearSince,
  remoteCodexWatchActiveGenerationSince,
  latestCodexUserPreviewFromTailText,
  codexPromptPreviewFromText,
  classifyCodexActiveGenerationFromText,
  enrichCodexPickerRunWithTranscript,
};
