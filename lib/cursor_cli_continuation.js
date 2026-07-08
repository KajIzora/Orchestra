'use strict';

/*
 * cursor_cli_continuation.js — decide whether a cursor-cli completed `stop` hook is the FINAL stop
 * of the turn, or a non-final generation stop with more same-turn work still coming.
 *
 * cursor-agent fires `stop` once per GENERATION, but one user turn can span several generations:
 * a Task sub-agent finishing, or a background shell "task" completing, queues a system notification
 * that cursor injects as a synthetic user record — starting a NEW generation (with its own stop) in
 * the SAME conversation. Clearing an Orchestra watch on the first stop is the cursor-cli
 * early-clear class (sub-agent-parent-early-done / background-checkin / background-sub-agent-robust).
 *
 * The transcript is no help at stop time: cursor appends `turn_ended` after EVERY generation and
 * RETRACTS it (file rewrite) when a continuation injects, so the tail looks final either way.
 * The reliable discriminators (verified against every recorded cursor-cli lab run):
 *
 *  1. OPEN SUB-AGENT — a spawned Task sub-agent writes its own transcript at
 *     ~/.cursor/projects/<slug>/agent-transcripts/<subagent_id>/<subagent_id>.jsonl (a SIBLING of
 *     the parent's dir, NOT the multitask `subagents/` underdir). While that transcript does not
 *     end with `turn_ended`, the sub-agent is still running and the parent WILL wake again —
 *     hold. This covers the long silent gap (a sub-agent can work for minutes with zero hooks,
 *     zero store.db writes, zero parent-transcript writes).
 *
 *  2. QUEUED SYSTEM NOTIFICATION — when a background task/sub-agent result is waiting, cursor
 *     writes a user-role blob starting with `<system_notification>` ("The following task has
 *     finished…") into the conversation's chat store.db 0.8–1.9s AFTER the non-final stop, then
 *     injects it. A FINAL stop is never followed by one. So after a stop we wait a short settle
 *     (~2.5s) watching for a NEW notification blob; one arriving means the turn continues.
 *
 * A turn that never used continuation machinery (no sub-agent transcripts, no terminal task files,
 * no notification blobs) skips the settle entirely — plain runs keep their instant clear.
 *
 * Cursor IDE (Agents window) shares the mechanism with one difference: its Task sub-agents write
 * transcripts into the parent's `subagents/` UNDERDIR (agent-transcripts/<conv>/subagents/*.jsonl)
 * instead of sibling dirs, and its `subagentStop` hook is unreliable (observed missing while the
 * sub-agent ran 90s past the parent stop) — so the same open/closed transcript-tail check drives
 * the IDE hold too. The watcher scans BOTH surfaces.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  extractJsonObjectsFromBuffer,
  findChatDbDir,
  remoteChatDbNotificationScan,
  SQLITE_BIN,
} = require('./cursor_chat_db');
const { cursorTranscriptTurnEnded } = require('./cursor_tracker');

// Post-stop settle while watching for a queued system-notification blob. Observed arrival lag
// across all recorded non-final stops: 0.8–1.9s; 2500ms covers it with margin while keeping a
// machinery-armed final stop's clear within warn range.
const DEFAULT_NOTIF_SETTLE_MS = 2500;
// A queued notification is consumed (injection → new generation → next stop) well within this;
// past it a stray/raced notification no longer holds the clear.
const DEFAULT_NOTIF_CONSUME_TIMEOUT_MS = 20_000;
// After a sub-agent transcript closes, its completion notification lands within a couple seconds;
// hold through that handoff so the clear doesn't slip in between.
const DEFAULT_SUBAGENT_CLOSE_GRACE_MS = 5_000;
// Notifications written just before the stop hook's timestamp still count as "for this stop's
// continuation" (poll/clock skew).
const NOTIF_STOP_SLACK_MS = 2_000;
// Post-stop tool activity (the injected continuation generation working) holds the clear while
// fresh. Observed intra-continuation gaps: ≤6.5s (a long shell); 8s covers them. Applies ONLY to
// activity strictly after the stop, so a final stop (no continuation) is never delayed by it.
const DEFAULT_ACTIVITY_QUIET_MS = 8_000;
// A Task tool_use whose sub-agent transcript has not materialized yet: cursor creates the
// agent-transcripts/<subagent_id>/ dir LAZILY, observed up to ~5s AFTER the parent's early stop.
// Hold the clear through that handoff; if no sub-agent transcript appears within this window the
// Task is treated as not having spawned one (its postToolUse never fires, so this is the only
// release).
const DEFAULT_TASK_HANDOFF_MAX_MS = 30_000;
// Ignore hook events landing in the same instant as the stop (afterAgentResponse fires at stop
// time) when deciding "activity after the stop".
const ACTIVITY_STOP_SLACK_MS = 500;
// ssh watches: remote surfaces are read on an async cache (~2.5s refresh + ssh round-trip), so a
// queued notification is observed up to several seconds after it lands remotely. The armed
// post-stop settle must cover that observation lag (local: 2.5s). Round-1 ssh measured a 14–18s
// child-completion notification lag; 8s under-provisioned the window between the last stop and the
// notification arrival (the notification_queued hold only takes over once it is OBSERVED), so the
// LIVE watcher could clear before the queued notification landed. Widen modestly to 12s — enough to
// bridge the common lag to where notification_queued/close-grace hold, without the 20s blanket cost
// that would delay every plain ssh sub-agent done. Plain remote runs (no continuation machinery) are
// unaffected — they still clear instantly.
const SSH_NOTIF_SETTLE_MS = 12000;
// Cadence of the background remote-surface refresh for ssh watches (per conversation).
const SSH_REMOTE_REFRESH_MS = 2500;
// Bytes tailed from each remote sub-agent transcript for the open/closed (turn_ended) check —
// same window the local transcriptTailIsTurnEnded uses.
const REMOTE_TAIL_BYTES = 8192;
// An OPEN sub-agent transcript that has not GROWN for this long stops holding the subagent_open
// gate. The wedge (background-sub-agent-robust-supervised, 2026-07-06): a child dies mid-tool —
// tail ends at a dangling assistant tool_use, no turn_ended is ever written — and the unbounded
// open-transcript hold kept the parent "working" ~92s until the process-exit sessionEnd rescued
// it (production's only other bound is the 10-min wall cap). Growth is the one signal that
// separates "working silently" (a live child keeps appending records) from "died mid-tool"
// (flat file). 3min ≫ every observed legitimate silent gap (intra-continuation ≤6.5s, task
// handoff ≤30s, close-grace 5s) and ≪ the 10-min cap. A stale-released child that later revives
// (an extreme silent tool returning) re-arms the watch through its continuation notification —
// the same tolerated done→working flicker as claude's past-cap check-in.
//
// GROWTH-OBSERVED requirement (SSH round 3, cursor-ide finding 2): the guard's premise — "no
// growth for 3min = died mid-tool" — only holds for children whose transcripts flush
// CONTINUOUSLY (cursor-cli). cursor-ide Task children flush essentially only at spawn and close
// (observed flat for ~398s on a live silently-working child), so growth-based staleness cannot
// distinguish work from death there and the release fired mid-child with NO re-arm path on that
// platform. A child is therefore stale-eligible only once its transcript has been SEEN growing
// (growthObserved) — the continuously-flushing kind the guard was designed for. Flush-at-close
// children (and a cursor-cli child that dies before its second write) instead ride the 10-min
// wall cap: fail-safe (hold, not clear) and bounded. The replay mirrors this via the fold's
// last_activity trail (growth after spawn required — lib/signal_replay.js).
const SUBAGENT_STALE_RELEASE_MS = 180_000;

/**
 * Pure hold decision (shared by the live watcher and the replay deps).
 * @param {object} state
 *   {boolean} state.armed                    continuation machinery seen this turn
 *   {number}  state.openSubagentCount        tied sub-agent transcripts not yet ended
 *   {number|null} state.lastSubagentClosedAtMs  newest tied sub-agent close (epoch/virtual ms)
 *   {number[]} state.notifTimesMs            arrival times of system-notification blobs
 * @param {object} opts { stopAtMs, nowMs, settleMs?, consumeTimeoutMs?, closeGraceMs? }
 * @returns {{ hold: boolean, reason: string }}
 */
function evaluateCursorCliContinuationHold(state = {}, opts = {}) {
  const stopAtMs = Number(opts.stopAtMs) || 0;
  const nowMs = Number(opts.nowMs) || Date.now();
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : DEFAULT_NOTIF_SETTLE_MS;
  const consumeTimeoutMs = Number.isFinite(opts.consumeTimeoutMs)
    ? opts.consumeTimeoutMs
    : DEFAULT_NOTIF_CONSUME_TIMEOUT_MS;
  const closeGraceMs = Number.isFinite(opts.closeGraceMs) ? opts.closeGraceMs : DEFAULT_SUBAGENT_CLOSE_GRACE_MS;

  const activityQuietMs = Number.isFinite(opts.activityQuietMs)
    ? opts.activityQuietMs
    : DEFAULT_ACTIVITY_QUIET_MS;

  const taskHandoffMaxMs = Number.isFinite(opts.taskHandoffMaxMs)
    ? opts.taskHandoffMaxMs
    : DEFAULT_TASK_HANDOFF_MAX_MS;

  // Open sub-agent transcripts hold — EXCEPT those stale past SUBAGENT_STALE_RELEASE_MS (no file
  // growth: the died-mid-tool shape, uncleanly closed with no turn_ended ever coming). A stale
  // release still rides the bounded reasons below (settle etc.) before the clear lands.
  const staleOpen = state.staleOpenSubagentCount || 0;
  if (Math.max(0, (state.openSubagentCount || 0) - staleOpen) > 0) {
    return { hold: true, reason: 'subagent_open' };
  }
  // Task handoff: more open Task tool windows than materialized sub-agent transcripts — the
  // sub-agent's dir hasn't appeared yet (it can lag the parent's early stop by seconds).
  if (
    (state.pendingTaskHandoffCount || 0) > 0 &&
    state.newestTaskWindowOpenMs != null &&
    nowMs - state.newestTaskWindowOpenMs < taskHandoffMaxMs
  ) {
    return { hold: true, reason: 'task_handoff' };
  }
  // A tool call opened AFTER the stop = the injected continuation generation is mid-tool (it can
  // sit inside a long shell with no other observable output). Self-heals on the next stop: the
  // gate re-evaluates against the new stop time, excluding older opens whose close hook was lost.
  if ((state.openToolCallsAfterStop || 0) > 0) return { hold: true, reason: 'tool_open' };
  // Fresh post-stop tool/agent hook activity = continuation generation actively working.
  if (
    state.lastActivityAfterStopMs != null &&
    stopAtMs &&
    state.lastActivityAfterStopMs > stopAtMs + ACTIVITY_STOP_SLACK_MS &&
    nowMs - state.lastActivityAfterStopMs < activityQuietMs
  ) {
    return { hold: true, reason: 'continuation_activity' };
  }
  if (!state.armed) return { hold: false, reason: 'no_continuation_machinery' };
  if (
    state.lastSubagentClosedAtMs != null &&
    nowMs - state.lastSubagentClosedAtMs < closeGraceMs
  ) {
    return { hold: true, reason: 'subagent_close_grace' };
  }
  const notifTimes = Array.isArray(state.notifTimesMs) ? state.notifTimesMs : [];
  const queued = notifTimes.some(
    (t) => t > stopAtMs - NOTIF_STOP_SLACK_MS && nowMs - t < consumeTimeoutMs
  );
  if (queued) return { hold: true, reason: 'notification_queued' };
  if (stopAtMs && nowMs - stopAtMs < settleMs) return { hold: true, reason: 'notification_settle' };
  return { hold: false, reason: 'quiet_after_settle' };
}

// -- live filesystem watcher ---------------------------------------------------------------------

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function listBlobIds(dbArg, { readonly = false } = {}) {
  const args = readonly ? ['-readonly', '-json', dbArg, 'SELECT id FROM blobs;'] : ['-json', dbArg, 'SELECT id FROM blobs;'];
  const out = execFileSync(SQLITE_BIN, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const text = String(out || '').trim();
  const rows = text ? JSON.parse(text) : [];
  return rows.map((r) => String(r.id || '')).filter(Boolean);
}

function readBlobHex(dbArg, id, { readonly = false } = {}) {
  const escaped = String(id).replace(/'/g, "''");
  const sql = `SELECT hex(data) AS data FROM blobs WHERE id='${escaped}';`;
  const args = readonly ? ['-readonly', '-json', dbArg, sql] : ['-json', dbArg, sql];
  const out = execFileSync(SQLITE_BIN, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const text = String(out || '').trim();
  const rows = text ? JSON.parse(text) : [];
  return rows && rows[0] && rows[0].data ? String(rows[0].data) : '';
}

// A decoded blob is a queued task-finished notification when it holds a user-role message whose
// content embeds cursor's `<system_notification>` task-finished template.
function blobIsSystemNotification(raw) {
  for (const obj of extractJsonObjectsFromBuffer(raw)) {
    if (!obj || obj.role !== 'user') continue;
    const content = obj.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ')
          : '';
    if (text.includes('<system_notification>')) return true;
  }
  return false;
}

// Snapshot-read the conversation store.db (same WAL-safe strategy as cursor_chat_db) and return
// the current blob-id list plus a reader for individual blobs. Returns null on any failure.
function withChatDbSnapshot(dir, fn) {
  const dbPath = path.join(dir, 'store.db');
  const walSt = safeStat(`${dbPath}-wal`);
  if (!walSt || walSt.size === 0) {
    try {
      return fn(`file:${dbPath}?immutable=1`, { readonly: false });
    } catch {
      return null;
    }
  }
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cont-ro-'));
    const tmpDb = path.join(tmpDir, 'store.db');
    fs.copyFileSync(dbPath, tmpDb);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.copyFileSync(`${dbPath}${suffix}`, `${tmpDb}${suffix}`); } catch { /* may vanish */ }
    }
    return fn(tmpDb, { readonly: true });
  } catch {
    return null;
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

function transcriptTailIsTurnEnded(transcriptPath) {
  const st = safeStat(transcriptPath);
  if (!st || !st.size) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const len = Math.min(st.size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    let text = buf.toString('utf8');
    if (st.size > len) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return cursorTranscriptTurnEnded(text);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// A sub-agent transcript's first user record wraps the parent's Task prompt in an envelope that
// varies by cursor-agent version: bare prompt (early builds), `<user_query>\n…` (mid-2026), and
// `<timestamp>…</timestamp>\n<user_query>\n…` (2026.07.01-41b2de7+). The tie needle must be the
// prompt text itself — envelope tags never appear in the parent's Task tool_use args — so strip
// every complete LEADING `<tag>…</tag>` block plus a leading `<user_query>` opener, whatever the
// envelope version. Generic on purpose: a `<user_query>`-only strip was defeated by the added
// `<timestamp>` block and re-opened the sub-agent-parent-early-done early clear (−85s, 2026-07-04).
function stripSubagentPromptEnvelope(firstText) {
  let text = String(firstText || '').trim();
  for (let i = 0; i < 8; i += 1) {
    const m = text.match(/^<([a-z_][\w-]*)>[\s\S]*?<\/\1>\s*/i);
    // <user_query> closes at the END of the record — matching its block would swallow the prompt.
    if (!m || /^user_query$/i.test(m[1])) break;
    text = text.slice(m[0].length);
  }
  return text.replace(/^<user_query>\s*/i, '').trim();
}

// First user text from the head bytes of a candidate sub-agent transcript (for the Task-prompt
// tie). Shared by the local file read and the remote (ssh) head fetch so the tie input is byte-
// identical both ways.
function firstUserTextFromTranscriptHead(headText) {
  try {
    const firstLine = String(headText || '').split('\n')[0];
    const record = JSON.parse(firstLine);
    if (record.role !== 'user') return '';
    const content = record.message && Array.isArray(record.message.content) ? record.message.content : [];
    return content
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .join(' ')
      .trim();
  } catch {
    return '';
  }
}

// First user text of a candidate sub-agent transcript (for the Task-prompt tie).
function readFirstUserText(transcriptPath, maxBytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return firstUserTextFromTranscriptHead(buf.slice(0, read).toString('utf8'));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// -- parent↔child tie ------------------------------------------------------------------------------
// The parent transcript holds the Task args INSIDE a JSON string (newlines as \n escapes), so the
// tie needle is the envelope-stripped first user text escaped the same way. Shared by the local
// pollSubagents scan and the remote (ssh) sibling discovery — one tie, never re-implemented.
function buildSubagentTieNeedle(firstText) {
  const rawNeedle = stripSubagentPromptEnvelope(firstText);
  return rawNeedle ? JSON.stringify(rawNeedle).slice(1, -1).slice(0, 120) : '';
}

function subagentTieMatches(parentText, needle) {
  return !!(needle && parentText && parentText.includes(needle.slice(0, 80)));
}

// -- remote (ssh) surface reads --------------------------------------------------------------------
/*
 * createRemoteContinuationOps — the ssh transport for the continuation gate's remote surfaces.
 * `--source ssh` runs cursor-agent headless on the REMOTE host, so every gate surface (sibling
 * sub-agent transcripts, the subagents/ underdir, terminal task files, the chat store.db) lives
 * there. Three operations, each ONE ssh exec, all called ONLY from the watcher's async background
 * refresh (never on the 2s watch tick):
 *   scanSurfaces  — python scan of the transcripts root: NEW sibling dirs (+ first-record head for
 *                   the tie needle), NEW subagents/ underdir transcripts (IDE), 8KB tails for the
 *                   open/closed turn_ended check, and the <slug>/terminals/*.txt task files.
 *                   Params ride base64 (no shell interpolation of remote paths).
 *   tieCheck      — containment check of candidate tie needles against the parent transcript,
 *                   run REMOTELY (the parent transcript can be large; the needle is tiny).
 *   notifScan     — remoteChatDbNotificationScan (lib/cursor_chat_db.js): blob-id diff of the
 *                   remote store.db for queued <system_notification> blobs, decoded locally with
 *                   the same blobIsSystemNotification the local path uses.
 * Injectable in tests (fake ops / fake runSsh returning canned JSON).
 */
function createRemoteContinuationOps({ runSsh = null, timeoutMs = 5000 } = {}) {
  // Lazy default so requiring this module never sets up ssh plumbing for local-only servers.
  let ssh = typeof runSsh === 'function' ? runSsh : null;
  function sshRunner() {
    if (!ssh) {
      const { createSshRunner } = require('./remote_cursor_tracker');
      ssh = createSshRunner();
    }
    return ssh;
  }

  async function pythonJson(host, pyLines, params) {
    const b64 = Buffer.from(JSON.stringify(params || {}), 'utf8').toString('base64');
    const body = `import json,base64,os\nP=json.loads(base64.b64decode("${b64}").decode())\n${pyLines.join('\n')}`;
    const cmd = `python3 - <<'CURSOR_CONT_PYEOF'\n${body}\nCURSOR_CONT_PYEOF`;
    const out = await sshRunner()(host, cmd, timeoutMs);
    const text = String(out || '').trim();
    return text ? JSON.parse(text) : null;
  }

  // NOTE birth time: python st_birthtime exists on macOS/BSD; Linux remotes fall back to
  // st_ctime (inode change ≈ creation for freshly-created transcript/terminal files). The value
  // only gates "born after linked_at", so the fallback is safe.
  async function scanSurfaces({
    host,
    parentTranscriptPath,
    conversationId,
    knownSiblingIds = [],
    knownUnderIds = [],
    openTailPathsByKey = {},
    tailBytes = REMOTE_TAIL_BYTES,
  } = {}) {
    const py = [
      'parent=P["parent"]; conv=P["conv"]',
      'known=set(P.get("known") or []); known_under=set(P.get("known_under") or [])',
      'tail_paths=P.get("tail_paths") or {}; tail_bytes=int(P.get("tail_bytes") or 8192)',
      'parent_dir=os.path.dirname(parent)',
      'root=os.path.dirname(parent_dir)',
      'under=os.path.join(parent_dir,"subagents")',
      'term=os.path.join(os.path.dirname(root),"terminals")',
      'out={"ok":True,"siblings":[],"under":[],"tails":{},"terminals":[]}',
      'def birth_ms(st):',
      '  b=getattr(st,"st_birthtime",0) or st.st_ctime or st.st_mtime',
      '  return int(b*1000)',
      'def tail_read(p):',
      '  try:',
      '    sz=os.path.getsize(p)',
      '    with open(p,"rb") as f:',
      '      if sz>tail_bytes: f.seek(sz-tail_bytes)',
      '      return {"b64":base64.b64encode(f.read()).decode(),"size":sz}',
      '  except OSError: return None',
      'try:',
      '  for name in sorted(os.listdir(root)):',
      '    if name==conv or name in known: continue',
      '    p=os.path.join(root,name,name+".jsonl")',
      '    try: st=os.stat(p)',
      '    except OSError: continue',
      '    first=""',
      '    try:',
      '      with open(p,"rb") as f: first=base64.b64encode(f.read(8192)).decode()',
      '    except OSError: pass',
      '    out["siblings"].append({"id":name,"birth_ms":birth_ms(st),"first_b64":first})',
      '    t=tail_read(p)',
      '    if t: out["tails"][name]=t',
      'except OSError: pass',
      'try:',
      '  for name in sorted(os.listdir(under)):',
      '    if not name.endswith(".jsonl"): continue',
      '    key="subagents/"+name[:-6]',
      '    p=os.path.join(under,name)',
      '    if key not in known_under:',
      '      try: st=os.stat(p)',
      '      except OSError: continue',
      '      out["under"].append({"id":key,"birth_ms":birth_ms(st),"path":p})',
      '    t=tail_read(p)',
      '    if t: out["tails"][key]=t',
      'except OSError: pass',
      'for key,p in tail_paths.items():',
      '  if key in out["tails"]: continue',
      '  t=tail_read(p)',
      '  if t: out["tails"][key]=t',
      'try:',
      '  for name in sorted(os.listdir(term)):',
      '    if not name.endswith(".txt"): continue',
      '    try: st=os.stat(os.path.join(term,name))',
      '    except OSError: continue',
      '    out["terminals"].append({"name":name,"birth_ms":birth_ms(st)})',
      'except OSError: pass',
      'print(json.dumps(out))',
    ];
    return pythonJson(host, py, {
      parent: parentTranscriptPath,
      conv: conversationId,
      known: knownSiblingIds,
      known_under: knownUnderIds,
      tail_paths: openTailPathsByKey,
      tail_bytes: tailBytes,
    });
  }

  async function tieCheck({ host, parentTranscriptPath, needles = {} } = {}) {
    const py = [
      'parent=P["parent"]; needles=P.get("needles") or {}',
      'out={"ok":True,"ties":{}}',
      'try:',
      '  with open(parent,"r",encoding="utf-8",errors="ignore") as f: text=f.read()',
      'except OSError: text=""',
      'for k,n in needles.items():',
      '  out["ties"][k]=bool(n) and (n in text)',
      'print(json.dumps(out))',
    ];
    return pythonJson(host, py, { parent: parentTranscriptPath, needles });
  }

  async function notifScan({ host, conversationId, knownIds = [] } = {}) {
    return remoteChatDbNotificationScan({ host, conversationId, knownIds, runSsh: sshRunner(), timeoutMs });
  }

  return { scanSurfaces, tieCheck, notifScan };
}

/*
 * createCursorCliContinuationWatcher — one instance per server. Poll it every watch tick for each
 * tracked cursor-cli conversation; ask evaluateHold() when a completed stop hint is pending.
 *
 * Per-conversation state is built from three surfaces:
 *  - sibling sub-agent transcripts (spawn = dir birth ≥ linked_at; tie = the sub-agent's first
 *    user record text appears inside a Task tool_use in the parent transcript; open/closed = its
 *    own turn_ended tail),
 *  - terminal task files (<slug>/terminals/<task_id>.txt born ≥ linked_at) — arm-only evidence,
 *  - chat store.db system-notification blobs (id-diff per poll; arrival stamped at observation).
 *
 * ssh-source watches read the SAME surfaces off the remote host (createRemoteContinuationOps),
 * with two structural differences:
 *  - reads are CACHED + refreshed in the background (~2.5s): poll()/evaluateHold() never block
 *    the 2s watch tick on a cold ssh exec — they consume the last completed scan,
 *  - a COLD cache (no successful sibling scan + store.db baseline yet) fails SAFE: evaluateHold
 *    holds through the existing bounded task-handoff window (30s cap) instead of instant-
 *    releasing on missing data, so a dead ssh transport can delay a clear but never wedge it.
 * The local path is untouched — every remote branch is gated on source==='ssh'.
 */
function createCursorCliContinuationWatcher({
  homeDir = os.homedir(),
  nowFn = Date.now,
  remoteOps = null,
  remoteRefreshMs = SSH_REMOTE_REFRESH_MS,
  sshSettleMs = SSH_NOTIF_SETTLE_MS,
} = {}) {
  // Lazy default: local-only servers never touch ssh plumbing.
  let ops = remoteOps;
  function remoteOpsFor() {
    if (!ops) ops = createRemoteContinuationOps({});
    return ops;
  }
  /** @type {Map<string, object>} conversationId -> state */
  const byConv = new Map();

  function stateFor(conv) {
    let st = byConv.get(conv);
    if (!st) {
      st = {
        knownBlobIds: null, // Set — null until first successful scan (first scan is baseline-only)
        notifTimesMs: [],
        subagents: new Map(), // id -> { path, open, closedAtMs }
        terminalsSeen: new Set(),
        armed: false,
        lastPollMs: 0,
        parentTranscriptPath: '',
        linkedAtMs: 0,
        // Per-tool hook activity (noteHookEvent): LIFO name-paired open windows + last activity.
        toolStacks: new Map(), // pair key -> [openMs, ...]
        openToolWindows: [], // { openMs, closeMs|null }
        lastToolActivityMs: null,
        // -- ssh (remote-surface) fields; unused for local watches --
        remote: null, // { host } once an ssh watch polls
        remoteScanPromise: null, // in-flight background refresh (awaitable in tests)
        remoteLastAttemptMs: 0,
        remoteSurfacesOkMs: 0, // last successful sibling/underdir/terminal scan
        remoteNotifOkMs: 0, // last successful store.db notification scan (baseline established)
        remoteColdAnchorMs: 0, // cold-cache fail-safe hold anchor (see evaluateHold)
        remoteTieCandidates: new Map(), // sibling id -> { needle, path } awaiting the parent tie
        remoteSiblingRejects: new Set(), // sibling ids ruled out (born before linked_at)
      };
      byConv.set(conv, st);
    }
    return st;
  }

  function pollNotifications(st, conv) {
    const dir = findChatDbDir(conv, homeDir);
    if (!dir) return;
    const result = withChatDbSnapshot(dir, (dbArg, opts) => {
      const ids = listBlobIds(dbArg, opts);
      const known = st.knownBlobIds;
      const fresh = known ? ids.filter((id) => !known.has(id)) : [];
      const notifIds = [];
      for (const id of fresh) {
        let hex = '';
        try { hex = readBlobHex(dbArg, id, opts); } catch { /* skip */ }
        if (hex && blobIsSystemNotification(Buffer.from(hex, 'hex'))) notifIds.push(id);
      }
      return { ids, notifIds };
    });
    if (!result) return;
    // First successful scan is the baseline: blobs that already exist when the watch links are
    // prior-turn state, not fresh notifications.
    if (st.knownBlobIds === null) {
      st.knownBlobIds = new Set(result.ids);
      return;
    }
    for (const id of result.ids) st.knownBlobIds.add(id);
    if (result.notifIds.length) {
      const now = nowFn();
      for (let i = 0; i < result.notifIds.length; i += 1) st.notifTimesMs.push(now);
      st.armed = true;
    }
  }

  function pollSubagents(st, conv) {
    const parentPath = st.parentTranscriptPath;
    if (!parentPath) return;
    // Cursor IDE: sub-agent transcripts live in the parent's own subagents/ UNDERDIR — trivially
    // parented, no tie needed.
    const underDir = path.join(path.dirname(parentPath), 'subagents');
    let underNames = [];
    try {
      underNames = fs.readdirSync(underDir);
    } catch {
      underNames = [];
    }
    for (const name of underNames) {
      if (!name.endsWith('.jsonl')) continue;
      const id = `subagents/${name.slice(0, -6)}`;
      if (st.subagents.has(id)) continue;
      const candidate = path.join(underDir, name);
      const cst = safeStat(candidate);
      if (!cst) continue;
      const birthMs = cst.birthtimeMs || cst.ctimeMs || cst.mtimeMs;
      if (!birthMs || birthMs < st.linkedAtMs - NOTIF_STOP_SLACK_MS) continue;
      st.subagents.set(id, { path: candidate, open: true, closedAtMs: null, lastSize: cst.size || 0, lastGrowthMs: nowFn(), sizeKnown: true, growthObserved: false });
      st.armed = true;
    }
    // cursor-cli: sub-agent transcripts are SIBLING agent-transcripts dirs.
    const transcriptsRoot = path.dirname(path.dirname(parentPath));
    let entries = [];
    try {
      entries = fs.readdirSync(transcriptsRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    let parentText = null; // lazy read, once per poll at most
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === conv) continue;
      if (st.subagents.has(entry.name)) continue;
      const candidate = path.join(transcriptsRoot, entry.name, `${entry.name}.jsonl`);
      const cst = safeStat(candidate);
      if (!cst) continue;
      const birthMs = cst.birthtimeMs || cst.ctimeMs || cst.mtimeMs;
      if (!birthMs || birthMs < st.linkedAtMs - NOTIF_STOP_SLACK_MS) continue;
      // Tie: the sub-agent's first user text must appear inside the parent transcript (the Task
      // tool_use args carry the same prompt). A concurrent sibling RUN's own prompt won't.
      const firstText = readFirstUserText(candidate);
      if (!firstText) continue;
      if (parentText === null) {
        try { parentText = fs.readFileSync(parentPath, 'utf8'); } catch { parentText = ''; }
      }
      const needle = buildSubagentTieNeedle(firstText);
      if (!subagentTieMatches(parentText, needle)) continue;
      st.subagents.set(entry.name, { path: candidate, open: true, closedAtMs: null, lastSize: cst.size || 0, lastGrowthMs: nowFn(), sizeKnown: true, growthObserved: false });
      st.armed = true;
    }
    for (const sub of st.subagents.values()) {
      if (!sub.open) continue;
      // Growth tracking feeds the stale release (SUBAGENT_STALE_RELEASE_MS): an open transcript
      // that stops growing died mid-tool and will never write its turn_ended.
      const cst = safeStat(sub.path);
      if (cst && Number.isFinite(cst.size) && cst.size !== sub.lastSize) {
        // Size known at registration, so any change afterwards is genuine growth — the child is
        // the continuously-flushing kind and becomes stale-eligible (see SUBAGENT_STALE_RELEASE_MS).
        if (sub.sizeKnown) sub.growthObserved = true;
        sub.lastSize = cst.size;
        sub.lastGrowthMs = nowFn();
        sub.sizeKnown = true;
      }
      const ended = transcriptTailIsTurnEnded(sub.path);
      if (ended === true) {
        sub.open = false;
        sub.closedAtMs = nowFn();
      }
    }
  }

  function pollTerminals(st) {
    const parentPath = st.parentTranscriptPath;
    if (!parentPath) return;
    const slugDir = path.dirname(path.dirname(path.dirname(parentPath)));
    const termDir = path.join(slugDir, 'terminals');
    let names = [];
    try {
      names = fs.readdirSync(termDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.txt') || st.terminalsSeen.has(name)) continue;
      const tst = safeStat(path.join(termDir, name));
      if (!tst) continue;
      const birthMs = tst.birthtimeMs || tst.ctimeMs || tst.mtimeMs;
      if (!birthMs || birthMs < st.linkedAtMs - NOTIF_STOP_SLACK_MS) continue;
      st.terminalsSeen.add(name);
      st.armed = true;
    }
  }

  // Per-tool hook events don't reach the lifecycle hook store — feed them here from the server's
  // cursor hook POST route. Pairing is by tool name (cursor-cli hooks carry no tool_call_id).
  const TOOL_OPEN_EVENTS = new Set(['preToolUse', 'beforeShellExecution', 'beforeReadFile', 'beforeMCPExecution']);
  const TOOL_CLOSE_EVENTS = new Set(['postToolUse', 'postToolUseFailure', 'afterShellExecution', 'afterFileEdit', 'afterMCPExecution']);
  const TOOL_ACTIVITY_EVENTS = new Set([...TOOL_OPEN_EVENTS, ...TOOL_CLOSE_EVENTS, 'afterAgentThought', 'afterAgentResponse']);

  function noteHookEvent(body) {
    if (!body || typeof body !== 'object') return;
    const conv = String(body.conversation_id || '').trim().toLowerCase();
    if (!conv) return;
    const eventName = String(body.hook_event_name || body.event_name || '').trim();
    if (!TOOL_ACTIVITY_EVENTS.has(eventName)) return;
    const st = stateFor(conv);
    const now = nowFn();
    st.lastToolActivityMs = now;
    const pairKey = eventName === 'beforeShellExecution' || eventName === 'afterShellExecution'
      ? 'ShellExec'
      : String(body.tool_name || '') || eventName;
    if (TOOL_OPEN_EVENTS.has(eventName)) {
      let stack = st.toolStacks.get(pairKey);
      if (!stack) { stack = []; st.toolStacks.set(pairKey, stack); }
      const window = { tool: pairKey, openMs: now, closeMs: null };
      stack.push(window);
      st.openToolWindows.push(window);
      if (st.openToolWindows.length > 500) st.openToolWindows.splice(0, st.openToolWindows.length - 500);
    } else if (TOOL_CLOSE_EVENTS.has(eventName)) {
      const stack = st.toolStacks.get(pairKey);
      const window = stack && stack.length ? stack.pop() : null;
      if (window) window.closeMs = now;
    }
  }

  // -- ssh (remote-surface) refresh ---------------------------------------------------------------
  // One background cycle: (1) scan sibling/underdir transcripts + terminal task files, (2) tie new
  // sibling candidates to the parent's Task args (retried until the args land), (3) close open
  // sub-agents whose remote tail became turn_ended, (4) diff the remote store.db for queued
  // <system_notification> blobs. Mutates the SAME per-conversation state the local pollers use, so
  // holdStateFor/evaluateHold are surface-agnostic.
  async function remoteRefreshOnce(st, conv) {
    const host = st.remote && st.remote.host;
    const parent = st.parentTranscriptPath;
    if (!host || !parent) return;
    const o = remoteOpsFor();
    const openTailPathsByKey = {};
    for (const [id, sub] of st.subagents) {
      if (sub.open && sub.path) openTailPathsByKey[id] = sub.path;
    }
    let scan = null;
    try {
      scan = await o.scanSurfaces({
        host,
        parentTranscriptPath: parent,
        conversationId: conv,
        // "known" suppresses re-sending first_b64 for ids we already tied, rejected, or hold as
        // candidates; their tails still arrive via openTailPathsByKey once tied.
        knownSiblingIds: [
          ...[...st.subagents.keys()].filter((k) => !k.startsWith('subagents/')),
          ...st.remoteSiblingRejects,
          ...st.remoteTieCandidates.keys(),
        ],
        knownUnderIds: [...st.subagents.keys()].filter((k) => k.startsWith('subagents/')),
        openTailPathsByKey,
        tailBytes: REMOTE_TAIL_BYTES,
      });
    } catch {
      scan = null;
    }
    if (scan && scan.ok) {
      const linkedFloor = st.linkedAtMs - NOTIF_STOP_SLACK_MS;
      const transcriptsRoot = path.posix.dirname(path.posix.dirname(parent));
      for (const cand of scan.siblings || []) {
        const id = String(cand.id || '');
        if (!id || st.subagents.has(id) || st.remoteTieCandidates.has(id) || st.remoteSiblingRejects.has(id)) continue;
        const birthMs = Number(cand.birth_ms) || 0;
        if (!birthMs || birthMs < linkedFloor) {
          st.remoteSiblingRejects.add(id);
          continue;
        }
        const firstText = firstUserTextFromTranscriptHead(
          Buffer.from(String(cand.first_b64 || ''), 'base64').toString('utf8')
        );
        if (!firstText) continue; // first record not written yet — retry next refresh
        const needle = buildSubagentTieNeedle(firstText);
        if (!needle) continue;
        st.remoteTieCandidates.set(id, { needle, path: path.posix.join(transcriptsRoot, id, `${id}.jsonl`) });
      }
      for (const u of scan.under || []) {
        const id = String(u.id || '');
        if (!id || st.subagents.has(id)) continue;
        const birthMs = Number(u.birth_ms) || 0;
        if (!birthMs || birthMs < linkedFloor) continue;
        // IDE underdir sub-agents are trivially parented — no tie needed (same as local).
        // lastSize 0 = UNKNOWN (the scan has not returned this child's size yet): the first tail's
        // size is a baseline fill, not growth — sizeKnown gates growthObserved below.
        st.subagents.set(id, { path: String(u.path || ''), open: true, closedAtMs: null, lastSize: 0, lastGrowthMs: nowFn(), sizeKnown: false, growthObserved: false });
        st.armed = true;
      }
      for (const t of scan.terminals || []) {
        const name = String(t.name || '');
        if (!name.endsWith('.txt') || st.terminalsSeen.has(name)) continue;
        const birthMs = Number(t.birth_ms) || 0;
        if (!birthMs || birthMs < linkedFloor) continue;
        st.terminalsSeen.add(name);
        st.armed = true;
      }
      // Parent tie for pending candidates (second exec, only while candidates exist). An untied
      // candidate is retried — the parent's Task args can land after the child dir materializes.
      if (st.remoteTieCandidates.size) {
        const needles = {};
        for (const [id, c] of st.remoteTieCandidates) needles[id] = c.needle.slice(0, 80);
        let ties = null;
        try {
          ties = await o.tieCheck({ host, parentTranscriptPath: parent, needles });
        } catch {
          ties = null;
        }
        if (ties && ties.ok) {
          for (const [id, tied] of Object.entries(ties.ties || {})) {
            if (!tied) continue;
            const c = st.remoteTieCandidates.get(id);
            if (!c) continue;
            st.remoteTieCandidates.delete(id);
            st.subagents.set(id, { path: c.path, open: true, closedAtMs: null, lastSize: 0, lastGrowthMs: nowFn(), sizeKnown: false, growthObserved: false });
            st.armed = true;
          }
        }
      }
      // Open/closed via the returned tails (new candidates carry a tail in the same scan, so a
      // sub-agent that tied this cycle can close this cycle too).
      for (const [id, sub] of st.subagents) {
        if (!sub.open) continue;
        const t = scan.tails && scan.tails[id];
        if (!t || !t.b64) continue;
        // Growth tracking for the stale release: the scan already returns the remote file size.
        // The FIRST size reading for a remote entry (registered with lastSize 0 = unknown) is a
        // baseline fill, not growth; only a change against a KNOWN size marks growthObserved.
        const size = Number(t.size) || 0;
        if (size !== sub.lastSize) {
          if (sub.sizeKnown) sub.growthObserved = true;
          sub.lastSize = size;
          sub.lastGrowthMs = nowFn();
        }
        sub.sizeKnown = true;
        let text = Buffer.from(String(t.b64), 'base64').toString('utf8');
        if (size > REMOTE_TAIL_BYTES) {
          // Tail may start mid-line — drop the partial first line (same as transcriptTailIsTurnEnded).
          const nl = text.indexOf('\n');
          if (nl !== -1) text = text.slice(nl + 1);
        }
        if (cursorTranscriptTurnEnded(text) === true) {
          sub.open = false;
          sub.closedAtMs = nowFn();
        }
      }
      st.remoteSurfacesOkMs = nowFn();
    }
    // Queued <system_notification> blobs from the remote store.db. First successful scan is the
    // baseline (same semantics as the local pollNotifications).
    let notif = null;
    try {
      notif = await o.notifScan({
        host,
        conversationId: conv,
        knownIds: st.knownBlobIds ? [...st.knownBlobIds] : [],
      });
    } catch {
      notif = null;
    }
    if (notif) {
      if (st.knownBlobIds === null) {
        st.knownBlobIds = new Set(notif.ids || []);
      } else {
        const now = nowFn();
        for (const id of notif.ids || []) st.knownBlobIds.add(id);
        for (const hex of notif.freshHexes || []) {
          let raw = null;
          try { raw = Buffer.from(String(hex), 'hex'); } catch { raw = null; }
          if (raw && blobIsSystemNotification(raw)) {
            st.notifTimesMs.push(now);
            st.armed = true;
          }
        }
      }
      st.remoteNotifOkMs = nowFn();
    }
  }

  function scheduleRemoteRefresh(st, conv) {
    const now = nowFn();
    if (st.remoteScanPromise || now - st.remoteLastAttemptMs < remoteRefreshMs) return;
    st.remoteLastAttemptMs = now;
    st.remoteScanPromise = remoteRefreshOnce(st, conv)
      .catch(() => { /* transport failure — Ok timestamps stay unset/stale, hold stays safe */ })
      .finally(() => {
        st.remoteScanPromise = null;
      });
  }

  function poll(cursorTracking) {
    if (!cursorTracking) return;
    const conv = String(cursorTracking.conversation_id || cursorTracking.run_id || '').trim().toLowerCase();
    if (!conv) return;
    const st = stateFor(conv);
    st.linkedAtMs = Date.parse(cursorTracking.linked_at || '') || st.linkedAtMs || 0;
    if (typeof cursorTracking.transcript_path === 'string' && cursorTracking.transcript_path.trim()) {
      st.parentTranscriptPath = cursorTracking.transcript_path.trim();
    }
    st.lastPollMs = nowFn();
    if (cursorTracking.source === 'ssh') {
      // Remote surfaces: never touch them on the tick — schedule/refresh the background cache.
      const host = String(cursorTracking.host || cursorTracking.remote_host || '').trim();
      if (!host || !st.parentTranscriptPath) return;
      st.remote = { host };
      scheduleRemoteRefresh(st, conv);
      return;
    }
    try { pollNotifications(st, conv); } catch { /* keep best-effort */ }
    try { pollSubagents(st, conv); } catch { /* keep best-effort */ }
    try { pollTerminals(st); } catch { /* keep best-effort */ }
  }

  function holdStateFor(cursorTracking) {
    const conv = String(cursorTracking?.conversation_id || cursorTracking?.run_id || '').trim().toLowerCase();
    const st = conv ? byConv.get(conv) : null;
    if (!st) return { armed: false, openSubagentCount: 0, staleOpenSubagentCount: 0, lastSubagentClosedAtMs: null, notifTimesMs: [] };
    let open = 0;
    let staleOpen = 0;
    let lastClosed = null;
    const staleFloor = nowFn() - SUBAGENT_STALE_RELEASE_MS;
    for (const sub of st.subagents.values()) {
      if (sub.open) {
        open += 1;
        // No growth for the stale window = died mid-tool (see SUBAGENT_STALE_RELEASE_MS) — but
        // only for children whose transcript has been SEEN growing (growthObserved): a
        // flush-at-close child (cursor-ide) has no growth signal to go stale, so it holds to its
        // close or the wall cap instead of a mid-work release. Entries without growth tracking
        // (older state shapes) never read stale — conservative.
        if (sub.growthObserved === true && sub.lastGrowthMs != null && sub.lastGrowthMs <= staleFloor) staleOpen += 1;
      } else if (sub.closedAtMs != null) lastClosed = Math.max(lastClosed || 0, sub.closedAtMs);
    }
    // Task handoff: open Task tool windows not yet matched by a materialized sub-agent transcript.
    const openTaskWindows = st.openToolWindows.filter((w) => w.tool === 'Task' && w.closeMs == null);
    const pendingTaskHandoffCount = Math.max(0, openTaskWindows.length - st.subagents.size);
    const newestTaskWindowOpenMs = openTaskWindows.length
      ? Math.max(...openTaskWindows.map((w) => w.openMs))
      : null;
    return {
      armed: st.armed,
      openSubagentCount: open,
      staleOpenSubagentCount: staleOpen,
      lastSubagentClosedAtMs: lastClosed,
      notifTimesMs: [...st.notifTimesMs],
      openToolWindows: st.openToolWindows,
      lastToolActivityMs: st.lastToolActivityMs,
      pendingTaskHandoffCount,
      newestTaskWindowOpenMs,
    };
  }

  // Combined poll + decision for a pending completed-stop hint.
  function evaluateHold(cursorTracking, hint, opts = {}) {
    if (!cursorTracking) return false;
    poll(cursorTracking);
    const stopAtMs = Date.parse(hint?.updated_at || '') || 0;
    const state = holdStateFor(cursorTracking);
    const holdOpts = { stopAtMs, nowMs: nowFn(), ...opts };
    if (cursorTracking.source === 'ssh') {
      const conv = String(cursorTracking.conversation_id || cursorTracking.run_id || '').trim().toLowerCase();
      const st = conv ? byConv.get(conv) : null;
      if (st) {
        // COLD remote cache (no successful sibling scan + store.db baseline yet): fail SAFE by
        // riding the existing bounded task-handoff hold — anchored at the stop, capped at
        // taskHandoffMaxMs (30s) — instead of instant-releasing on missing remote data.
        if (!(st.remoteSurfacesOkMs && st.remoteNotifOkMs)) {
          if (!st.remoteColdAnchorMs) st.remoteColdAnchorMs = stopAtMs || nowFn();
          state.pendingTaskHandoffCount = (state.pendingTaskHandoffCount || 0) + 1;
          state.newestTaskWindowOpenMs = Math.max(state.newestTaskWindowOpenMs || 0, st.remoteColdAnchorMs);
        }
      }
      // Remote notification observation lags the remote write by up to a refresh cycle + ssh, so
      // the armed post-stop settle is widened (callers can still override via opts.settleMs).
      if (!Number.isFinite(holdOpts.settleMs)) holdOpts.settleMs = sshSettleMs;
    }
    // Windows opened after the stop and still open now (older unclosed opens belong to the
    // generation the stop already ended — their close hook was dropped, not in flight).
    state.openToolCallsAfterStop = (state.openToolWindows || []).filter(
      (w) => w.openMs > stopAtMs + 500 && w.closeMs == null
    ).length;
    state.lastActivityAfterStopMs =
      state.lastToolActivityMs != null && state.lastToolActivityMs > stopAtMs
        ? state.lastToolActivityMs
        : null;
    const { hold } = evaluateCursorCliContinuationHold(state, holdOpts);
    return hold;
  }

  // Sibling (CLI) sub-agent ids currently known for a conversation — parent-tied Task children
  // discovered by the local scan or the remote refresh. The ssh store.db permission probe uses
  // this to find each child's sibling store.db (the local probe lists them from the filesystem).
  function knownSiblingSubagentIds(conversationId) {
    const conv = String(conversationId || '').trim().toLowerCase();
    const st = conv ? byConv.get(conv) : null;
    if (!st) return [];
    return [...st.subagents.keys()].filter((id) => !id.startsWith('subagents/'));
  }

  function forget(conversationId) {
    const conv = String(conversationId || '').trim().toLowerCase();
    if (conv) byConv.delete(conv);
  }

  return {
    poll,
    noteHookEvent,
    evaluateHold,
    holdStateFor,
    knownSiblingSubagentIds,
    forget,
    _byConv: byConv,
  };
}

module.exports = {
  DEFAULT_NOTIF_SETTLE_MS,
  DEFAULT_NOTIF_CONSUME_TIMEOUT_MS,
  DEFAULT_SUBAGENT_CLOSE_GRACE_MS,
  DEFAULT_ACTIVITY_QUIET_MS,
  SSH_NOTIF_SETTLE_MS,
  SUBAGENT_STALE_RELEASE_MS,
  evaluateCursorCliContinuationHold,
  blobIsSystemNotification,
  stripSubagentPromptEnvelope,
  buildSubagentTieNeedle,
  subagentTieMatches,
  firstUserTextFromTranscriptHead,
  createRemoteContinuationOps,
  createCursorCliContinuationWatcher,
};
