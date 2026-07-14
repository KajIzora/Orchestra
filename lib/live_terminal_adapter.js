'use strict';

/*
 * Live-feed TERMINAL tail adapter — §3.1 Terminal output capture (FollowUps.md).
 *
 * A plain terminal process sits at tier 0 today: the feed knows only PID liveness ("running" /
 * "exited"). This adapter enriches a linked terminal PROCESS watch with what the command is
 * actually printing — command lifecycle → the activity register (tool_start / tool_end), output
 * tail → notes — lifting the row to tier 2 the moment a live output source attaches.
 *
 * Unlike the codex / cowork / grok / agy tail adapters (which READ a transcript file on disk), a
 * terminal's output is PUSHED to us: a companion producer POSTs command_start / output /
 * command_exit to /api/terminal/event (the Cursor shell-integration extension in Phase 2; the
 * Terminal.app / iTerm2 pollers and the file-redirect fallback in a later pass). `ingest()`
 * buffers those events by the producer's stable terminal_id; `pump()` — the tailAdapters-seam
 * entry point — matches a buffer to the polling task's process watch (by pid / pgid / tty),
 * drains it into the shared ring, and stamps `terminal_source` on the watch so liveTierForWatch
 * bumps the rung.
 *
 * Seam contract (same shape as the other tail adapters): { pump, prime, drop, size }, plus the
 * push-side { ingest, getToken, verifyToken } the endpoint calls. pump is synchronous,
 * non-blocking, and NEVER throws — a bad producer can never break a task's feed.
 */

const { CAPS, clamp } = require('./live_turn_normalizer');
const { normTty } = require('./tty_resolver');
const { diffSnapshot } = require('./terminal_scrape_diff');
const { readTerminalText: defaultReadTerminalText } = require('./terminal_applescript');
const { discoverOutputFile: defaultDiscoverOutputFile, readFileTail: defaultReadFileTail } = require('./terminal_file_tail');

// Global off-switch (SSH-frugal / privacy parity with ORCHESTRA_LIVEFEED_CODEX_ROLLOUT_NOTES):
// ORCHESTRA_LIVEFEED_TERMINAL=0 makes both ingest() and pump() no-op. Read per call so a live
// server responds to the toggle without a restart (tests flip it around a single call).
function envEnabled() {
  const v = String(process.env.ORCHESTRA_LIVEFEED_TERMINAL == null ? '' : process.env.ORCHESTRA_LIVEFEED_TERMINAL)
    .trim()
    .toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

// Separately gate the Terminal.app / iTerm2 screen-scrape PULL — it triggers a one-time macOS
// Automation permission prompt. ORCHESTRA_LIVEFEED_TERMINAL_SCRAPE=0 disables just that, leaving
// the Cursor push path (and the file-redirect fallback) on.
function scrapeEnabled() {
  const v = String(process.env.ORCHESTRA_LIVEFEED_TERMINAL_SCRAPE == null ? '' : process.env.ORCHESTRA_LIVEFEED_TERMINAL_SCRAPE)
    .trim()
    .toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

// Gate the file-redirect fallback (tailing a process's stdout/stderr file): set
// ORCHESTRA_LIVEFEED_TERMINAL_FILE=0 to disable reading redirected output files.
function fileEnabled() {
  const v = String(process.env.ORCHESTRA_LIVEFEED_TERMINAL_FILE == null ? '' : process.env.ORCHESTRA_LIVEFEED_TERMINAL_FILE)
    .trim()
    .toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

// How often (ms) a task's terminal window is re-scraped; osascript is comparatively expensive.
const DEFAULT_PULL_DEBOUNCE_MS = 1500;

// The only watch kind this adapter enriches. A process watch carries pid / pgid / tty / cwd
// (watch_tracker.defaultProcessTracking) — the identity POSTed events are matched against.
function isTerminalWatch(wt) {
  return !!(wt && typeof wt === 'object' && wt.kind === 'process');
}

const VALID_EVENTS = new Set(['command_start', 'output', 'command_exit']);

// Cap concurrently-tracked terminals; the oldest-touched is evicted first so a runaway producer
// can never grow this unbounded. Real use is single digits.
const DEFAULT_MAX_TERMINALS = 64;

// One output chunk can be arbitrarily large (a producer that batches a whole build log). Keep
// only the last N non-empty lines of a chunk as notes — the ring's own 300/turn FIFO bounds the
// rest, and the feed is a live TAIL, so the newest lines are what matter.
const MAX_NOTE_LINES_PER_CHUNK = 40;

// Full-screen (alternate-screen) programs — top, htop, vim, less — repaint via cursor-addressed
// escapes that are meaningless as line notes. Detect the alt-screen ENTER and collapse the rest
// of that command's output to one marker note (the §3.1 "reduce to 'command ran'" caveat).
const ALT_SCREEN_ENTER = /\x1b\[\?(?:1049|1047|47)h/;
const ALT_SCREEN_NOTE = '⛶ full-screen program — live output hidden';

// Strip ANSI OSC / CSI sequences + stray control chars so notes read as plain text. \t and \n are
// preserved by the control-char class (output is split on \n before cleaning; \t is trimmed if
// trailing). Bounded, linear; ordinary printable text is left intact.
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CTRL = /[\x00-\x08\x0b-\x1f\x7f]/g;

function cleanLine(text) {
  return String(text == null ? '' : text)
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(CTRL, '')
    .replace(/[ \t]+$/, '');
}

// The register "name" is the program (argv0 basename); detail carries the whole command line.
function commandName(command) {
  const s = String(command || '').trim();
  if (!s) return 'shell';
  const first = s.split(/\s+/)[0] || 'shell';
  const base = first.split('/').pop() || first;
  return base.slice(0, 60) || 'shell';
}

function nowMs() {
  return Date.now();
}

function createTerminalTailAdapter(opts = {}) {
  const ring = opts.ring;
  if (!ring || typeof ring.append !== 'function') {
    throw new Error('createTerminalTailAdapter requires a ring with append()');
  }
  const token = typeof opts.token === 'string' ? opts.token : '';
  const maxTerminals = Number.isFinite(opts.maxTerminals) ? opts.maxTerminals : DEFAULT_MAX_TERMINALS;
  // Optional pid→tty resolver (server injects a `ps`-based one). The extension reports the
  // terminal's SHELL pid; the picker links a CHILD process by its tty. Resolving the shell pid to
  // its tty lets a buffer match a picker-linked watch by terminal device even when the pids differ.
  const resolveTty = typeof opts.resolveTty === 'function' ? opts.resolveTty : null;
  // PULL source: read a Terminal.app / iTerm2 tab's text by tty (screen-scrape → notes) for a
  // process watch with NO Cursor push source. Injected for tests; the default is macOS-only.
  const readTerminalText = typeof opts.readTerminalText === 'function' ? opts.readTerminalText : defaultReadTerminalText;
  // File-redirect fallback readers (injected for tests; defaults use lsof + a bounded file tail).
  const discoverOutputFile = typeof opts.discoverOutputFile === 'function' ? opts.discoverOutputFile : defaultDiscoverOutputFile;
  const readFileTail = typeof opts.readFileTail === 'function' ? opts.readFileTail : defaultReadFileTail;
  const pullDebounceMs = Number.isFinite(opts.pullDebounceMs) ? opts.pullDebounceMs : DEFAULT_PULL_DEBOUNCE_MS;

  /**
   * @type {Map<string, {
   *   identity: {pid: ?number, pgid: ?number, tty: string, cwd: string},
   *   sourceLabel: string,
   *   boundTaskId: ?string,
   *   pending: Array<object>,   // ring events queued for the next pump drain
   *   altScreen: boolean,       // current command switched to the alternate screen
   *   openName: ?string,        // register name of the in-flight command (for its tool_end)
   *   touchedAt: number,
   * }>}
   */
  const terminals = new Map();
  // Per-task PULL state (screen-scrape): the diff anchor, a debounce clock, and a non-overlap
  // guard so a slow osascript read is skipped, not stacked.
  const pullState = new Map();

  function evictIfNeeded() {
    while (terminals.size > maxTerminals) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of terminals) {
        if (v.touchedAt < oldestAt) {
          oldestAt = v.touchedAt;
          oldestKey = k;
        }
      }
      if (oldestKey == null) break;
      terminals.delete(oldestKey);
    }
  }

  function bufferFor(terminalId) {
    let buf = terminals.get(terminalId);
    if (!buf) {
      buf = {
        identity: { pid: null, pgid: null, tty: '', cwd: '' },
        sourceLabel: '',
        boundTaskId: null,
        pending: [],
        altScreen: false,
        openName: null,
        touchedAt: nowMs(),
        ttyTried: false, // resolved the shell pid → tty at most once per terminal
        ttyReady: null, // the resolution promise (exposed for tests)
      };
      terminals.set(terminalId, buf);
      evictIfNeeded();
    }
    return buf;
  }

  function mergeIdentity(buf, body) {
    const id = buf.identity;
    if (Number.isFinite(body.pid)) id.pid = Number(body.pid);
    if (Number.isFinite(body.pgid)) id.pgid = Number(body.pgid);
    if (typeof body.tty === 'string' && body.tty.trim()) id.tty = body.tty.trim();
    if (typeof body.cwd === 'string' && body.cwd.trim()) id.cwd = body.cwd.trim();
    if (typeof body.source === 'string' && body.source.trim()) buf.sourceLabel = body.source.trim().slice(0, 32);
  }

  // Resolve this terminal's tty from its (shell) pid, once, in the background. Sets identity.tty so
  // a picker-linked watch — which keys on the CHILD process's tty, not the shell pid — can match.
  // Fire-and-forget: the tty lands on identity for a later poll; ingest stays fast, never throws.
  function maybeResolveTty(buf) {
    if (!resolveTty || buf.ttyTried || buf.identity.tty || buf.identity.pid == null) return;
    buf.ttyTried = true;
    buf.ttyReady = Promise.resolve()
      .then(() => resolveTty(buf.identity.pid))
      .then((t) => {
        if (t && !buf.identity.tty) buf.identity.tty = String(t);
      })
      .catch(() => {});
  }

  // Queue one output chunk's lines as note events, honoring the alt-screen collapse.
  function pushOutput(buf, rawText, absMs) {
    if (buf.altScreen) return; // already collapsed for this command
    const raw = String(rawText == null ? '' : rawText);
    if (ALT_SCREEN_ENTER.test(raw)) {
      buf.altScreen = true;
      buf.pending.push({ abs_ms: absMs, kind: 'note', text: ALT_SCREEN_NOTE });
      return;
    }
    const lines = [];
    for (const rawLine of raw.split('\n')) {
      const line = cleanLine(rawLine);
      if (line) lines.push(line);
    }
    const tail = lines.length > MAX_NOTE_LINES_PER_CHUNK ? lines.slice(-MAX_NOTE_LINES_PER_CHUNK) : lines;
    for (const line of tail) {
      buf.pending.push({ abs_ms: absMs, kind: 'note', text: clamp(line, CAPS.noteText) });
    }
  }

  /**
   * Ingest one POSTed terminal event. Maps it to ring events queued on the terminal's buffer;
   * pump() drains them once the terminal is matched to a task. Never throws.
   * @returns {{ok: boolean, error?: string, disabled?: boolean}}
   */
  function ingest(body = {}) {
    if (!envEnabled()) return { ok: true, disabled: true };
    if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
    const event = typeof body.event === 'string' ? body.event : '';
    if (!VALID_EVENTS.has(event)) return { ok: false, error: `unknown event: ${event}` };
    const terminalId = typeof body.terminal_id === 'string' ? body.terminal_id.trim() : '';
    if (!terminalId) return { ok: false, error: 'terminal_id required' };
    try {
      const buf = bufferFor(terminalId);
      buf.touchedAt = nowMs();
      mergeIdentity(buf, body);
      maybeResolveTty(buf);
      const absMs = Number.isFinite(body.t) ? Number(body.t) : nowMs();
      if (event === 'command_start') {
        const command = typeof body.command === 'string' ? body.command : '';
        buf.altScreen = false;
        buf.openName = commandName(command);
        // A command is a TURN: the prompt resets the ring (so each command's ring is bounded
        // separately and a chatty build can't evict the register), then tool_start opens the
        // register line "running".
        buf.pending.push({ abs_ms: absMs, kind: 'prompt', text: clamp(command || buf.openName, CAPS.promptText) });
        buf.pending.push({ abs_ms: absMs, kind: 'tool_start', name: buf.openName, detail: clamp(command, CAPS.detail) });
      } else if (event === 'output') {
        pushOutput(buf, body.output, absMs);
      } else if (event === 'command_exit') {
        const code = Number.isFinite(body.exit_code) ? Number(body.exit_code) : null;
        const name = buf.openName || commandName(body.command || '');
        let detail = code == null ? '' : code === 0 ? 'exit 0' : `exit ${code}`;
        if (Number.isFinite(body.duration_ms)) {
          const ms = `${Math.round(Number(body.duration_ms))}ms`;
          detail = detail ? `${detail} · ${ms}` : ms;
        }
        buf.pending.push({
          abs_ms: absMs,
          kind: 'tool_end',
          name,
          detail: clamp(detail, CAPS.detail),
          ok: code == null ? true : code === 0,
        });
        buf.altScreen = false;
        buf.openName = null;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'ingest failed' };
    }
  }

  // A buffered terminal belongs to a process watch when ANY strong identity field agrees. pid is
  // the primary key (the producer reports the shell/command pid); pgid and tty are fallbacks for
  // producers that only know the process group or controlling device.
  function identityMatches(identity, wt) {
    if (!identity || !wt) return false;
    if (identity.pid != null && Number.isFinite(wt.pid) && Number(wt.pid) === identity.pid) return true;
    if (identity.pgid != null && Number.isFinite(wt.pgid) && Number(wt.pgid) === identity.pgid) return true;
    // Terminal-device match (the picker flow): the shell pid resolved to identity.tty; the watch
    // carries the linked process's tty. Normalize so 'ttys009' / '/dev/ttys009' / 's009' compare equal.
    if (identity.tty && wt.tty) {
      const a = normTty(identity.tty);
      if (a && a === normTty(wt.tty)) return true;
    }
    return false;
  }

  function hasPushSource(taskId) {
    for (const [, buf] of terminals) {
      if (buf.boundTaskId === taskId) return true;
    }
    return false;
  }

  // PULL enrichment for a process watch with no Cursor push source: screen-scrape its Terminal.app
  // / iTerm2 tab (by tty), or — if output went to a file — tail that file. Debounced +
  // non-overlapping + fail-safe: the async read appends on a later poll and never throws into pump.
  function maybePull(taskId, wt, nowMsArg) {
    if (hasPushSource(taskId)) return; // a Cursor push source, if any, wins
    const canScrape = scrapeEnabled() && !!wt.tty && !!readTerminalText;
    const canFile = fileEnabled() && Number.isFinite(wt.pid) && !!discoverOutputFile && !!readFileTail;
    if (!canScrape && !canFile) return;
    let st = pullState.get(taskId);
    if (!st) {
      st = { anchor: [], lastPollMs: 0, reading: false, readingPromise: null, filePath: undefined, fileOffset: null };
      pullState.set(taskId, st);
    }
    if (st.reading) return;
    if (nowMsArg - st.lastPollMs < pullDebounceMs) return;
    st.lastPollMs = nowMsArg;
    st.reading = true;
    st.readingPromise = Promise.resolve()
      .then(() => doPull(taskId, wt, nowMsArg, st, canScrape, canFile))
      .catch(() => {})
      .finally(() => {
        st.reading = false;
      });
  }

  // Prefer the live terminal window; fall back to a file redirect. One source enriches per poll.
  async function doPull(taskId, wt, nowMsArg, st, canScrape, canFile) {
    if (canScrape) {
      const res = await readTerminalText(wt.tty);
      if (res && res.text) {
        const { lines, anchor } = diffSnapshot(st.anchor, res.text);
        st.anchor = anchor;
        emitPullNotes(taskId, wt, nowMsArg, lines, res.app); // 'terminal_app' | 'iterm'
        return;
      }
    }
    if (canFile) {
      if (st.filePath === undefined) st.filePath = await discoverOutputFile(wt.pid); // resolve once
      if (st.filePath) {
        const r = await readFileTail(st.filePath, st.fileOffset);
        st.fileOffset = r.offset;
        emitPullNotes(taskId, wt, nowMsArg, r.lines, 'file');
      }
    }
  }

  function emitPullNotes(taskId, wt, nowMsArg, lines, app) {
    if (!lines || !lines.length) return;
    const events = [];
    for (const line of lines) {
      const clean = cleanLine(line);
      if (clean) events.push({ abs_ms: nowMsArg, kind: 'note', text: clamp(clean, CAPS.noteText) });
    }
    if (!events.length) return;
    if (!wt.terminal_source) wt.terminal_source = app;
    wt.terminal_source_at = nowMsArg;
    try {
      ring.append(taskId, events);
    } catch {
      /* bounded; never break the feed */
    }
  }

  /**
   * tailAdapters seam entry: for the polling task's process watch, drain any matched terminal
   * buffers into the ring (Cursor push) or scrape its terminal window (Terminal.app / iTerm2 pull),
   * attaching the source on first output so the tier bumps. Synchronous, fail-safe, never throws.
   */
  function pump(taskId, wt, when) {
    try {
      if (!envEnabled() || !isTerminalWatch(wt)) return;
      const tid = String(taskId == null ? '' : taskId);
      if (!tid) return;
      const stamp = Number.isFinite(when) ? when : nowMs();
      for (const [, buf] of terminals) {
        if (buf.boundTaskId && buf.boundTaskId !== tid) continue;
        if (!buf.boundTaskId) {
          if (!identityMatches(buf.identity, wt)) continue;
          buf.boundTaskId = tid;
        }
        if (!buf.pending.length) continue;
        // Attach: real events are queued, so the source is provably live → stamp terminal_source
        // (liveTierForWatch reads it to bump 0 → 2). Dynamic-on-first-event means an attached-but-
        // silent source never shows an empty register. Fail-safe: a failed append below just
        // leaves the row at whatever the ring already holds.
        if (!wt.terminal_source) wt.terminal_source = buf.sourceLabel || 'terminal';
        wt.terminal_source_at = stamp;
        const batch = buf.pending;
        buf.pending = [];
        try {
          ring.append(tid, batch);
        } catch {
          /* never break the feed; the dropped batch is bounded */
        }
      }
      // No Cursor push buffer for this task? Fall through to the pull source (screen scrape).
      maybePull(tid, wt, stamp);
    } catch {
      /* an adapter can never break a task's feed */
    }
  }

  // Terminal capture is push-driven; there is nothing to schedule ahead of a poll — pump() does
  // all the draining. prime() delegates to pump() for seam symmetry (draining is idempotent: the
  // pending queue is emptied on the first drain, so a prime-then-pump caller double-drains nothing).
  function prime(taskId, wt) {
    pump(taskId, wt);
  }

  function drop(taskId) {
    const tid = String(taskId == null ? '' : taskId);
    for (const [k, buf] of terminals) {
      if (buf.boundTaskId === tid) terminals.delete(k);
    }
    pullState.delete(tid);
  }

  // Same token idiom as the hook stores (header, else body/query token). Header name:
  // X-Terminal-Token. Served to the producer by GET /api/terminal/config.
  function verifyToken(req) {
    const header = req && typeof req.get === 'function' ? req.get('x-terminal-token') : null;
    const bodyToken = req && req.body && typeof req.body === 'object' ? req.body.token : undefined;
    const queryToken = req && req.query && typeof req.query === 'object' ? req.query.token : undefined;
    const t = header || bodyToken || queryToken;
    return typeof t === 'string' && t.length > 0 && t === token;
  }

  return {
    ingest,
    pump,
    prime,
    drop,
    size: () => terminals.size,
    getToken: () => token,
    verifyToken,
    isTerminalWatch,
    _terminals: terminals,
    _pullState: pullState,
  };
}

module.exports = {
  createTerminalTailAdapter,
  isTerminalWatch,
  commandName,
  cleanLine,
  DEFAULT_MAX_TERMINALS,
  MAX_NOTE_LINES_PER_CHUNK,
  ALT_SCREEN_NOTE,
};
