'use strict';

/*
 * live_feed_codex_notes.js — Phase-2b codex rollout-tail NOTES adapter (Lane C §7a item 10).
 *
 * codex's hooks carry prompt / tool_start / tool_end / gate / stop, but NOT mid-turn assistant
 * chat text ("notes"). Those live only in the rollout transcript as `event_msg` records of
 * `payload.type === 'agent_message'` (verified shape below). This adapter tails the watch's OWN
 * rollout file, extracts new agent_message items, and appends them as `note` LiveTurnEvents to
 * that task's live ring — lifting a codex cell from T1 (register) to T2 (narrative).
 *
 * Real rollout line shape (signal-lab/codex-plugin/2026-07-11T01-42-34-933Z transcript@done):
 *   { "timestamp": "2026-07-11T01:42:58.286Z", "type": "event_msg",
 *     "payload": { "type": "agent_message", "message": "…", "phase": "commentary", … } }
 *
 * DESIGN RULES (core-implementation-notes.md §5 Seam B + LiveFeedDataRequirements.MD §codex):
 *  - ATTRIBUTION by transcript_path ONLY. codex's hook session_id ≠ the rollout filename id
 *    (lib/codex_picker_from_hooks.js §"codex dedup identity"), so the reliable task↔rollout join
 *    is the watch's own `transcript_path`, which points AT the rollout file. Each task tails its
 *    own file and appends to its own ring → notes can never leak across tasks by construction.
 *  - FAIL SAFE. A missing/unreadable/partial tail yields NO notes and never throws — the cell
 *    just renders one tier lower. The service's synchronous path is never blocked (this adapter
 *    schedules an async tail whose appends land on the NEXT poll, mirroring
 *    createRemoteCodexAgentRolloutCache's sync-get + background-refresh pattern).
 *  - BOUNDED, OFFSET-INCREMENTAL reads. We seek forward from the last byte offset and never
 *    re-read committed bytes (so a re-poll yields no duplicate notes). The first read is capped
 *    to `initialBytes`; any single-poll delta above `maxBytes` is capped and FLAGGED
 *    (growthFlagged) — nothing can grow unboundedly.
 *  - CONFIG FLAG (default ON, see envFlagEnabled): the local tail is proven cheap and bounded
 *    (LiveTestHarness.md: rollout remote-read 385 B/s, post-done growth 0). The flag exists so an
 *    SSH-frugal setup can disable the remote-read cost; when off, this adapter never touches disk.
 *  - DEBOUNCE via lib/poll_guard.js: the per-task tail is wrapped in wrapNonOverlapping (a slow
 *    tail is skipped, not stacked — the "herd" guard), plus a short TTL gate so rapid re-polls
 *    within one cadence do not re-stat.
 *
 * SSH (Phase-3 / Closure-L6): an ssh-sourced codex watch IS now tailed, over the SAME `runSsh`
 * primitive the other remote codex readers use (`tail -c` in codex_tracker.js). Remote reads are
 * last-N-bytes, not local byte-offset resume, so instead of the local offset the remote path keeps
 * a small POSITION cache (the last-seen remote file SIZE — each poll reads only `size - lastSize`
 * new bytes via `tail -c <delta>`, keeping the wire cost ≈ the rollout's growth, ~0.3-0.4 KB/s per
 * codex-2b-notes.md §7) plus a DEDUP cache (`lastNoteMs`, a watermark on note timestamps, so a
 * boundary re-read never re-emits a note). A HOST-EQUALITY guard binds each remote tail to the
 * watch's own host (a note can never attach to the wrong machine's file), and the SAME off-switch
 * (envFlagEnabled) forces ZERO remote reads. The runner is injected from server.js; with no runner
 * (or the flag off) the remote path cleanly no-ops. The LIVE byte-rate measurement over ssh is
 * a serialized ssh wave (see docs/.../ClosureCampaign/evidence/l6/codex-ssh-build-notes.md).
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const { assertAllowedCodexTranscriptPath, assertAllowedRemoteCodexTranscriptPath } = require('./codex_tracker');
const { wrapNonOverlapping } = require('./poll_guard');
const { CAPS, clamp } = require('./live_turn_normalizer');

// Env flag (default ON). Read live so a restart is not required to flip it; the AGY_PRIMARY_DONE
// precedent (server.js) reads at startup, but a live read costs nothing and keeps the flag honest.
const FLAG_ENV = 'ORCHESTRA_LIVEFEED_CODEX_ROLLOUT_NOTES';
const DEFAULT_INITIAL_TAIL_BYTES = 256 * 1024; // bounded first catch-up read (recovers this turn)
const DEFAULT_MAX_DELTA_BYTES = 512 * 1024; // per-poll growth guard (measured turn delta ≪ this)
const DEFAULT_TTL_MS = 1000; // debounce inside the 2s poll cadence
const DEFAULT_MAX_TASKS = 100; // LRU cap on per-task offset state

// Remote (ssh) tail bounds. The first remote read catches up a bounded window from EOF; each later
// read pulls only `size - lastSize` new bytes (position-delta), capped by the per-poll guard. These
// are separate from the local caps so an ssh-frugal budget can be tuned without touching local.
const DEFAULT_REMOTE_INITIAL_BYTES = 256 * 1024; // one-time first catch-up window from EOF
const DEFAULT_REMOTE_MAX_DELTA_BYTES = 128 * 1024; // per-poll delta cap (steady cost ≈ real growth)
const DEFAULT_REMOTE_TIMEOUT_MS = 4000; // ssh exec timeout (mirrors the other remote codex readers)
const REMOTE_SIZE_MARKER = 'ORCH_SZ:'; // first output line of the remote tail command: byte size

/** POSIX single-quote a value for a remote shell command (mirrors codex_tracker.js shellQuote). */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Default flag state: ON unless the env var is explicitly a falsy-off token. */
function envFlagEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env[FLAG_ENV] || '').trim());
}

/**
 * Pure: parse `note` LiveTurnEvents from rollout JSONL lines. Only `event_msg` records with
 * `payload.type === 'agent_message'` become notes (mid-turn assistant chat text); everything else
 * (reasoning, function_call, user/message records, token_count, task_complete) is ignored.
 * `sinceMs` drops notes at/before a floor time (the watch's link time on the first read).
 * Never throws — a malformed line is skipped.
 */
function codexNotesFromLines(lines, { sinceMs = 0 } = {}) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const t = typeof line === 'string' ? line.trim() : '';
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || obj.type !== 'event_msg') continue;
    const payload = obj.payload;
    if (!payload || payload.type !== 'agent_message') continue;
    const text = clamp(typeof payload.message === 'string' ? payload.message : '', CAPS.noteText);
    if (!text) continue;
    const absMs = Date.parse(obj.timestamp || '') || 0;
    if (sinceMs && absMs && absMs <= sinceMs) continue;
    out.push(absMs ? { abs_ms: absMs, kind: 'note', text } : { kind: 'note', text });
  }
  return out;
}

/**
 * Read NEW rollout bytes since `fromOffset`, returning only COMPLETE lines and a byte-accurate
 * `nextOffset` that always lands on a newline boundary (a partial trailing line is left for the
 * next read, so a note is never split or lost). Bounded: the first read (offset null) is capped to
 * `initialBytes` from EOF; any read whose span exceeds `maxBytes` is capped to the last `maxBytes`
 * and marked `capped` (the growth guard — skipped bytes are the documented cost).
 *
 * @returns {Promise<{lines: string[], nextOffset: number, size: number, capped: boolean}>}
 */
async function readNewRolloutBytes(filePath, fromOffset, { initialBytes, maxBytes }) {
  const st = await fsp.stat(filePath); // ENOENT / perms throw → caller fail-safes
  const size = st.size;
  let start;
  let partialLead; // true ⇒ the first line in the buffer may be partial (drop up to first \n)
  let capped = false;
  if (!Number.isFinite(fromOffset) || fromOffset < 0 || fromOffset > size) {
    // First read (or a truncated/rotated file): catch up from a bounded window before EOF.
    start = Math.max(0, size - initialBytes);
    partialLead = start > 0;
  } else {
    start = fromOffset; // resume exactly at the prior newline boundary
    partialLead = false;
  }
  if (size - start > maxBytes) {
    start = size - maxBytes;
    partialLead = true;
    capped = true;
  }
  const len = size - start;
  if (len <= 0) return { lines: [], nextOffset: size, size, capped };

  const fh = await fsp.open(filePath, 'r');
  let buf;
  try {
    buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
  } finally {
    await fh.close();
  }

  let base = 0;
  if (partialLead) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      // One giant partial line filled the whole window: skip it forward, flag the gap.
      return { lines: [], nextOffset: size, size, capped: true };
    }
    base = nl + 1;
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < base) {
    // No complete line after the lead: consume nothing past `base` (re-read the partial tail).
    return { lines: [], nextOffset: start + base, size, capped };
  }
  const region = buf.slice(base, lastNl + 1); // whole lines, ends on a \n
  const lines = region.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  // start + base + region.length === start + lastNl + 1 — byte offset just past the last newline.
  return { lines, nextOffset: start + base + region.length, size, capped };
}

/**
 * A codex rollout tail applies to a REMOTE (ssh) codex ide_agent watch with a transcript_path AND a
 * host. This is the ssh analog of isLocalCodexWatch — the two are mutually exclusive by `source`.
 */
function isRemoteCodexWatch(wt) {
  return (
    !!wt &&
    typeof wt === 'object' &&
    wt.kind === 'ide_agent' &&
    wt.provider === 'codex' &&
    wt.source === 'ssh' &&
    typeof wt.host === 'string' &&
    wt.host.trim() !== '' &&
    typeof wt.transcript_path === 'string' &&
    wt.transcript_path.trim() !== ''
  );
}

/**
 * Build the remote `tail -c <delta>` command for a rollout file. Reads ONLY the bytes past the last
 * known size (`lastSize`) — a position-delta so the wire cost tracks the rollout's growth, not the
 * whole tail — capped to `capBytes`. Emits `ORCH_SZ:<size>` FIRST so the caller can advance its
 * position cache, then the tailed bytes. `lastSize <= 0` (first read) reads min(size, capBytes) from
 * EOF. Path is single-quoted; the caller MUST validate it with assertAllowedRemoteCodexTranscriptPath
 * before issuing (path discipline — never tail an arbitrary remote path).
 */
function remoteRolloutTailCommand(transcriptPath, lastSize, capBytes) {
  const q = shellQuote(transcriptPath);
  const last = Number.isFinite(lastSize) && lastSize > 0 ? Math.floor(lastSize) : 0;
  const cap = Number.isFinite(capBytes) && capBytes > 0 ? Math.floor(capBytes) : DEFAULT_REMOTE_MAX_DELTA_BYTES;
  // All arithmetic runs REMOTELY off the live size so one round-trip both measures and reads the
  // delta. `d<0` (file truncated/rotated) falls back to the whole (capped) tail; `d>cap` is clamped.
  return (
    `if [ -f ${q} ]; then ` +
    `sz=$(wc -c < ${q} 2>/dev/null | tr -d ' \t'); ` +
    `: "\${sz:=0}"; last=${String(last)}; cap=${String(cap)}; ` +
    `d=$((sz - last)); ` +
    `if [ "$d" -lt 0 ]; then d="$sz"; fi; ` +
    `if [ "$d" -gt "$cap" ]; then d="$cap"; fi; ` +
    `printf '${REMOTE_SIZE_MARKER}%s\\n' "$sz"; ` +
    `tail -c "$d" ${q} 2>/dev/null || true; ` +
    `fi`
  );
}

/**
 * Parse the remote tail output: the first line is `ORCH_SZ:<size>`, the rest are rollout JSONL lines
 * (the leading line may be partial — codexNotesFromLines drops non-JSON). Returns { size, lines }
 * with size=null when the marker is missing (transport hiccup / empty file ⇒ caller keeps its
 * position and appends nothing). Never throws.
 */
function parseRemoteTailOutput(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const nl = text.indexOf('\n');
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (!firstLine.startsWith(REMOTE_SIZE_MARKER)) return { size: null, lines: [] };
  const sizeStr = firstLine.slice(REMOTE_SIZE_MARKER.length).trim();
  const size = /^\d+$/.test(sizeStr) ? Number(sizeStr) : null;
  const body = nl === -1 ? '' : text.slice(nl + 1);
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  return { size, lines };
}

/**
 * Create the codex rollout-notes tail adapter. The live-feed service calls `pump(taskId, wt,
 * nowMs)` for every task after the hook fill; only local codex ide_agent watches with a
 * transcript_path do any work. `pump` is synchronous and non-blocking: it schedules a debounced,
 * non-overlapping background tail whose notes append to the shared ring for the next poll.
 *
 * @param {object} options
 * @param {object} options.ring         the shared live_turn_ring (append target)
 * @param {boolean|Function} [options.enabled]  static bool or predicate; default = env flag
 * @param {string} [options.homeDir]    codex root for path validation (tests inject a tmp home)
 * @param {Function} [options.now]      clock (tests)
 * @param {number} [options.ttlMs]      debounce window (default 1000ms)
 * @param {number} [options.initialBytes] first-read cap (default 256KB)
 * @param {number} [options.maxBytes]   per-poll growth cap (default 512KB)
 * @param {number} [options.maxTasks]   LRU cap on offset state (default 100)
 * @param {Function} [options.runSsh]   ssh runner `runSsh(host, cmd, timeoutMs) → Promise<string>`
 *                                       (server.js injects createSshRunner()); absent ⇒ remote
 *                                       (ssh) codex watches are NOT tailed (the pre-Closure default)
 * @param {string} [options.remoteRoot] remote codex sessions root for path validation (default
 *                                       ~/.codex/sessions; tests inject to exercise the guard)
 * @param {number} [options.remoteInitialBytes] first remote read cap (default 256KB)
 * @param {number} [options.remoteMaxBytes]     per-poll remote delta cap (default 128KB)
 * @param {number} [options.remoteTimeoutMs]    ssh exec timeout (default 4000ms)
 */
function createCodexRolloutNotesAdapter(options = {}) {
  const ring = options.ring || null;
  const homeDir = options.homeDir || os.homedir();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const initialBytes =
    Number.isFinite(options.initialBytes) && options.initialBytes > 0
      ? options.initialBytes
      : DEFAULT_INITIAL_TAIL_BYTES;
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_DELTA_BYTES;
  const maxTasks =
    Number.isInteger(options.maxTasks) && options.maxTasks > 0 ? options.maxTasks : DEFAULT_MAX_TASKS;
  const enabledOpt = options.enabled;
  // Remote (ssh) tail wiring. runSsh absent ⇒ the remote path is disabled (no ssh codex watch is
  // ever tailed) — the pre-Closure behavior. When injected, an ssh codex watch is tailed via the
  // SAME runner + `tail -c` primitive the other remote codex readers use.
  const runSsh = typeof options.runSsh === 'function' ? options.runSsh : null;
  const remoteRoot = typeof options.remoteRoot === 'string' && options.remoteRoot.trim() ? options.remoteRoot.trim() : undefined;
  const remoteInitialBytes =
    Number.isFinite(options.remoteInitialBytes) && options.remoteInitialBytes > 0
      ? options.remoteInitialBytes
      : DEFAULT_REMOTE_INITIAL_BYTES;
  const remoteMaxBytes =
    Number.isFinite(options.remoteMaxBytes) && options.remoteMaxBytes > 0
      ? options.remoteMaxBytes
      : DEFAULT_REMOTE_MAX_DELTA_BYTES;
  const remoteTimeoutMs =
    Number.isFinite(options.remoteTimeoutMs) && options.remoteTimeoutMs > 0
      ? options.remoteTimeoutMs
      : DEFAULT_REMOTE_TIMEOUT_MS;

  function enabled() {
    if (typeof enabledOpt === 'function') return !!enabledOpt();
    if (typeof enabledOpt === 'boolean') return enabledOpt;
    return envFlagEnabled();
  }

  // A LOCAL codex rollout tail applies to a local codex ide_agent watch with a transcript_path.
  // ssh watches take the REMOTE path (isRemoteCodexWatch + remoteTailOnce) when a runSsh is
  // injected; other providers are not ours.
  function isLocalCodexWatch(wt) {
    return (
      !!wt &&
      typeof wt === 'object' &&
      wt.kind === 'ide_agent' &&
      wt.provider === 'codex' &&
      wt.source !== 'ssh' &&
      typeof wt.transcript_path === 'string' &&
      wt.transcript_path.trim() !== ''
    );
  }

  /** @type {Map<string, object>} taskId → { path, offset, linkedAtMs, lastReadAt, growthFlagged, tail }. Map = LRU. */
  const states = new Map();

  function evictLru() {
    while (states.size > maxTasks) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  }

  function ensureState(taskId, wt) {
    const key = String(taskId || '');
    const path = wt.transcript_path.trim();
    let s = states.get(key);
    if (s && s.path !== path) {
      // The task was re-linked to a different rollout: start a fresh offset (no stale carry-over).
      states.delete(key);
      s = null;
    }
    if (!s) {
      s = {
        path,
        offset: null, // null ⇒ first read (bounded catch-up from EOF - initialBytes)
        linkedAtMs: Date.parse(wt.linked_at || '') || 0,
        lastReadAt: -Infinity, // -Infinity (not 0) so a now()===0 clock still schedules the first read
        growthFlagged: false,
        tail: null,
      };
      s.tail = wrapNonOverlapping(() => tailOnce(key));
      states.set(key, s);
      evictLru();
    } else {
      // LRU touch.
      states.delete(key);
      states.set(key, s);
    }
    return s;
  }

  /**
   * One tail pass for a task: read new rollout bytes from the tracked offset, parse notes, append.
   * Never throws; returns the count of appended notes (tests await this via pump's return).
   */
  async function tailOnce(taskId) {
    const s = states.get(String(taskId || ''));
    if (!s) return 0;
    let resolved;
    try {
      // Path discipline: refuse anything outside ~/.codex/sessions (never read an arbitrary path).
      resolved = assertAllowedCodexTranscriptPath(s.path, homeDir);
    } catch {
      return 0;
    }
    let res;
    try {
      res = await readNewRolloutBytes(resolved, s.offset, { initialBytes, maxBytes });
    } catch {
      return 0; // ENOENT / read error: fail safe, no notes, offset unchanged
    }
    const firstRead = s.offset == null;
    const floorMs = firstRead ? s.linkedAtMs : 0; // only the first read scopes to post-link notes
    const notes = codexNotesFromLines(res.lines, { sinceMs: floorMs });
    s.offset = res.nextOffset;
    if (res.capped) s.growthFlagged = true;
    if (notes.length && ring) ring.append(taskId, notes);
    return notes.length;
  }

  // ---- Remote (ssh) tail: position cache (last size) + dedup cache (lastNoteMs) --------------
  /** @type {Map<string, object>} taskId → { host, path, size, lastNoteMs, seenAtWatermark, linkedAtMs, firstRead, lastReadAt, tail }. Map = LRU. */
  const remoteStates = new Map();

  function evictRemoteLru() {
    while (remoteStates.size > maxTasks) {
      const oldest = remoteStates.keys().next().value;
      if (oldest === undefined) break;
      remoteStates.delete(oldest);
    }
  }

  function ensureRemoteState(taskId, wt) {
    const key = String(taskId || '');
    const host = wt.host.trim();
    const path = wt.transcript_path.trim();
    let s = remoteStates.get(key);
    // HOST-EQUALITY guard: a task re-linked to a DIFFERENT host (or a different remote rollout)
    // starts fresh — a note read from host A can never carry into a watch now bound to host B.
    if (s && (s.host !== host || s.path !== path)) {
      remoteStates.delete(key);
      s = null;
    }
    if (!s) {
      s = {
        host,
        path,
        size: 0, // POSITION cache: last-seen remote byte size (0 ⇒ first read caps to remoteInitialBytes)
        firstRead: true,
        lastNoteMs: 0, // DEDUP watermark: notes at/before this ms are already emitted
        seenAtWatermark: new Set(), // texts already emitted AT exactly lastNoteMs (equal-ts tie-break)
        linkedAtMs: Date.parse(wt.linked_at || '') || 0,
        lastReadAt: -Infinity,
        tail: null,
      };
      s.tail = wrapNonOverlapping(() => remoteTailOnce(key, host));
      remoteStates.set(key, s);
      evictRemoteLru();
    } else {
      remoteStates.delete(key);
      remoteStates.set(key, s);
    }
    return s;
  }

  /**
   * One REMOTE tail pass: read only the new bytes (size − lastSize) via `tail -c <delta>` over ssh,
   * parse notes, dedup against the lastNoteMs watermark, and append. Never throws; returns the count
   * appended. `expectHost` re-checks the state's host at APPEND time (the ensure-time guard plus this
   * bind the read to the watch's own machine — a remote read never attaches to the wrong host).
   */
  async function remoteTailOnce(taskId, expectHost) {
    const s = remoteStates.get(String(taskId || ''));
    if (!s || !runSsh) return 0;
    if (expectHost && s.host !== expectHost) return 0; // host changed mid-flight → drop this read
    try {
      // Path discipline: refuse anything outside the remote ~/.codex/sessions before any ssh exec.
      assertAllowedRemoteCodexTranscriptPath(s.path, remoteRoot);
    } catch {
      return 0;
    }
    const cap = s.firstRead ? remoteInitialBytes : remoteMaxBytes;
    const lastSize = s.firstRead ? 0 : s.size;
    const cmd = remoteRolloutTailCommand(s.path, lastSize, cap);
    let raw;
    try {
      raw = await runSsh(s.host, cmd, remoteTimeoutMs);
    } catch {
      return 0; // ssh failure: fail safe, position + watermark unchanged
    }
    const { size, lines } = parseRemoteTailOutput(raw);
    // Only the first read scopes to post-link notes (linked_at floor); later reads use the watermark.
    const floorMs = s.firstRead ? Math.max(s.linkedAtMs, s.lastNoteMs) : s.lastNoteMs;
    const parsed = codexNotesFromLines(lines, { sinceMs: floorMs });
    // DEDUP: strictly past the watermark, or a new text exactly AT the watermark (equal-ts tie).
    const fresh = [];
    for (const n of parsed) {
      const ms = Number.isFinite(n.abs_ms) ? n.abs_ms : 0;
      if (ms > s.lastNoteMs) fresh.push(n);
      else if (ms === s.lastNoteMs && !s.seenAtWatermark.has(n.text)) fresh.push(n);
    }
    // Advance the position cache regardless (even a no-note read moves us forward, keeping the
    // per-poll delta ≈ real growth); a missing size marker leaves the position untouched.
    if (Number.isFinite(size)) s.size = size;
    s.firstRead = false;
    if (fresh.length) {
      let maxMs = s.lastNoteMs;
      for (const n of fresh) if (Number.isFinite(n.abs_ms) && n.abs_ms > maxMs) maxMs = n.abs_ms;
      if (maxMs > s.lastNoteMs) {
        s.lastNoteMs = maxMs;
        s.seenAtWatermark = new Set();
      }
      for (const n of fresh) if (Number.isFinite(n.abs_ms) && n.abs_ms === s.lastNoteMs) s.seenAtWatermark.add(n.text);
      if (ring) ring.append(taskId, fresh);
    }
    return fresh.length;
  }

  /**
   * Synchronous, non-blocking entry point called by the live-feed service per task. Returns the
   * scheduled tail promise (production ignores it; tests await it), or null when skipped
   * (disabled / not a codex watch we tail / no ssh runner for a remote watch / debounced / a prior
   * tail still running). The off-switch (enabled()) is checked FIRST, so a disabled adapter does
   * ZERO reads — local OR remote.
   */
  function pump(taskId, wt, nowMs) {
    try {
      if (!enabled()) return null; // off-switch: zero local AND zero remote reads
      const t = Number.isFinite(nowMs) ? nowMs : now();
      if (isLocalCodexWatch(wt)) {
        const s = ensureState(taskId, wt);
        if (t - s.lastReadAt < ttlMs) return null; // debounce within a cadence
        s.lastReadAt = t;
        return s.tail(); // wrapNonOverlapping → null if a prior tail is still in flight
      }
      // REMOTE (ssh) codex watch: tailed only when a runSsh runner was injected (server.js).
      if (runSsh && isRemoteCodexWatch(wt)) {
        const s = ensureRemoteState(taskId, wt);
        if (t - s.lastReadAt < ttlMs) return null;
        s.lastReadAt = t;
        return s.tail();
      }
      return null;
    } catch {
      return null; // never throw into the service's synchronous path
    }
  }

  return {
    pump,
    enabled,
    drop: (taskId) => {
      states.delete(String(taskId || ''));
      remoteStates.delete(String(taskId || ''));
    },
    // test surface:
    _states: states,
    _remoteStates: remoteStates,
    _tailOnce: tailOnce,
    _remoteTailOnce: remoteTailOnce,
    _ensureState: ensureState,
    _ensureRemoteState: ensureRemoteState,
    _isRemoteCodexWatch: isRemoteCodexWatch,
  };
}

module.exports = {
  createCodexRolloutNotesAdapter,
  codexNotesFromLines,
  readNewRolloutBytes,
  isRemoteCodexWatch,
  remoteRolloutTailCommand,
  parseRemoteTailOutput,
  envFlagEnabled,
  FLAG_ENV,
  DEFAULT_INITIAL_TAIL_BYTES,
  DEFAULT_MAX_DELTA_BYTES,
  DEFAULT_TTL_MS,
  DEFAULT_REMOTE_INITIAL_BYTES,
  DEFAULT_REMOTE_MAX_DELTA_BYTES,
  REMOTE_SIZE_MARKER,
};
