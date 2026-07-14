'use strict';

/*
 * live_agy_tail_adapter.js — Phase-2b agy/gemini transcript-tail adapter (Lane C §5 Seam B).
 *
 * WHY A TAIL AT ALL (the Phase-2b reconciliation): agy PreToolUse hooks DO carry the full
 * ask_question payload (`toolCall.args.questions` incl. `is_multi_select`) — that is genuine
 * PRODUCTION hook data (proven: gemini_hook_script.js:62 logs agy's RAW stdin to hook-debug.log
 * and forwards the SAME stdin to /api/gemini-hooks/event; tail_to_signal_recording.js:290-316
 * builds the recording body straight from that PAYLOAD line, never merging the transcript). So the
 * live-feed's T3 question payload flows from HOOKS (live_turn_normalizer.js normalizeGeminiEvent),
 * NOT this tail — the "agy hooks are lifecycle-only" claim in the older writeups was about the
 * lossy gemini_hook_STORE, not the raw hook body the live feed reads.
 *
 * WHAT THE HOOK BODY GENUINELY LACKS (and this adapter supplies from transcript_full.jsonl):
 *   - prompt text .......... agy PreInvocation carries no prompt → real turn boundaries (USER_INPUT)
 *   - note ................. mid-turn assistant chat text (PLANNER_RESPONSE `content`)
 *   - tool PURPOSE ......... `toolSummary`/`toolAction` — present in the transcript tool_call args,
 *                            ABSENT from the hook toolCall (the hook carries only args.questions for
 *                            ask_question / bare args for other tools) → detail enrichment
 *   - question ANSWERS ..... ASK_QUESTION step (`A1:/A2:/…`, empty line = skipped) → the hook's
 *                            gate_answered ships waited_ms only; the tail adds the picked answers
 *
 * NOT supplied here (deliberate, honesty over coverage):
 *   - permission gate_open: transcript_full.jsonl shows a run_command/write_to_file tool only as a
 *     DONE (or background-RUNNING) step — there is NO "awaiting permission" record. The real
 *     agy-cli permission gate is a TRANSIENT conversation-DB row (step_type=21/5/8, status=9;
 *     antigravity_cli_tracker.js), which the production watch pipeline already reads to set
 *     watch_finished.gate_kind='permission'. So the task-level blocked/permission STILL reports;
 *     only the per-event gate_open is out of this tail's honest reach (it would need the DB tail).
 *   - stop text: agy fires per-invocation Stops; the transcript's last PLANNER_RESPONSE is a note,
 *     not a handoff — we do not mis-read a snapshot's tail as a turn end.
 *
 * INTEGRATION (endpoint wiring is Phase-2b/3, not this module): each parsed unit is an ENTRY
 * `{ event, step_index, role }`. `event` is a clean LiveTurnEvent ({abs_ms, kind, ...payload}) —
 * NO merge metadata leaks into the served payload (the ring copies payload verbatim). `role` tells
 * the fill layer how to reconcile against the hook events already in the ring:
 *   - 'exclusive' (prompt, note)         → always append; hooks never emit these.
 *   - 'supersede' (gate_answered+answers)→ append AND drop the hook's bare gate_answered for the turn
 *                                          (the tail's is a strict superset: answers + waited_ms).
 *   - 'enrich'    (tool_start w/ purpose)→ copy `detail` onto the hook's matching tool_start
 *                                          (by name, in order); append only if hooks degraded.
 *   - 'fallback'  (gate_open question)   → append ONLY if no hook gate_open exists this turn
 *                                          (hooks are authoritative per the reconciliation).
 * `deriveAgyTailEvents().events` is the flat clean stream (entries.map(e=>e.event)) for standalone /
 * hooks-degraded use and for the unit fixtures.
 *
 * FAIL-SAFE: every disk read is bounded + try/catch (a cold/rotated/truncated transcript yields an
 * empty result, never a throw — the cell degrades to the hook tier, never blocks the endpoint), and
 * the reader is debounced via poll_guard.wrapShortTtlMemo. Reads are incremental (byte offset per
 * file); a trailing partial line is held back so a half-written record is never parsed.
 */

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const {
  CAPS,
  clamp,
  summarizeToolInput,
  normalizeQuestions,
  stripUserRequestXml,
  providerLogKey,
} = require('./live_turn_normalizer');
const { isAntigravityTranscriptPath } = require('./antigravity_hook_signals');
const { isTaskNotification } = require('./done_detection');
const { wrapShortTtlMemo, wrapNonOverlapping } = require('./poll_guard');

const AGY_TAIL_TTL_MS = 1500; // debounce window for the disk tail (< the 2s live-feed poll)
const MAX_TAIL_READ_BYTES = 512 * 1024; // bounded incremental read per tick (SSH byte discipline)
const TRANSCRIPT_FULL_SUFFIX = path.join('.system_generated', 'logs', 'transcript_full.jsonl');

/* --------------------------------------------------------------- record parse */

/**
 * Parse transcript_full.jsonl TEXT into records, tolerating a trailing partial (un-newlined) line.
 * Returns { records, consumedBytes } — consumedBytes is the byte length up to and including the
 * last COMPLETE line's newline, so a byte-offset caller can resume without re-reading or splitting
 * a half-written record. Malformed lines are skipped (best-effort), never thrown.
 */
function parseAgyTranscriptRecords(text) {
  const raw = typeof text === 'string' ? text : '';
  const records = [];
  if (!raw) return { records, consumedBytes: 0 };
  // The last line is "complete" only if the text ends with a newline; otherwise hold it back.
  const endsComplete = /\n$/.test(raw);
  const lines = raw.split('\n');
  const lastIdx = lines.length - 1;
  let consumedChars = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isTrailingPartial = i === lastIdx && !endsComplete;
    if (isTrailingPartial) break; // hold the partial line for the next read
    // account for this line + its '\n' toward consumedChars (the final complete line has a '\n')
    consumedChars += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // malformed / truncated mid-object — skip
    }
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec);
  }
  // consumedBytes in UTF-8 (offsets are byte offsets); cap at the text's byte length.
  const consumedBytes = Math.min(
    Buffer.byteLength(raw, 'utf8'),
    Buffer.byteLength(raw.slice(0, consumedChars), 'utf8'),
  );
  return { records, consumedBytes };
}

function recordStepIndex(rec) {
  const n = Number(rec && rec.step_index);
  return Number.isFinite(n) ? n : null;
}

function recordAbsMs(rec) {
  const t = Date.parse((rec && rec.created_at) || '');
  return Number.isFinite(t) ? t : null;
}

/** toolSummary/toolAction (transcript args OR hook toolCall level) → one-line detail; else args. */
function agyTranscriptToolDetail(toolCall) {
  const tc = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = args.toolSummary || args.toolAction || tc.toolSummary || tc.toolAction;
  if (typeof summary === 'string' && summary.trim()) return clamp(summary, CAPS.detail);
  return summarizeToolInput(args);
}

/**
 * Parse an ASK_QUESTION step's `content` into positional answers + waited_ms.
 *   "Created At: <iso>\nCompleted At: <iso>\nA1: <answer>\nA2: <answer>\nA3: "
 * A blank answer (e.g. "A3: ") = the user SKIPPED that question → '' at that position (honest;
 * never fabricated). waited_ms = Completed − Created when both timestamps parse.
 * Returns { answers, waited_ms, answered_count } (answers is [] when the step named no A-lines).
 */
function parseAskQuestionContent(content) {
  const text = typeof content === 'string' ? content : '';
  const out = { answers: [], waited_ms: null, answered_count: 0 };
  if (!text) return out;
  const createdM = text.match(/^Created At:\s*(.+)$/m);
  const completedM = text.match(/^Completed At:\s*(.+)$/m);
  if (createdM && completedM) {
    const c = Date.parse(createdM[1].trim());
    const d = Date.parse(completedM[1].trim());
    if (Number.isFinite(c) && Number.isFinite(d) && d >= c) out.waited_ms = d - c;
  }
  const byIndex = new Map();
  let maxIdx = 0;
  const re = /^A(\d+):[ \t]?(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1]);
    if (!Number.isFinite(idx) || idx < 1) continue;
    const value = clamp(m[2] || '', CAPS.answerValue);
    byIndex.set(idx, value);
    if (idx > maxIdx) maxIdx = idx;
  }
  if (maxIdx > 0) {
    const answers = [];
    for (let i = 1; i <= Math.min(maxIdx, CAPS.maxQuestions); i += 1) {
      const v = byIndex.has(i) ? byIndex.get(i) : '';
      answers.push(v);
      if (v) out.answered_count += 1;
    }
    out.answers = answers;
  }
  return out;
}

/* --------------------------------------------------------------- record → entries */

/**
 * One transcript record → zero-or-more ENTRIES `{ event, step_index, role }`.
 * `event` is a clean LiveTurnEvent ({abs_ms, kind, ...payload}); `role` drives reconciliation
 * (see the file header). Emits NOTHING for records that are pure hook-covered lifecycle
 * (RUN_COMMAND/CODE_ACTION/VIEW_FILE/GENERIC/CHECKPOINT/CONVERSATION_HISTORY) — those are already
 * the hook stream's tool_end pings; the tail adds no content there.
 */
function recordToEntries(rec, absFallback) {
  const stepIndex = recordStepIndex(rec);
  const absMs = recordAbsMs(rec) ?? absFallback ?? Date.now();
  const type = String((rec && rec.type) || '').trim();
  const entries = [];
  const push = (event, role) => entries.push({ event, step_index: stepIndex, role });

  switch (type) {
    case 'USER_INPUT': {
      // Real turn boundary. agy wraps the prompt in <USER_REQUEST>…</USER_REQUEST>.
      const text = stripUserRequestXml(rec.content || '');
      const clamped = clamp(text, CAPS.promptText);
      if (clamped && !isTaskNotification(text)) {
        push({ abs_ms: absMs, kind: 'prompt', text: clamped }, 'exclusive');
      }
      break;
    }
    case 'PLANNER_RESPONSE': {
      // Mid-turn assistant chat text → note (thinking is intentionally NOT surfaced — verbose
      // internal reasoning; the scope's note = PLANNER_RESPONSE text).
      const noteText = clamp(rec.content || '', CAPS.noteText);
      if (noteText) push({ abs_ms: absMs, kind: 'note', text: noteText }, 'exclusive');
      const toolCalls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const name = String(tc.name || '').trim();
        if (!name) continue;
        const detail = agyTranscriptToolDetail(tc);
        // tool_start carries the tail's UNIQUE contribution (purpose string) → enrich the hook's.
        push({ abs_ms: absMs, kind: 'tool_start', name, detail }, 'enrich');
        if (name === 'ask_question') {
          const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
          const questions = normalizeQuestions(Array.isArray(args.questions) ? args.questions : null);
          const gate = { abs_ms: absMs, kind: 'gate_open', gate_kind: 'question' };
          if (questions) gate.questions = questions;
          // FALLBACK: hooks are the authoritative question source (reconciliation verdict). The
          // fill layer appends this only when no hook gate_open exists for the turn.
          push(gate, 'fallback');
        }
      }
      break;
    }
    case 'ASK_QUESTION': {
      // The gate RESOLUTION carries the picked answers (the one thing the hook can't know).
      const parsed = parseAskQuestionContent(rec.content || '');
      const ev = { abs_ms: absMs, kind: 'gate_answered' };
      if (parsed.answers.length) ev.answers = parsed.answers;
      if (parsed.waited_ms != null) ev.waited_ms = parsed.waited_ms;
      push(ev, 'supersede');
      break;
    }
    default:
      break; // hook-covered lifecycle / result records — no tail content
  }
  return entries;
}

/**
 * Records → { entries, lastStepIndex }, filtered to step_index > sinceStepIndex (offset resume via
 * the monotonic step cursor). Records with no step_index are always processed (rare/legacy) but do
 * not move the cursor. `lastStepIndex` = the max step_index observed (>= sinceStepIndex).
 */
function agyTailEntriesFromRecords(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const sinceStepIndex = Number.isFinite(options.sinceStepIndex) ? options.sinceStepIndex : -1;
  const entries = [];
  let lastStepIndex = sinceStepIndex;
  let absFallback = Number.isFinite(options.baseAbsMs) ? options.baseAbsMs : Date.now();
  for (const rec of list) {
    const stepIndex = recordStepIndex(rec);
    if (stepIndex != null && stepIndex <= sinceStepIndex) {
      if (stepIndex > lastStepIndex) lastStepIndex = stepIndex;
      continue;
    }
    const recEntries = recordToEntries(rec, absFallback);
    for (const e of recEntries) {
      entries.push(e);
      if (Number.isFinite(e.event.abs_ms)) absFallback = e.event.abs_ms;
    }
    if (stepIndex != null && stepIndex > lastStepIndex) lastStepIndex = stepIndex;
  }
  return { entries, lastStepIndex };
}

/**
 * Convenience: transcript TEXT → { entries, events, lastStepIndex }. `events` is the flat clean
 * LiveTurnEvent stream (for standalone/degraded use + unit fixtures); `entries` carries the
 * reconciliation roles for endpoint wiring.
 */
function deriveAgyTailEvents(options = {}) {
  const { records } = parseAgyTranscriptRecords(options.text || '');
  const { entries, lastStepIndex } = agyTailEntriesFromRecords(records, options);
  return { entries, events: entries.map((e) => e.event), lastStepIndex };
}

/* --------------------------------------------------------------- attribution / discovery */

function expandHome(p, homeDir = os.homedir()) {
  const s = typeof p === 'string' ? p.trim() : '';
  if (!s) return '';
  if (s === '~') return homeDir;
  if (s.startsWith('~/')) return path.join(homeDir, s.slice(2));
  return s;
}

/**
 * Resolve the transcript_full.jsonl path for a watch/hook body (attribution). Prefers an explicit
 * transcriptPath (the hook body carries one pointing at transcript_full.jsonl), then derives from
 * the artifact directory / conversation id (InFlight discovery pattern: convId = DB/brain basename).
 * Returns '' when nothing resolvable — the caller then omits the tail (fail-safe).
 */
function agyTranscriptFullPath(source, homeDir = os.homedir()) {
  const s = source && typeof source === 'object' ? source : {};
  const explicit =
    expandHome(s.transcript_full_path, homeDir) ||
    expandHome(s.transcriptPath, homeDir) ||
    expandHome(s.transcript_path, homeDir);
  if (explicit) {
    // A transcript.jsonl reference resolves to its sibling transcript_full.jsonl (the tail source).
    if (explicit.endsWith(`${path.sep}transcript.jsonl`)) {
      return explicit.replace(/transcript\.jsonl$/, 'transcript_full.jsonl');
    }
    return explicit;
  }
  const artifactDir = expandHome(s.artifactDirectoryPath || s.artifact_directory_path, homeDir);
  if (artifactDir) return path.join(artifactDir, TRANSCRIPT_FULL_SUFFIX);
  return '';
}

/* --------------------------------------------------------------- disk tail reader */

async function readFileTail(filePath, startOffset, maxBytes) {
  const st = await fsp.stat(filePath);
  const size = st.size;
  const from = Number.isFinite(startOffset) && startOffset >= 0 && startOffset <= size ? startOffset : 0;
  if (size <= from) return { text: '', size, from };
  const len = Math.min(size - from, maxBytes);
  // Read the TAIL window when the delta exceeds the budget (bounded SSH/byte discipline): resume
  // from (size - len) so we always see the freshest records, never an unbounded backlog.
  const readFrom = size - from > maxBytes ? size - len : from;
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, readFrom);
    return { text: buf.slice(0, bytesRead).toString('utf8'), size, from: readFrom };
  } finally {
    await fh.close();
  }
}

/**
 * Stateful, fail-safe, debounced transcript-tail reader. Keeps a per-file byte offset + step cursor
 * so repeated ticks read only the appended slice and never re-emit a record. Every read is bounded
 * and wrapped so a cold/rotated/truncated file yields `{ entries: [], events: [] }` — never a throw.
 *
 *   const reader = createAgyTailReader();
 *   const { entries, events, lastStepIndex } = await reader.read(transcriptFullPath);
 */
function createAgyTailReader(options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_TAIL_READ_BYTES;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : AGY_TAIL_TTL_MS;
  // state[filePath] = { offset, lastStepIndex }
  const state = new Map();
  const EMPTY = { entries: [], events: [], lastStepIndex: -1 };

  async function readOnce(filePath) {
    if (typeof filePath !== 'string' || !filePath) return EMPTY;
    const prev = state.get(filePath) || { offset: 0, lastStepIndex: -1 };
    let slice;
    try {
      slice = await readFileTail(filePath, prev.offset, maxBytes);
    } catch {
      return { entries: [], events: [], lastStepIndex: prev.lastStepIndex }; // cold/missing → omit
    }
    // Truncation / rotation guard: file shrank below our offset → restart from the read window.
    let sinceStep = prev.lastStepIndex;
    if (slice.from < prev.offset) sinceStep = -1; // window reset ⇒ re-derive step cursor from records
    const { records, consumedBytes } = parseAgyTranscriptRecords(slice.text);
    const { entries, lastStepIndex } = agyTailEntriesFromRecords(records, {
      sinceStepIndex: sinceStep,
    });
    const nextOffset = slice.from + consumedBytes;
    state.set(filePath, {
      offset: nextOffset,
      lastStepIndex: Math.max(prev.lastStepIndex, lastStepIndex),
    });
    return { entries, events: entries.map((e) => e.event), lastStepIndex };
  }

  // PER-FILE debounce: wrapShortTtlMemo shares one result across ALL args, so a single global memo
  // would hand task B's read task A's result. The endpoint reads many task transcripts per poll →
  // memoize per path (each a zero-arg reader, the shape wrapShortTtlMemo is built for).
  const memos = new Map();
  function read(filePath) {
    if (typeof filePath !== 'string' || !filePath) return Promise.resolve({ ...EMPTY });
    let memo = memos.get(filePath);
    if (!memo) {
      memo = wrapShortTtlMemo(() => readOnce(filePath), ttlMs);
      memos.set(filePath, memo);
    }
    return memo();
  }
  return {
    read,
    // undebounced (tests / one-shot): still fail-safe + offset-tracked.
    readNow: readOnce,
    reset: (filePath) => {
      if (filePath) {
        state.delete(filePath);
        memos.delete(filePath);
      } else {
        state.clear();
        memos.clear();
      }
    },
    _state: state,
  };
}

/* --------------------------------------------------------------- live pump adapter (2b wiring) */

// Env kill-switch (default ON, mirroring the codex rollout-notes flag). The agy tail is local-only
// bounded reads; the flag exists so a frugal setup can drop the disk cost entirely.
const AGY_TAIL_FLAG_ENV = 'ORCHESTRA_LIVEFEED_AGY_TRANSCRIPT_TAIL';
const DEFAULT_PUMP_TTL_MS = 1000; // debounce inside the 2s poll cadence (codex parity)
const DEFAULT_PUMP_MAX_TASKS = 100; // LRU cap on per-task tail state (codex parity)
// First-read floor grace: when a watch links MID-turn (ring already reconstructed from the hook
// replay), tail rows older than ring t0 minus this grace are a PRIOR turn's — dropped, so stale
// notes/prompts never pollute the in-progress turn. USER_INPUT precedes the first hook by <1s.
const FIRST_READ_FLOOR_GRACE_MS = 5000;

/** Default flag state: ON unless the env var is explicitly a falsy-off token. */
function agyTailEnvFlagEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env[AGY_TAIL_FLAG_ENV] || '').trim());
}

/**
 * Create the agy/gemini transcript_full.jsonl tail adapter for the live-feed service's
 * `tailAdapters` seam. `pump(taskId, wt, nowMs)` is SYNC and non-blocking: it schedules a
 * debounced, non-overlapping background tail whose events land on the task's ring for the next
 * poll. Local agy watches only (ssh = Phase 3); hooks remain authoritative for the question gate.
 *
 * RECONCILIATION (applies this module's entry roles against the live ring, where hook events
 * already flow — see the file header):
 *  - prompt (exclusive): a prompt APPEND resets the ring turn (wiping retained events), so it is
 *    appended ONLY when the ring's current turn holds content STRICTLY OLDER than the prompt
 *    (a previous turn is retained → a boundary is genuinely due) or holds no content at all.
 *    When all retained content is newer (a watch linked mid-turn: the hook replay already
 *    reconstructed THIS turn), the late prompt is suppressed — never destroy a served gate for a
 *    cosmetic row. A legit reset that wipes the first ~2s of new-turn hook rows self-heals: the
 *    same tail batch re-supplies tool_start (enrich-miss → append) and the question gate_open
 *    (fallback-miss → append); later hook events append normally.
 *  - note (exclusive): always append (hooks never carry mid-turn text).
 *  - tool_start (enrich): the nth tail occurrence of a name maps to the nth ring tool_start of
 *    that name in the current turn — when present, its `detail` is UPDATED IN PLACE with the
 *    tail's purpose string (toolSummary/toolAction; the hook body lacks it). No matching ring
 *    event (plain tools surface no content-bearing PreToolUse) → append the tail's own. In-place
 *    updates reach full snapshots and new pollers; a delta client that already holds the row sees
 *    it on the next turn reset (documented residual).
 *  - gate_open question (fallback): skipped when the ring's current turn already has a question
 *    gate_open beyond the applied count (hooks authoritative per the §1 reconciliation); appended
 *    only when hooks degraded. NEVER a permission gate (recordToEntries never emits one).
 *  - gate_answered (supersede): the tail's answers are merged INTO the ring's bare hook
 *    gate_answered (answers set; hook waited_ms kept when present — it is the observed wall
 *    clock); no ring event → append the tail's own.
 *
 * FAIL-SAFE: pump never throws; a missing/rotated/truncated transcript yields no events and the
 * cell keeps serving the hook tier. All reads are bounded (maxBytes window) + offset-incremental.
 *
 * @param {object} options
 * @param {object} options.ring       the live-feed service's ring (append/enrich target)
 * @param {boolean|Function} [options.enabled]  static bool or predicate; default = env flag
 * @param {string} [options.homeDir]  home for ~ expansion in transcript paths (tests inject)
 * @param {Function} [options.now]    clock (tests)
 * @param {number} [options.ttlMs]    pump debounce (default 1000ms)
 * @param {number} [options.maxBytes] per-pass read window (default MAX_TAIL_READ_BYTES)
 * @param {number} [options.maxTasks] LRU cap on per-task state (default 100)
 */
function createAgyTranscriptTailAdapter(options = {}) {
  const ring = options.ring || null;
  const homeDir = options.homeDir || os.homedir();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_PUMP_TTL_MS;
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_TAIL_READ_BYTES;
  const maxTasks =
    Number.isInteger(options.maxTasks) && options.maxTasks > 0 ? options.maxTasks : DEFAULT_PUMP_MAX_TASKS;
  const enabledOpt = options.enabled;

  function enabled() {
    if (typeof enabledOpt === 'function') return !!enabledOpt();
    if (typeof enabledOpt === 'boolean') return enabledOpt;
    return agyTailEnvFlagEnabled();
  }

  // Local agy/gemini ide_agent watches only: same slice predicate the service's hook fill uses,
  // narrowed to local (ssh transcript reads are Phase-3; see agy-2b-notes.md §SSH).
  function isLocalAgyWatch(wt) {
    return !!wt && typeof wt === 'object' && wt.source !== 'ssh' && providerLogKey(wt) === 'gemini';
  }

  /** @type {Map<string, object>} taskId → per-task tail state. Map insertion order = LRU. */
  const states = new Map();

  function evictLru() {
    while (states.size > maxTasks) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  }

  function ensureState(taskId, transcriptPath) {
    const key = String(taskId || '');
    let s = states.get(key);
    if (s && s.path !== transcriptPath) {
      // Re-linked to a different conversation: fresh offsets, no stale carry-over.
      states.delete(key);
      s = null;
    }
    if (!s) {
      s = {
        path: transcriptPath,
        offset: null, // null ⇒ first read (window-capped catch-up)
        lastStepIndex: -1,
        lastReadAt: -Infinity, // first pump always schedules, even with a 0 clock
        turn: null, // per-turn reconciliation counters {id, toolStartApplied, gateOpenApplied, gateAnsweredApplied}
        tail: null,
      };
      s.tail = wrapNonOverlapping(() => tailOnce(key));
      states.set(key, s);
      evictLru();
    } else {
      states.delete(key);
      states.set(key, s); // LRU touch
    }
    return s;
  }

  /** Apply tail entries to the ring per their reconciliation role. Returns applied-change count. */
  function applyEntries(taskId, entries) {
    if (!ring || !entries.length) return 0;
    const s = states.get(String(taskId || ''));
    if (!s) return 0;
    let applied = 0;
    for (const en of entries) {
      const ev = en.event;
      if (!ev || typeof ev !== 'object') continue;
      const re = ring.ensure(taskId);
      if (!s.turn || s.turn.id !== re.turn_id) {
        s.turn = { id: re.turn_id, toolStartApplied: new Map(), gateOpenApplied: 0, gateAnsweredApplied: 0 };
      }
      if (ev.kind === 'prompt') {
        const content = re.events.filter((e) => e.kind !== 'meta');
        const hasOlder = content.some((e) => re.t0_abs_ms + e.t < ev.abs_ms);
        if (content.length && !hasOlder) continue; // late prompt for the in-progress turn: never wipe
        ring.append(taskId, [ev]); // resets the turn; counters refresh on the next entry
        applied += 1;
        continue;
      }
      if (ev.kind === 'note') {
        ring.append(taskId, [ev]);
        applied += 1;
        continue;
      }
      if (ev.kind === 'tool_start') {
        const idx = s.turn.toolStartApplied.get(ev.name) || 0;
        const matches = re.events.filter((e) => e.kind === 'tool_start' && e.name === ev.name);
        if (matches.length > idx) {
          const target = matches[idx];
          if (ev.detail && target.detail !== ev.detail) {
            target.detail = ev.detail; // purpose enrichment (toolSummary/toolAction)
            applied += 1;
          }
        } else {
          ring.append(taskId, [ev]); // hooks carried no content PreToolUse for this call
          applied += 1;
        }
        s.turn.toolStartApplied.set(ev.name, idx + 1);
        continue;
      }
      if (ev.kind === 'gate_open') {
        if (ev.gate_kind !== 'question') continue; // defense-in-depth: tail never opens a permission gate
        const matches = re.events.filter((e) => e.kind === 'gate_open' && e.gate_kind === 'question');
        if (matches.length > s.turn.gateOpenApplied) {
          s.turn.gateOpenApplied += 1; // hook gate present — authoritative, skip the tail copy
          continue;
        }
        ring.append(taskId, [ev]);
        s.turn.gateOpenApplied += 1;
        applied += 1;
        continue;
      }
      if (ev.kind === 'gate_answered') {
        const matches = re.events.filter((e) => e.kind === 'gate_answered');
        if (matches.length > s.turn.gateAnsweredApplied) {
          const target = matches[s.turn.gateAnsweredApplied];
          if (ev.answers) target.answers = ev.answers;
          if (target.waited_ms == null && ev.waited_ms != null) target.waited_ms = ev.waited_ms;
          s.turn.gateAnsweredApplied += 1;
          applied += 1;
          continue;
        }
        ring.append(taskId, [ev]);
        s.turn.gateAnsweredApplied += 1;
        applied += 1;
        continue;
      }
      ring.append(taskId, [ev]); // no other kinds are emitted today; append verbatim if one appears
      applied += 1;
    }
    return applied;
  }

  /** One background tail pass: bounded incremental read → entries → role-aware apply. Never throws. */
  async function tailOnce(taskId) {
    const key = String(taskId || '');
    const s = states.get(key);
    if (!s || !ring) return 0;
    const prevOffset = s.offset;
    let slice;
    try {
      slice = await readFileTail(s.path, prevOffset == null ? 0 : prevOffset, maxBytes);
    } catch {
      return 0; // ENOENT / read error: fail safe — hook tier keeps serving, offset unchanged
    }
    const firstRead = prevOffset == null;
    const rotated = !firstRead && Number.isFinite(prevOffset) && slice.from < prevOffset;
    let records;
    let consumedBytes;
    let entries;
    let lastStepIndex;
    try {
      ({ records, consumedBytes } = parseAgyTranscriptRecords(slice.text));
      ({ entries, lastStepIndex } = agyTailEntriesFromRecords(records, {
        sinceStepIndex: firstRead || rotated ? -1 : s.lastStepIndex,
      }));
    } catch {
      return 0;
    }
    s.offset = slice.from + consumedBytes;
    // Rotation/first read REPLACES the step cursor (a fresh conversation restarts at step 0 — a
    // max() would filter the new file's records forever); steady state only ratchets up.
    s.lastStepIndex = firstRead || rotated ? lastStepIndex : Math.max(s.lastStepIndex, lastStepIndex);
    let toApply = entries;
    if (firstRead) {
      try {
        const re = ring.ensure(key);
        // The floor protects CONTENT the hook replay reconstructed for the in-progress turn from
        // stale prior-turn tail rows. A meta-only (or empty) ring reconstructed nothing — let the
        // tail rebuild the whole current turn (prompt-cascade lands on the latest one).
        const hasContent = re.events.some((e) => e.kind !== 'meta');
        if (hasContent && re.t0_abs_ms) {
          const floor = re.t0_abs_ms - FIRST_READ_FLOOR_GRACE_MS;
          toApply = entries.filter((en) => !Number.isFinite(en.event.abs_ms) || en.event.abs_ms >= floor);
        }
      } catch {
        toApply = entries;
      }
    }
    try {
      return applyEntries(key, toApply);
    } catch {
      return 0;
    }
  }

  /**
   * Synchronous, non-blocking entry point the live-feed service calls per task after the hook
   * fill. Returns the scheduled tail promise (production ignores it; tests await it) or null when
   * skipped (disabled / not a local agy watch / no resolvable transcript / debounced / in flight).
   */
  function pump(taskId, wt, nowMs) {
    try {
      if (!enabled()) return null;
      if (!isLocalAgyWatch(wt)) return null;
      const transcriptPath = agyTranscriptFullPath(wt, homeDir);
      if (!transcriptPath || !isAntigravityTranscriptPath(transcriptPath)) return null;
      const s = ensureState(taskId, transcriptPath);
      const t = Number.isFinite(nowMs) ? nowMs : now();
      if (t - s.lastReadAt < ttlMs) return null;
      s.lastReadAt = t;
      return s.tail(); // wrapNonOverlapping → null while a prior pass is in flight
    } catch {
      return null; // never throw into the service's synchronous path
    }
  }

  return {
    pump,
    enabled,
    drop: (taskId) => states.delete(String(taskId || '')),
    // test surface:
    _states: states,
    _tailOnce: tailOnce,
    _applyEntries: applyEntries,
  };
}

module.exports = {
  AGY_TAIL_TTL_MS,
  MAX_TAIL_READ_BYTES,
  AGY_TAIL_FLAG_ENV,
  parseAgyTranscriptRecords,
  agyTranscriptToolDetail,
  parseAskQuestionContent,
  recordToEntries,
  agyTailEntriesFromRecords,
  deriveAgyTailEvents,
  agyTranscriptFullPath,
  createAgyTailReader,
  createAgyTranscriptTailAdapter,
  agyTailEnvFlagEnabled,
};
