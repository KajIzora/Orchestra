'use strict';

/*
 * live_turn_normalizer.js — raw hook body → LiveTurnEvent[] (Lane C §4, Phase 2a shared core).
 *
 * One module, per-provider mapping tables, sourced from what flows through the raw hook tap
 * (lib/hook_event_log.js — server.js pushes EVERY /api/<provider>-hooks/event body before the
 * store ingests, so this sees fields the lossy per-session stores drop: claude question
 * payloads, tool_input/tool_response, Stop.last_assistant_message, agy toolCall.args).
 *
 * LiveTurnEvent schema (LiveFeedDataRequirements.MD §Schema; `seq`/`t` are assigned by the ring
 * — this module emits `abs_ms` (epoch ms of the raw event) and the ring converts to turn-relative):
 *
 *   kind = 'prompt'        { text }
 *        | 'tool_start'    { name, detail }
 *        | 'tool_end'      { name, detail, ok }
 *        | 'note'          { text }
 *        | 'todo'          { done, total, active }
 *        | 'gate_open'     { gate_kind, command?, justification?, questions? }
 *        | 'gate_answered' { answers?, waited_ms }
 *        | 'stop'          { text }
 *        | 'meta'          { model?, cwd?, remote_host? }
 *
 * DATA HONESTY: emit only what the wired source actually carries — an absent field is an absent
 * field, never a placeholder. A lifecycle-only platform (cowork audit, browser chat) has NO raw
 * hook flow, so providerLogKey() returns '' and its task serves state + lifecycle only.
 *
 * Per-provider reality TODAY (verified against committed signal-lab recordings — see
 * docs/TestingFrameworkUpdate/FinalSteps/LiveFeed/core-implementation-notes.md):
 *  - codex   (richest): prompt, tool_start/tool_end, gate_open permission (command+justification)
 *             and question (full questions[] from request_user_input tool_input), gate_answered
 *             (answers map), stop text, meta. request_user_input is emitted BOTH as the gate pair
 *             AND as a register pair (it IS a codex tool call — the register shows "asking").
 *  - claude  : prompt, tool_start (PreToolUse) + tool_end (PostToolUse / PostToolUseFailure ok:false),
 *             note (MessageDisplay), todo (TodoWrite), gate_open permission/question
 *             (PermissionRequest tool_input carries the FULL AskUserQuestion payload incl.
 *             multiSelect + option descriptions), gate_answered (answers map from the gated
 *             tool's PostToolUse), stop text (Stop.last_assistant_message — raw body only, the
 *             store drops it). PreToolUse/MessageDisplay/PostToolUseFailure landed in the production
 *             hook profile in Phase 2b (signal_registry claude hookCatalog.captured) → tier 3.
 *             MessageDisplay's text field (`delta`, render at final=true) is PROVISIONAL — see the
 *             MessageDisplay case + docs/.../LiveFeed/claude-2b-notes.md (Phase-3 must confirm).
 *  - cursor  : prompt (beforeSubmitPrompt), tool_start/tool_end (preToolUse/postToolUse/
 *             postToolUseFailure — subscribed in the production profile; NOTE they fire
 *             unreliably in interactive sessions, see signal_registry cursor caveats), stop
 *             (status only, no text), meta (model). Question payloads are transcript-pull (2b).
 *  - gemini/agy: tool_start/tool_end for gated tools (PreToolUse carries toolCall{name,args};
 *             plain tools often surface only a toolCall:null PostToolUse ping — skipped),
 *             gate_open question with the FULL ask_question payload (args.questions incl.
 *             is_multi_select — in the hook body, verified in the 2026-07-11T01-49 recording),
 *             gate_answered (no answers — those are transcript-only, 2b), stop (no text), meta.
 *             Permission gate_open is NOT emitted from hooks alone (a gated PreToolUse also fires
 *             when auto-approved — only the transcript tail can tell, 2b); the task-level
 *             state/gate_kind still reports blocked via the production watch pipeline.
 *
 * Cross-platform truncation caps (Lane C §4): never re-emit tool_response/transcript blobs raw.
 */

const { isTaskNotification } = require('./done_detection');
const { isUserRequestInterruptedPreview } = require('./request_interrupted_preview');

const LIVE_TURN_EVENT_KINDS = Object.freeze([
  'prompt', 'tool_start', 'tool_end', 'note', 'todo', 'gate_open', 'gate_answered', 'stop', 'meta',
]);

// Per-field truncation caps. `detail` (one-line arg summary) and prompt text stay short;
// `stop.text` is the handoff the L1 card renders in full, so it gets a larger (but bounded) cap.
const CAPS = Object.freeze({
  promptText: 200,
  detail: 200,
  noteText: 400,
  stopText: 8000,
  command: 2048,
  justification: 2048,
  questionText: 300,
  questionHeader: 80,
  optionLabel: 120,
  optionDescription: 160,
  answerValue: 200,
  maxQuestions: 12,
  maxOptions: 12,
});

// MessageDisplay streaming accumulation bounds (claude): the emitted note is clamped to
// CAPS.noteText anyway, so raw fragments beyond MD_ACCUM_MAX_CHARS add nothing; the in-flight
// message cap bounds scratch when a stream is abandoned mid-message (never finalized).
const MD_ACCUM_MAX_MESSAGES = 8;
const MD_ACCUM_MAX_CHARS = 4000;

// TaskCreate/TaskUpdate accumulation bound (claude): the current CLI answers TodoWrite-style
// nudges with incremental per-task Task* calls (V1 2026-07-12 drift finding — see the pack's
// events.todo declaration), so the todo row needs cross-call state: a per-turn task list keyed
// by the platform's own task id. The cap bounds scratch on a pathological run; a turn's real
// checklist is single digits. Tasks past the cap are ignored (not evicted — eviction would make
// done/total lie about tasks we already rendered).
const CLAUDE_TASKS_MAX = 100;

// cursor fires afterAgentThought TWICE per thought (bodies differ only by model params — same
// text, ~same instant; Phase-3 cursor-cli findings1 §3). Fold the double-fire inside this window;
// a genuinely repeated thought later in the turn still renders.
const CURSOR_THOUGHT_DEDUPE_MS = 2000;

function clamp(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

// Final assistant messages are documents, not one-line labels. Preserve their Markdown-significant
// newlines and indentation while retaining the same bounded-string guarantee as clamp().
function clampBlock(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const block = text.replace(/\r\n?/g, '\n').trim();
  if (block.length <= max) return block;
  return `${block.slice(0, max - 1)}…`;
}

/** Canonical event name from a raw hook body (hook_event_name | event_name, either casing). */
function rawEventName(body) {
  const b = body && typeof body === 'object' ? body : {};
  const raw =
    (typeof b.hook_event_name === 'string' && b.hook_event_name.trim()) ||
    (typeof b.event_name === 'string' && b.event_name.trim()) ||
    (typeof b.hookEventName === 'string' && b.hookEventName.trim()) ||
    '';
  return raw;
}

/** One-line human summary of a tool_input object (command, path, url, else first pairs). */
function summarizeToolInput(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : null;
  if (!input) return '';
  if (typeof input.command === 'string' && input.command.trim()) return clamp(input.command, CAPS.detail);
  const pathLike = input.file_path || input.path || input.filePath;
  if (typeof pathLike === 'string' && pathLike.trim()) return clamp(pathLike, CAPS.detail);
  if (typeof input.url === 'string' && input.url.trim()) return clamp(input.url, CAPS.detail);
  if (typeof input.pattern === 'string' && input.pattern.trim()) return clamp(input.pattern, CAPS.detail);
  if (typeof input.description === 'string' && input.description.trim()) return clamp(input.description, CAPS.detail);
  const pairs = [];
  for (const [k, v] of Object.entries(input)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      pairs.push(`${k}=${String(v)}`);
    }
    if (pairs.length >= 3) break;
  }
  return clamp(pairs.join(' '), CAPS.detail);
}

/** Normalize a questions[] payload (claude/codex object options; agy string options). */
function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || !rawQuestions.length) return null;
  const out = [];
  for (const q of rawQuestions.slice(0, CAPS.maxQuestions)) {
    if (!q || typeof q !== 'object') continue;
    const question = clamp(q.question || q.prompt || '', CAPS.questionText);
    if (!question) continue;
    const norm = { question };
    const header = clamp(q.header || q.title || '', CAPS.questionHeader);
    if (header) norm.header = header;
    if (typeof q.id === 'string' && q.id.trim()) norm.id = q.id.trim();
    // Multi-select flag: claude `multiSelect` (explicit true/false), agy `is_multi_select`,
    // cowork `multiSelect` (present only when true). Codex has NO flag — callers may pass an
    // inferred value via q.__inferred_multi (see inferMultiFromQuestionText).
    if (typeof q.multiSelect === 'boolean') norm.multi = q.multiSelect;
    else if (typeof q.is_multi_select === 'boolean') norm.multi = q.is_multi_select;
    else if (typeof q.allow_multiple === 'boolean') norm.multi = q.allow_multiple;
    else if (q.__inferred_multi === true) norm.multi = true;
    const rawOptions = Array.isArray(q.options) ? q.options : null;
    if (rawOptions && rawOptions.length) {
      const options = [];
      for (const opt of rawOptions.slice(0, CAPS.maxOptions)) {
        if (typeof opt === 'string') {
          if (opt.trim()) options.push({ label: clamp(opt, CAPS.optionLabel) });
          continue;
        }
        if (!opt || typeof opt !== 'object') continue;
        const label = clamp(opt.label || opt.id || '', CAPS.optionLabel);
        if (!label) continue;
        const row = { label };
        const description = clamp(opt.description || '', CAPS.optionDescription);
        if (description) row.description = description;
        options.push(row);
      }
      if (options.length) norm.options = options;
    }
    out.push(norm);
  }
  return out.length ? out : null;
}

// Codex request_user_input carries no multiSelect flag — infer from the question text only when
// it plainly announces multi-select (Lane C §4b "infer from text"). False stays absent (unknown).
function inferMultiFromQuestionText(text) {
  return /select all|choose (?:all|any)|multiple (?:choices|options|selections)/i.test(String(text || ''));
}

/** Compact an answers payload (map or list) with per-value clamping. */
function normalizeAnswers(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const list = raw.map((v) => clamp(typeof v === 'string' ? v : JSON.stringify(v), CAPS.answerValue)).filter(Boolean);
    return list.length ? list : null;
  }
  if (typeof raw === 'string') {
    const v = clamp(raw, CAPS.answerValue);
    return v ? { answer: v } : null;
  }
  if (typeof raw !== 'object') return null;
  const out = {};
  let any = false;
  for (const [k, v] of Object.entries(raw).slice(0, CAPS.maxQuestions)) {
    const key = clamp(k, CAPS.questionText);
    if (!key) continue;
    let value;
    if (typeof v === 'string') value = clamp(v, CAPS.answerValue);
    else if (Array.isArray(v)) value = v.map((x) => clamp(typeof x === 'string' ? x : JSON.stringify(x), CAPS.answerValue));
    else if (v && typeof v === 'object' && Array.isArray(v.answers)) {
      // codex shape {answers: {<id>: {answers: [..]}}} — flatten one level.
      value = v.answers.map((x) => clamp(typeof x === 'string' ? x : JSON.stringify(x), CAPS.answerValue));
    } else if (v != null) value = clamp(JSON.stringify(v), CAPS.answerValue);
    if (value == null) continue;
    out[key] = value;
    any = true;
  }
  return any ? out : null;
}

function metaEvent(absMs, { model, cwd, remoteHost } = {}) {
  const ev = { abs_ms: absMs, kind: 'meta' };
  let any = false;
  if (typeof model === 'string' && model.trim()) { ev.model = model.trim(); any = true; }
  if (typeof cwd === 'string' && cwd.trim()) { ev.cwd = cwd.trim(); any = true; }
  if (typeof remoteHost === 'string' && remoteHost.trim()) { ev.remote_host = remoteHost.trim(); any = true; }
  return any ? ev : null;
}

// A prompt starts a new turn: the normalizer wipes its own scratch (pending gate, open steps,
// meta dedup key) so gates/steps never span prompts and the new turn re-emits its meta row.
// The object identity is preserved — the ring entry keeps holding the same scratch object.
function wipeScratch(scratch) {
  for (const key of Object.keys(scratch)) delete scratch[key];
}

// Fold prompt ECHOES: codex re-sends the same UserPromptSubmit body when a finished session is
// reopened (the store's samePromptPreview precedent) — an identical consecutive prompt text is
// not a new turn. Returns the clamped text when this is a REAL new prompt, '' otherwise.
function newPromptText(scratch, rawText) {
  const clamped = clamp(rawText, CAPS.promptText);
  if (!clamped) return '';
  if (scratch.lastPromptText === clamped) return '';
  wipeScratch(scratch);
  scratch.lastPromptText = clamped;
  return clamped;
}

// Emit meta only when it says something NEW for this turn (avoid a meta per hook — agy stamps
// modelName on every event). scratch.metaKey is wiped with the turn (see wipeScratch).
function metaIfChanged(scratch, absMs, fields) {
  const ev = metaEvent(absMs, fields);
  if (!ev) return null;
  const key = `${ev.model || ''}|${ev.cwd || ''}|${ev.remote_host || ''}`;
  if (scratch.metaKey === key) return null;
  scratch.metaKey = key;
  return ev;
}

/* ------------------------------------------------------------------ claude */

// TaskCreate/TaskUpdate → todo (claude). The current CLI's incremental task-list calls
// (V1 2026-07-12 drift: TodoWrite replaced by Task* on this build — TaskCreate carries
// tool_input {subject, description?, activeForm?} + tool_response.task.id; TaskUpdate carries
// tool_input {taskId, status?, activeForm?...} + tool_response.statusChange) are accumulated in
// scratch.claudeTasks (wiped with the turn, like every scratch key) and rendered to the same
// {done, total, active} shape TodoWrite produced. One todo event per RENDERED change — an update
// that alters nothing visible (e.g. description-only) emits nothing, mirroring a TodoWrite body
// with no todos array. Returns the todo event or null.
function claudeTaskListTodoEvent(scratch, absMs, toolName, input, resp) {
  if (!scratch.claudeTasks) scratch.claudeTasks = { order: [], byId: {}, lastKey: '' };
  const tasks = scratch.claudeTasks;
  const respTask = resp && resp.task && typeof resp.task === 'object' ? resp.task : null;
  if (toolName === 'TaskCreate') {
    // The platform-assigned id rides tool_response.task.id; a response-less body (older capture,
    // sanitizer edge) falls back to a synthetic ordinal so the create still renders.
    const id = respTask && respTask.id != null && String(respTask.id).trim()
      ? String(respTask.id).trim()
      : `(created-${tasks.order.length + 1})`;
    if (!tasks.byId[id]) {
      if (tasks.order.length >= CLAUDE_TASKS_MAX) return null;
      tasks.order.push(id);
      tasks.byId[id] = { status: 'pending', active: '' };
    }
    const active = clamp((input && (input.activeForm || input.subject)) || (respTask && respTask.subject) || '', CAPS.detail);
    if (active) tasks.byId[id].active = active;
  } else {
    const statusChange = resp && resp.statusChange && typeof resp.statusChange === 'object' ? resp.statusChange : null;
    const id = input && input.taskId != null && String(input.taskId).trim()
      ? String(input.taskId).trim()
      : resp && resp.taskId != null && String(resp.taskId).trim() ? String(resp.taskId).trim() : '';
    if (!id) return null;
    // An update for a task we never saw created (capture started mid-list) still discovers it —
    // rendering what we know beats dropping the row entirely.
    if (!tasks.byId[id]) {
      if (tasks.order.length >= CLAUDE_TASKS_MAX) return null;
      tasks.order.push(id);
      tasks.byId[id] = { status: 'pending', active: '' };
    }
    const status = (input && typeof input.status === 'string' && input.status.trim())
      || (statusChange && typeof statusChange.to === 'string' && statusChange.to.trim()) || '';
    if (status) tasks.byId[id].status = status.toLowerCase();
    const active = clamp((input && input.activeForm) || '', CAPS.detail);
    if (active) tasks.byId[id].active = active;
  }
  const total = tasks.order.length;
  const done = tasks.order.filter((id) => tasks.byId[id].status === 'completed').length;
  const activeId = tasks.order.find((id) => tasks.byId[id].status === 'in_progress');
  const active = activeId ? tasks.byId[activeId].active : '';
  const key = `${done}|${total}|${active}`;
  if (tasks.lastKey === key) return null;
  tasks.lastKey = key;
  const ev = { abs_ms: absMs, kind: 'todo', done, total };
  if (active) ev.active = active;
  return ev;
}

function normalizeClaudeEvent(body, absMs, scratch) {
  const name = rawEventName(body);
  const events = [];
  const toolName = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
  switch (name) {
    case 'UserPromptSubmit': {
      const text = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : body.prompt_preview || '';
      // <task-notification> resumes and "[Request interrupted…]" synthetic rows are not human prompts.
      if (!text || isTaskNotification(text) || isUserRequestInterruptedPreview(text)) break;
      const promptText = newPromptText(scratch, text);
      if (promptText) events.push({ abs_ms: absMs, kind: 'prompt', text: promptText });
      break;
    }
    case 'SessionStart': {
      const ev = metaIfChanged(scratch, absMs, { model: body.model, cwd: body.cwd || body.workspace_path, remoteHost: body.remote_host });
      if (ev) events.push(ev);
      break;
    }
    case 'PermissionRequest': {
      const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : null;
      if (toolName === 'AskUserQuestion') {
        const questions = normalizeQuestions(input ? input.questions : null);
        const gate = { abs_ms: absMs, kind: 'gate_open', gate_kind: 'question' };
        if (questions) gate.questions = questions;
        events.push(gate);
        scratch.pendingGate = { kind: 'question', tool_name: toolName, abs_ms: absMs };
      } else {
        const gate = { abs_ms: absMs, kind: 'gate_open', gate_kind: 'permission' };
        const command = input && typeof input.command === 'string' && input.command.trim()
          ? clamp(input.command, CAPS.command)
          : summarizeToolInput(input);
        if (toolName && command) gate.command = `${toolName}: ${command}`.slice(0, CAPS.command);
        else if (command) gate.command = command;
        else if (toolName) gate.command = toolName;
        events.push(gate);
        scratch.pendingGate = { kind: 'permission', tool_name: toolName, abs_ms: absMs };
      }
      break;
    }
    case 'Notification': {
      const type = String(body.notification_type || body.notificationType || '').trim().toLowerCase();
      if (type !== 'permission_prompt') break;
      if (scratch.pendingGate) break; // PermissionRequest already opened this gate
      const gate = { abs_ms: absMs, kind: 'gate_open', gate_kind: 'permission' };
      const msg = clamp(body.message || '', CAPS.command);
      if (msg) gate.command = msg;
      events.push(gate);
      scratch.pendingGate = { kind: 'permission', tool_name: '', abs_ms: absMs };
      break;
    }
    case 'PreToolUse': {
      // Not in the production claude profile today (2b adds it) — mapped so richer profiles work.
      if (!toolName) break;
      events.push({ abs_ms: absMs, kind: 'tool_start', name: toolName, detail: summarizeToolInput(body.tool_input) });
      break;
    }
    case 'PostToolUse': {
      const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : null;
      if (toolName === 'TodoWrite') {
        const todos = input && Array.isArray(input.todos) ? input.todos : null;
        if (todos) {
          const total = todos.length;
          const done = todos.filter((t) => t && String(t.status || '').toLowerCase() === 'completed').length;
          const activeTodo = todos.find((t) => t && String(t.status || '').toLowerCase() === 'in_progress');
          const ev = { abs_ms: absMs, kind: 'todo', done, total };
          const active = activeTodo ? clamp(activeTodo.activeForm || activeTodo.content || '', CAPS.detail) : '';
          if (active) ev.active = active;
          events.push(ev);
        }
        break; // the todo event IS the TodoWrite rendering — no tool_end double
      }
      if (toolName === 'TaskCreate' || toolName === 'TaskUpdate') {
        const resp = body.tool_response && typeof body.tool_response === 'object' ? body.tool_response : null;
        const ev = claudeTaskListTodoEvent(scratch, absMs, toolName, input, resp);
        if (ev) events.push(ev);
        break; // like TodoWrite: the todo event IS the task-list rendering — no tool_end double
      }
      const pending = scratch.pendingGate;
      if (pending && (!pending.tool_name || pending.tool_name === toolName)) {
        const answered = { abs_ms: absMs, kind: 'gate_answered', waited_ms: Math.max(0, absMs - pending.abs_ms) };
        if (pending.kind === 'question') {
          const resp = body.tool_response && typeof body.tool_response === 'object' ? body.tool_response : null;
          const answers = normalizeAnswers(resp ? resp.answers : null);
          if (answers) answered.answers = answers;
        }
        events.push(answered);
        scratch.pendingGate = null;
        if (toolName && toolName !== 'AskUserQuestion') {
          // The gated tool ran once approved — that IS the register's tool completion.
          events.push({ abs_ms: absMs, kind: 'tool_end', name: toolName, detail: summarizeToolInput(input), ok: true });
        }
        break;
      }
      if (toolName) {
        events.push({ abs_ms: absMs, kind: 'tool_end', name: toolName, detail: summarizeToolInput(input), ok: true });
      }
      break;
    }
    case 'PostToolUseFailure': {
      // 2b profile add. Body carries `tool_name` + `error` (docs/internal/LiveFeedDataInventory.md
      // §1) — some failures also echo the attempted `tool_input`. Prefer the arg summary for the
      // detail (so the red row shows WHAT failed), fall back to the error string.
      if (!toolName) break;
      const detail = summarizeToolInput(body.tool_input)
        || clamp(typeof body.error === 'string' ? body.error : (body.error && body.error.message) || '', CAPS.detail);
      events.push({ abs_ms: absMs, kind: 'tool_end', name: toolName, detail, ok: false });
      break;
    }
    case 'MessageDisplay': {
      // 2b profile add → mid-turn assistant text note. Phase 3 CONFIRMED the streaming shape
      // against real captures (claude-code findings1 F1 + messagedisplay-verdict.json): the text
      // rides `delta` as a TRUE incremental stream keyed by `message_id` + `index`, and
      // `final:true` marks only the LAST fragment, carrying only that fragment. So accumulate
      // fragments per message in scratch and emit ONE note = the full concatenation (ordered by
      // index) when the final fragment lands. Bodies with no `final` flag are the non-streaming
      // shape and still emit directly (message/text/content fallbacks kept).
      // Lifecycle/bounds: a new prompt wipes scratch (partial accumulations never span turns);
      // a never-finalized message is capped per-message (MD_ACCUM_MAX_CHARS) and the in-flight
      // set is capped (MD_ACCUM_MAX_MESSAGES, oldest evicted) so scratch can never grow unboundedly.
      if (typeof body.final !== 'boolean') {
        const text = clamp(body.delta || body.message || body.text || body.content || '', CAPS.noteText);
        if (text) events.push({ abs_ms: absMs, kind: 'note', text });
        break;
      }
      const messageKey =
        (typeof body.message_id === 'string' && body.message_id.trim()) ||
        (body.message_id != null ? String(body.message_id) : '(no-id)');
      const index = Number.isFinite(Number(body.index)) ? Number(body.index) : null;
      const fragment =
        typeof body.delta === 'string'
          ? body.delta
          : (typeof body.message === 'string' && body.message) ||
            (typeof body.text === 'string' && body.text) ||
            (typeof body.content === 'string' && body.content) ||
            '';
      if (!scratch.mdStreams) scratch.mdStreams = {};
      let stream = scratch.mdStreams[messageKey];
      if (!stream) {
        const keys = Object.keys(scratch.mdStreams);
        if (keys.length >= MD_ACCUM_MAX_MESSAGES) delete scratch.mdStreams[keys[0]];
        stream = { parts: [], chars: 0 };
        scratch.mdStreams[messageKey] = stream;
      }
      if (fragment && stream.chars < MD_ACCUM_MAX_CHARS) {
        stream.parts.push({ index: index == null ? stream.parts.length : index, text: fragment });
        stream.chars += fragment.length;
      }
      if (body.final === false) break; // mid-stream fragment: accumulated, nothing emitted yet
      delete scratch.mdStreams[messageKey];
      const full = stream.parts
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((p) => p.text)
        .join('');
      const text = clamp(full, CAPS.noteText);
      if (text) events.push({ abs_ms: absMs, kind: 'note', text });
      break;
    }
    case 'Stop': {
      events.push({ abs_ms: absMs, kind: 'stop', text: clampBlock(body.last_assistant_message || '', CAPS.stopText) });
      break;
    }
    default:
      break;
  }
  return events;
}

/* ------------------------------------------------------------------- codex */

const CODEX_QUESTION_TOOL = 'request_user_input';

function normalizeCodexEvent(body, absMs, scratch) {
  const name = rawEventName(body);
  const events = [];
  const toolName = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
  switch (name) {
    case 'SessionStart': {
      const ev = metaIfChanged(scratch, absMs, { model: body.model, cwd: body.cwd || body.workspace_path, remoteHost: body.remote_host });
      if (ev) events.push(ev);
      break;
    }
    case 'UserPromptSubmit': {
      const text = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : body.prompt_preview || '';
      if (!text) break;
      const promptText = newPromptText(scratch, text);
      if (!promptText) break; // session-reopen echo of the same prompt — not a new turn
      events.push({ abs_ms: absMs, kind: 'prompt', text: promptText });
      const ev = metaIfChanged(scratch, absMs, { model: body.model, cwd: body.cwd, remoteHost: body.remote_host });
      if (ev) events.push(ev);
      break;
    }
    case 'PreToolUse': {
      const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : null;
      if (toolName === CODEX_QUESTION_TOOL) {
        // The question gate IS a codex tool call: emit the register pair around the gate pair so
        // the activity register shows "asking" while blocked (tool_start here, tool_end at answer).
        const rawQs = input && Array.isArray(input.questions) ? input.questions : null;
        const inferred = rawQs
          ? rawQs.map((q) => (q && typeof q === 'object'
            ? { ...q, __inferred_multi: inferMultiFromQuestionText(q.question) || undefined }
            : q))
          : null;
        const questions = normalizeQuestions(inferred);
        events.push({
          abs_ms: absMs, kind: 'tool_start', name: CODEX_QUESTION_TOOL,
          detail: questions ? `${questions.length} question${questions.length === 1 ? '' : 's'}` : '',
        });
        const gate = { abs_ms: absMs, kind: 'gate_open', gate_kind: 'question' };
        if (questions) gate.questions = questions;
        events.push(gate);
        scratch.pendingGate = {
          kind: 'question', tool_name: toolName, abs_ms: absMs,
          tool_use_id: typeof body.tool_use_id === 'string' ? body.tool_use_id : '',
        };
        break;
      }
      if (toolName) {
        events.push({ abs_ms: absMs, kind: 'tool_start', name: toolName, detail: summarizeToolInput(input) });
      }
      break;
    }
    case 'PermissionRequest': {
      const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : null;
      const gate = { abs_ms: absMs, kind: 'gate_open', gate_kind: 'permission' };
      const command = input && typeof input.command === 'string' ? clamp(input.command, CAPS.command) : '';
      const justification = input && typeof input.description === 'string' ? clamp(input.description, CAPS.justification) : '';
      if (command) gate.command = command;
      else if (toolName) gate.command = toolName;
      if (justification) gate.justification = justification;
      events.push(gate);
      scratch.pendingGate = { kind: 'permission', tool_name: toolName, abs_ms: absMs };
      break;
    }
    case 'PostToolUse': {
      const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : null;
      const pending = scratch.pendingGate;
      if (toolName === CODEX_QUESTION_TOOL) {
        const answered = {
          abs_ms: absMs, kind: 'gate_answered',
          waited_ms: pending && pending.tool_name === toolName ? Math.max(0, absMs - pending.abs_ms) : 0,
        };
        let resp = body.tool_response;
        if (typeof resp === 'string') { try { resp = JSON.parse(resp); } catch { resp = null; } }
        const answers = normalizeAnswers(resp && typeof resp === 'object' ? resp.answers : null);
        if (answers) answered.answers = answers;
        events.push(answered);
        events.push({ abs_ms: absMs, kind: 'tool_end', name: CODEX_QUESTION_TOOL, detail: '', ok: true });
        if (pending && pending.tool_name === toolName) scratch.pendingGate = null;
        break;
      }
      if (pending && pending.kind === 'permission' && pending.tool_name && pending.tool_name === toolName) {
        // The gated tool completed ⇒ the permission was answered (codex emits no resolve hook).
        events.push({ abs_ms: absMs, kind: 'gate_answered', waited_ms: Math.max(0, absMs - pending.abs_ms) });
        scratch.pendingGate = null;
      }
      if (toolName) {
        events.push({ abs_ms: absMs, kind: 'tool_end', name: toolName, detail: summarizeToolInput(input), ok: true });
      }
      break;
    }
    case 'Stop': {
      events.push({ abs_ms: absMs, kind: 'stop', text: clampBlock(body.last_assistant_message || '', CAPS.stopText) });
      break;
    }
    default:
      break; // SubagentStart/SubagentStop carry no per-turn content for the feed
  }
  return events;
}

/* ------------------------------------------------------------------ cursor */

function normalizeCursorEvent(body, absMs, scratch) {
  const name = rawEventName(body);
  const events = [];
  const toolName = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
  // meta rides EVERY cursor hook body, not only beforeSubmitPrompt: all cursor bodies carry
  // model/cursor_version/workspace_roots (docs/internal/LiveFeedDataInventory.md §4), and Cursor
  // 3.11 stopped firing beforeSubmitPrompt for IDE (Agents window) conversations entirely
  // (recapture round 2026-07-12, engine-log-proven: the cursor.hooks window log shows all 20
  // steps loaded and 44 hooks executed with ZERO beforeSubmitPrompt steps, while cursor-agent CLI
  // 2026.07.09 still fires it) — deriving meta only from the hook that no longer fires there
  // served model/cwd-less rows for every IDE watch.
  //
  // cursor hook bodies carry the workspace as workspace_roots[] and never a `cwd` field
  // (docs/internal/LiveFeedDataInventory.md §4; live-verified 2026-07-12) — body.cwd alone
  // left meta.cwd permanently empty on a channel whose declared folder source is
  // workspace_roots[0] (platforms/cursor-cli manifest header.folder). Real field, real slot,
  // missing wire (V1 fix; locked in tests/live_turn_normalizer.test.js).
  //
  // Model-flap guard: agent bodies alternate between the literal 'default' and the real composer
  // model id (raw-verified in one run: preToolUse model 'default', afterAgentThought model
  // 'cursor-grok-4.5-high') — once a concrete model is seen, 'default' no longer overwrites it,
  // else metaIfChanged would emit a meta flip on every alternation.
  //
  // The meta derivation runs AFTER the switch (deriveMeta below) so beforeSubmitPrompt keeps its
  // historical same-call event order [prompt, meta] — a prompt wipes the scratch (new turn), and
  // meta emitted before it would land pre-wipe and be re-keyed anyway.
  const deriveMeta = () => {
    const workspaceRoot = Array.isArray(body.workspace_roots)
      ? body.workspace_roots.find((r) => typeof r === 'string' && r.trim())
      : '';
    let model = typeof body.model === 'string' ? body.model.trim() : '';
    if (model && model !== 'default') scratch.cursorConcreteModel = model;
    else if (model === 'default' && scratch.cursorConcreteModel) model = scratch.cursorConcreteModel;
    const ev = metaIfChanged(scratch, absMs, {
      model,
      cwd: body.cwd || workspaceRoot,
      remoteHost: body.remote_host || body.host,
    });
    if (ev) events.push(ev);
  };
  switch (name) {
    case 'beforeSubmitPrompt': {
      const text = typeof body.prompt === 'string' ? body.prompt : '';
      if (text && !isUserRequestInterruptedPreview(text)) {
        const promptText = newPromptText(scratch, text);
        if (promptText) events.push({ abs_ms: absMs, kind: 'prompt', text: promptText });
      }
      break;
    }
    case 'preToolUse': {
      if (!toolName) break;
      events.push({ abs_ms: absMs, kind: 'tool_start', name: toolName, detail: summarizeToolInput(body.tool_input) });
      break;
    }
    case 'postToolUse': {
      if (!toolName) break;
      events.push({ abs_ms: absMs, kind: 'tool_end', name: toolName, detail: summarizeToolInput(body.tool_input), ok: true });
      break;
    }
    case 'postToolUseFailure': {
      if (!toolName) break;
      events.push({ abs_ms: absMs, kind: 'tool_end', name: toolName, detail: summarizeToolInput(body.tool_input), ok: false });
      break;
    }
    case 'afterAgentResponse': {
      // 2b (cursor-cli notes): the agent's mid-turn chat message → note. Field name is not carried
      // by any committed recording (production shape) — read the plausible candidates defensively;
      // Phase-3 confirms the exact field against a real capture.
      const text = clamp(body.text || body.response || body.message || '', CAPS.noteText);
      if (text) events.push({ abs_ms: absMs, kind: 'note', text });
      break;
    }
    case 'afterAgentThought': {
      // 2b (cursor-cli): the model's mid-turn reasoning → note (the feed has no distinct "thought"
      // kind; pipeline-ui-writeup groups thoughts under `note`). afterAgentThought is a reliable
      // conversation-lifecycle hook (fires even when the per-tool hooks don't). Phase 3 pinned the
      // body field: `text` carried 100% across all runs (findings1 §3); fallbacks kept defensively.
      const text = clamp(body.text || body.thought || body.message || body.response || '', CAPS.noteText);
      if (!text) break;
      // Double-fire dedupe (Phase-3 cursor findings1 §3): cursor emits each thought TWICE (one
      // body with model_id+model_params, one without — identical text at ~identical t), which
      // rendered duplicate note pairs. Same text within the window ⇒ the same thought, one note.
      const last = scratch.lastThoughtNote;
      if (last && last.text === text && Math.abs(absMs - last.abs_ms) <= CURSOR_THOUGHT_DEDUPE_MS) break;
      scratch.lastThoughtNote = { text, abs_ms: absMs };
      events.push({ abs_ms: absMs, kind: 'note', text });
      break;
    }
    case 'afterFileEdit': {
      // 2b (cursor-cli): a completed file edit → an ENDS-ONLY tool_end register event (there is no
      // paired preToolUse for afterFileEdit; the grouping reducer handles a start_t-less end, same
      // as claude's ends-only tool_end). ok:true — a failed edit arrives via postToolUseFailure.
      const filePath = typeof body.file_path === 'string' ? body.file_path : (typeof body.path === 'string' ? body.path : '');
      const name = toolName || 'Edit';
      events.push({ abs_ms: absMs, kind: 'tool_end', name, detail: clamp(filePath, CAPS.detail), ok: true });
      break;
    }
    case 'stop': {
      // Cursor's stop is per-GENERATION (continuations may follow) and carries no assistant text.
      events.push({ abs_ms: absMs, kind: 'stop', text: '' });
      break;
    }
    default:
      break; // sessionStart/sessionEnd/subagentStart/subagentStop: no per-turn feed content
  }
  deriveMeta();
  return events;
}

/* -------------------------------------------------------------- gemini/agy */

// agy hook bodies carry fields both flat and under body.payload — read either.
function agyField(body, key) {
  if (body && body[key] !== undefined) return body[key];
  const payload = body && body.payload && typeof body.payload === 'object' ? body.payload : null;
  return payload ? payload[key] : undefined;
}

function stripUserRequestXml(text) {
  let one = String(text || '');
  const matches = [...one.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  if (matches.length) one = matches.map((m) => m[1] || '').join(' ');
  one = one.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ');
  one = one.replace(/<[^>]+>/g, ' ');
  return one.replace(/\s+/g, ' ').trim();
}

function agyToolDetail(toolCall) {
  const args = toolCall && typeof toolCall.args === 'object' && toolCall.args ? toolCall.args : {};
  const summary = toolCall && (toolCall.toolSummary || toolCall.toolAction);
  if (typeof summary === 'string' && summary.trim()) return clamp(summary, CAPS.detail);
  return summarizeToolInput(args);
}

function normalizeGeminiEvent(body, absMs, scratch) {
  const name = rawEventName(body);
  const events = [];
  const model = agyField(body, 'modelName') || body.model;
  const workspacePaths = agyField(body, 'workspacePaths');
  const cwd = Array.isArray(workspacePaths) && typeof workspacePaths[0] === 'string' ? workspacePaths[0] : body.cwd;
  const toolCall = agyField(body, 'toolCall');
  const stepIdxRaw = toolCall && Number.isFinite(Number(toolCall.stepIdx)) ? Number(toolCall.stepIdx) : Number(agyField(body, 'stepIdx'));
  const stepIdx = Number.isFinite(stepIdxRaw) ? stepIdxRaw : null;
  switch (name) {
    case 'UserPromptSubmit':
    case 'PreInvocation': {
      // agy-cli hooks carry NO prompt today; gemini-cli legacy bodies may (XML-wrapped).
      const rawPrompt = body.prompt || body.prompt_preview || agyField(body, 'prompt') || '';
      if (typeof rawPrompt === 'string' && rawPrompt.trim()) {
        const text = newPromptText(scratch, stripUserRequestXml(rawPrompt));
        if (text) events.push({ abs_ms: absMs, kind: 'prompt', text });
      }
      const ev = metaIfChanged(scratch, absMs, { model, cwd, remoteHost: body.remote_host });
      if (ev) events.push(ev);
      break;
    }
    case 'PreToolUse': {
      if (!toolCall || typeof toolCall !== 'object') break;
      const toolName = String(toolCall.name || '').trim();
      if (!toolName) break;
      if (toolName === 'ask_question') {
        const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};
        const questions = normalizeQuestions(Array.isArray(args.questions) ? args.questions : null);
        events.push({
          abs_ms: absMs, kind: 'tool_start', name: toolName,
          detail: questions ? `${questions.length} question${questions.length === 1 ? '' : 's'}` : '',
        });
        const gate = { abs_ms: absMs, kind: 'gate_open', gate_kind: 'question' };
        if (questions) gate.questions = questions;
        events.push(gate);
        scratch.pendingGate = { kind: 'question', tool_name: toolName, abs_ms: absMs, stepIdx };
        break;
      }
      // A permission-GATED PreToolUse also fires when the tool is auto-approved — hooks alone
      // cannot tell (transcript tail can, 2b), so no gate_open here; the register still shows it.
      events.push({ abs_ms: absMs, kind: 'tool_start', name: toolName, detail: agyToolDetail(toolCall) });
      if (stepIdx != null) scratch.openSteps = { ...(scratch.openSteps || {}), [stepIdx]: { name: toolName, detail: agyToolDetail(toolCall) } };
      break;
    }
    case 'PostToolUse': {
      const err = agyField(body, 'error');
      const failed = typeof err === 'string' && err.trim().length > 0;
      const pending = scratch.pendingGate;
      const echoName = toolCall && typeof toolCall === 'object' ? String(toolCall.name || '').trim() : '';
      if (pending && pending.kind === 'question' && (echoName === 'ask_question' || (stepIdx != null && stepIdx === pending.stepIdx))) {
        // Answers are transcript-only for agy (A1:/A2:/… lines) — waited_ms is what hooks know.
        events.push({ abs_ms: absMs, kind: 'gate_answered', waited_ms: Math.max(0, absMs - pending.abs_ms) });
        events.push({ abs_ms: absMs, kind: 'tool_end', name: 'ask_question', detail: '', ok: !failed });
        scratch.pendingGate = null;
        break;
      }
      const open = stepIdx != null && scratch.openSteps ? scratch.openSteps[stepIdx] : null;
      if (open) {
        events.push({ abs_ms: absMs, kind: 'tool_end', name: open.name, detail: open.detail, ok: !failed });
        const next = { ...scratch.openSteps };
        delete next[stepIdx];
        scratch.openSteps = next;
        break;
      }
      if (echoName) {
        events.push({ abs_ms: absMs, kind: 'tool_end', name: echoName, detail: agyToolDetail(toolCall), ok: !failed });
      }
      // toolCall:null with no tracked open step = a lifecycle ping — nothing to render.
      break;
    }
    case 'Stop': {
      // agy emits per-invocation Stops (a turn can carry several); no assistant text in hooks.
      events.push({ abs_ms: absMs, kind: 'stop', text: '' });
      break;
    }
    default:
      break; // PostInvocation and gemini legacy lifecycle events carry no feed content
  }
  return events;
}

/* ---------------------------------------------------------------- dispatch */

const PROVIDER_NORMALIZERS = Object.freeze({
  claude: normalizeClaudeEvent,
  codex: normalizeCodexEvent,
  cursor: normalizeCursorEvent,
  gemini: normalizeGeminiEvent,
});

/**
 * Normalize ONE raw hook-tap event into zero-or-more LiveTurnEvents (without seq/t — the ring
 * assigns those; events carry abs_ms).
 *
 * @param {string} provider  hook_event_log provider key: claude | codex | cursor | gemini
 * @param {{t_ms?: number, t_iso?: string, body?: object}} rawEvent  a hookEventLog.since() row
 * @param {{state?: object}} ctx  per-task-turn scratch state owned by the ring entry
 *   (pending gate, open agy steps, last meta key). Cleared by the ring on turn reset.
 * @returns {object[]} LiveTurnEvents (kind ∈ LIVE_TURN_EVENT_KINDS, each with abs_ms)
 */
function normalizeHookEvent(provider, rawEvent, ctx = {}) {
  const fn = PROVIDER_NORMALIZERS[provider];
  if (!fn) return [];
  const raw = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
  const body = raw.body && typeof raw.body === 'object' ? raw.body : {};
  const absMs = Number.isFinite(raw.t_ms) ? raw.t_ms : Date.parse(raw.t_iso || '') || Date.now();
  const scratch = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
  try {
    return fn(body, absMs, scratch) || [];
  } catch {
    return []; // a malformed body must never break the feed
  }
}

/* --------------------------------------------------- watch identity + tier */

/**
 * Which hook_event_log provider slice a watch reads. '' = no raw hook flow (lifecycle-only
 * platforms: cowork audit, browser chat, process/notification watches).
 */
function providerLogKey(wt) {
  if (!wt || typeof wt !== 'object') return '';
  if (wt.kind === 'cursor') return 'cursor';
  if (wt.kind !== 'ide_agent') return '';
  const p = wt.provider;
  if (p === 'claude') return 'claude';
  if (p === 'codex') return 'codex';
  if (p === 'gemini' || p === 'gemini_cli') return 'gemini';
  // claude_cowork (audit-tail adapter), grok (session-tail adapter — the fake-HOME shim keeps the
  // vendor-bug claude/cursor taps quiet, so no grok bytes ride the raw hook log), and anything
  // unknown: no raw hook slice.
  return '';
}

function lc(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Host discipline (mirrors the hook stores' snapshotHostMatchesTracking): a LOCAL watch only
// matches bodies with no remote_host; an SSH watch requires equal hosts when both are present.
function hostMatches(body, wt) {
  const bodyHost = lc(body.remote_host || body.host || '');
  if (wt && wt.source === 'ssh') {
    const watchHost = lc(wt.host || '');
    return !(watchHost && bodyHost && watchHost !== bodyHost);
  }
  return !bodyHost;
}

/**
 * Does this raw hook body belong to the task's watch identity? (session/transcript/conversation
 * match + host discipline). Used to filter a provider's hook_event_log slice down to one task.
 */
function rawEventMatchesWatch(provider, body, wt) {
  if (!body || typeof body !== 'object' || !wt || typeof wt !== 'object') return false;
  if (!hostMatches(body, wt)) return false;
  if (provider === 'cursor') {
    const wanted = lc(wt.conversation_id || wt.session_id || '');
    const conv = lc(body.conversation_id || body.conversationId || '');
    const session = lc(body.session_id || body.sessionId || '');
    if (wanted && (conv === wanted || session === wanted)) return true;
    const wantedTranscript = String(wt.transcript_path || '').trim();
    const transcript = String(body.transcript_path || body.transcriptPath || '').trim();
    return !!wantedTranscript && wantedTranscript === transcript;
  }
  if (provider === 'gemini') {
    const wanted = lc(wt.session_id || '');
    const conv = lc(agyField(body, 'conversationId') || body.session_id || body.sessionId || '');
    if (wanted && conv === wanted) return true;
    const wantedTranscript = String(wt.transcript_path || '').trim();
    const transcript = String(agyField(body, 'transcriptPath') || body.transcript_path || '').trim();
    return !!wantedTranscript && wantedTranscript === transcript;
  }
  // claude / codex
  const wantedSession = lc(wt.session_id || '');
  const session = lc(body.session_id || body.sessionId || '');
  if (wantedSession && session === wantedSession) return true;
  const wantedTranscript = String(wt.transcript_path || '').trim();
  const transcript = String(body.transcript_path || body.transcriptPath || '').trim();
  return !!wantedTranscript && wantedTranscript === transcript;
}

/**
 * The tier this watch's live feed serves TODAY (probe expectation ceiling, §Tiers):
 * the highest rung whose REQUIREMENTS the wired hook sources fully meet. tier>=1 means "expect a
 * register" (tool_start + tool_end pairs) — that is what tier-aware consumers key on.
 *
 *  - codex  → 3: register pairs + structured question payloads + stop text, all hook-carried.
 *  - gemini → 3: register pairs for content-bearing toolCalls + FULL ask_question payload in the
 *           PreToolUse hook body (verified in the committed agy-cli complex-question recording).
 *  - cursor → 2: per-tool hooks (register, T1; fire-reliability caveat documented) PLUS the 2b
 *           afterAgentResponse/-Thought notes (T2, reliable lifecycle hooks). Structured question
 *           payloads flow best-effort via the 2b store.db/transcript pull adapter (above the rung,
 *           delayed — see cursor_live_question_adapter.js), so they ship as events but do not
 *           promote the strict rung to 3 (unlike codex/gemini whose question payloads ride hooks).
 *  - claude → 3 (Phase 2b): the PreToolUse/MessageDisplay/PostToolUseFailure profile adds landed
 *           (signal_registry claude hookCatalog.captured), so the register (tool_start+tool_end) and
 *           notes are now hook-carried — completing every rung: T1 register, T2 note+todo (TodoWrite),
 *           T3 the FULL AskUserQuestion payload (explicit multiSelect + option descriptions) that
 *           already flowed. Matches codex/gemini: the provider's structured-question capability is the
 *           ceiling, present whenever a question occurs (the register-grade gate only cares tier>=1).
 *  - cowork → 3 WHEN an audit is attached (audit_path linked): the 2b audit-tail adapter
 *           (lib/cowork_live_adapter.js) serves register pairs + FULL AskUserQuestion payloads +
 *           stop text, all T3-class. UNLINKED (no audit_path) → 0: honest degradation, the audit is
 *           cowork's only channel, so no attach means lifecycle-only. Attachment is the recorded
 *           LINKAGE fact (audit_path), not optimism — a failed read still fails safe to the ring.
 *  - grok   → 2 WHEN a session dir is attached (session_dir linked — the link path always stamps
 *           it): the R2c session-tail adapter (lib/grok_live_adapter.js) serves register pairs
 *           (names only — events.jsonl carries no args), kind-level gate rows and stop text from
 *           the LIVE events.jsonl, PLUS (L5 T2 upgrade) prompt + note rows from a second live
 *           tail on updates.jsonl — its incremental message-boundary flush was re-verified live
 *           2026-07-12 (headless/ACP/TUI on 0.2.93), superseding the R2a "turn-end flush" claim
 *           that had capped grok at rung 1. The T2-via-native-hooks route was probed the same
 *           day and is DEAD in 0.2.93 (no hook event carries assistant text). T3 stays blocked
 *           (question payloads are RPC-only). session_dir-less → 0 (belt-and-suspenders;
 *           unreachable via the link path).
 *  - browser → 0 by default (lifecycle only — Orchestra does not read browser conversations). BUT
 *           → 2 WHEN the user turns on the explicit body-streaming opt-in (FollowUps §3.3): the
 *           recorded LINKAGE fact wt.stream_optin (set by /api/browser-chats/stream-body, the browser
 *           analog of cowork's audit_path) means the chat-watch extension is piping the assistant's
 *           reply text in, so lib/browser_stream_adapter.js serves a prompt + one evolving note +
 *           final stop = the declared tier-2 cell. T2 is the honest ceiling (a browser page yields no
 *           tool register and no structured gates). Opt-in absent → 0, exactly as today.
 *  - process (terminal) → 2 WHEN an output source is attached (terminal_source stamped — §3.1
 *           Terminal output capture): the terminal tail adapter (lib/live_terminal_adapter.js)
 *           serves register pairs from command lifecycle (command = tool_start/tool_end) + notes
 *           from the output tail, pushed by the Cursor shell-integration extension / Terminal.app
 *           / iTerm2 poller / file-redirect fallback. Attachment is stamped dynamically on the
 *           first real event (never optimistically), so an attached-but-silent source never shows
 *           an empty register. No source → 0: honest degradation, exactly as today (PID liveness
 *           only). Terminals never emit gate_open, so T2 is the ceiling.
 *  - anything else → 0 (lifecycle only).
 */
function liveTierForWatch(wt) {
  const key = providerLogKey(wt);
  if (key === 'codex' || key === 'gemini' || key === 'claude') return 3;
  if (key === 'cursor') return 2;
  if (wt && wt.kind === 'ide_agent' && wt.provider === 'claude_cowork') {
    return typeof wt.audit_path === 'string' && wt.audit_path.trim() ? 3 : 0;
  }
  if (wt && wt.kind === 'ide_agent' && wt.provider === 'grok') {
    return typeof wt.session_dir === 'string' && wt.session_dir.trim() ? 2 : 0;
  }
  if (wt && wt.kind === 'browser_chat') {
    return wt.stream_optin === true ? 2 : 0;
  }
  if (wt && wt.kind === 'process') {
    return typeof wt.terminal_source === 'string' && wt.terminal_source.trim() ? 2 : 0;
  }
  return 0;
}

module.exports = {
  LIVE_TURN_EVENT_KINDS,
  CAPS,
  clamp,
  clampBlock,
  rawEventName,
  summarizeToolInput,
  normalizeQuestions,
  normalizeAnswers,
  inferMultiFromQuestionText,
  stripUserRequestXml,
  normalizeHookEvent,
  providerLogKey,
  rawEventMatchesWatch,
  liveTierForWatch,
};
