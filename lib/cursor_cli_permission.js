'use strict';

/*
 * cursor_cli_permission.js — config-eval + arm/resume permission inference for cursor-agent CLI.
 *
 * Background: cursor-cli emits NO machine signal that says "I'm waiting for a permission
 * gate." A permission gate exists only as TUI text. BUT cursor-cli fires `preToolUse`
 * (and `beforeShellExecution`) hooks for EVERY tool call, and the CLI permission *config*
 * (allow/deny/approvalMode + the session --force/--yolo flag) deterministically decides
 * whether a given tool call will PROMPT (gate), AUTO-run, or be DENIED.
 *
 * So this module reads+merges the config, evaluates each tool call's hook body against
 * deny→runEverything→allow→prompt, and (in the tracker) arms `permission_pending` when a
 * call would PROMPT, clearing it when the matching after-hook / next activity arrives. This
 * mirrors how Orchestra already does Codex/Gemini permission tracking (PreToolUse for a
 * gated tool → pending; later PostToolUse → resume — see gemini_hook_store.deriveAgySnapshotFlags).
 *
 * The only genuinely new piece vs Codex/Gemini is that we must evaluate the config
 * ourselves, because cursor's pre-hooks fire for *all* tools, not just gated ones.
 *
 * Design + limitations are documented in docs/internal/CursorCliPermissionInferenceFeasibility.md.
 * Key limitation: --force/--yolo is INVISIBLE in hooks. The evaluator takes `forceMode` as an
 * explicit input — Orchestra only knows it when it launched the agent. When forceMode is
 * unknown (false) but the session is actually forced, an un-allowed tool is predicted to
 * PROMPT but actually auto-runs; the false pending self-clears on the tool's after-hook
 * (fast), except force + a long-running tool (no after-hook for a while looks like a gate).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The five tool categories cursor-cli's permission model gates on. Tools outside this set
// (Grep, Task/sub-agent, AskQuestion, …) are never permission-gated and evaluate to 'auto'.
const GATEABLE_CATEGORIES = Object.freeze(['Shell', 'Read', 'Write', 'WebFetch', 'Mcp']);

// approvalMode values that mean "Run Everything" (auto-approve except explicit deny). The
// allowlist default (prompt unless an allow rule matches) is anything else / empty.
const RUN_EVERYTHING_MODES = new Set([
  'auto',
  'yolo',
  'all',
  'runeverything',
  'run-everything',
  'full-auto',
  'fullauto',
  'bypass',
]);

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Compile a cursor permission glob into a RegExp.
 *
 * `pathAware` (Read/Write path tokens): `*` matches within a path segment (not `/`), `**`
 * matches across segments, `?` matches one non-`/` char. `pathAware:false` (Shell args,
 * WebFetch domains, Mcp specs): `*`/`**` match any run of characters, `?` matches one char.
 */
function globToRegExp(pattern, { pathAware } = {}) {
  let re = '';
  const src = String(pattern || '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '*') {
      if (src[i + 1] === '*') {
        i += 1;
        if (pathAware && src[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?'; // `**/` — zero or more leading path segments
        } else {
          re += '.*';
        }
      } else {
        re += pathAware ? '[^/]*' : '.*';
      }
    } else if (c === '?') {
      re += pathAware ? '[^/]' : '.';
    } else {
      re += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matchGlob(pattern, value, pathAware) {
  if (typeof value !== 'string') return false;
  return globToRegExp(pattern, { pathAware }).test(value);
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

/** Parse `Category(arg)` → { category, arg }. Returns null if not a token. */
function parseToken(token) {
  const m = /^\s*([A-Za-z]+)\(([\s\S]*)\)\s*$/.exec(String(token || ''));
  if (!m) return null;
  return { category: m[1], arg: m[2] };
}

function tokensForCategory(tokenList, category) {
  const out = [];
  for (const raw of Array.isArray(tokenList) ? tokenList : []) {
    const parsed = parseToken(raw);
    if (parsed && parsed.category === category) out.push(parsed.arg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shell command tokenization
// ---------------------------------------------------------------------------

/**
 * Split a shell command on top-level separators (`&&`, `||`, `;`, `|`, newline) into
 * segments, each reduced to { base, args, raw }. `base` is the first program token (after
 * stripping leading `FOO=bar` env assignments); `args` is the remainder of the segment.
 * Chained/piped commands gate if ANY segment is not allowed — matching cursor's per-command
 * evaluation more faithfully than only inspecting the first program.
 *
 * NB: this is a deliberately simple splitter — it does not parse quotes/subshells. A `&&`
 * inside a quoted string would over-split. Documented as a residual edge in the feasibility
 * doc; refine empirically if it bites.
 */
function shellSegments(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return [];
  const rawSegments = cmd.split(/\s*(?:\|\||&&|;|\||\n)\s*/).map((s) => s.trim()).filter(Boolean);
  return rawSegments.map((raw) => {
    const tokens = raw.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
    const base = tokens[i] || '';
    const args = tokens.slice(i + 1).join(' ');
    return { base, args, raw };
  });
}

/**
 * Does a Shell allow/deny token match one command segment?
 *  - `Shell(base)`           → token `base` glob-matches the segment's program.
 *  - `Shell(basePat:argPat)` → base glob-matches AND argPat glob-matches the segment's args.
 * Both halves use generic (non-path-aware) glob, so `Shell(curl:*)` allows any curl args.
 */
function shellTokenMatchesSegment(tokenArg, seg) {
  const colon = String(tokenArg).indexOf(':');
  const basePat = colon === -1 ? tokenArg : tokenArg.slice(0, colon);
  const argPat = colon === -1 ? undefined : tokenArg.slice(colon + 1);
  if (!matchGlob(basePat, seg.base, false)) return false;
  if (argPat === undefined) return true;
  return matchGlob(argPat, seg.args, false);
}

// ---------------------------------------------------------------------------
// Path token matching (Read / Write)
// ---------------------------------------------------------------------------

function expandHome(p, homeDir) {
  if (typeof p !== 'string') return '';
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  return p;
}

/**
 * Does a Read/Write path token match a file path? Absolute tokens match the absolute path
 * directly; relative tokens are scoped to each workspace root (matched against the
 * workspace-relative path), matching cursor's "relative paths scoped to workspace" rule.
 */
function pathTokenMatches(tokenArg, filePath, workspaceRoots, homeDir) {
  const file = String(filePath || '');
  if (!file) return false;
  const expanded = expandHome(tokenArg, homeDir);
  if (path.isAbsolute(expanded)) {
    return matchGlob(expanded, file, true);
  }
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  for (const root of roots) {
    if (!root) continue;
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (matchGlob(expanded, rel, true)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool-call extraction from a hook body
// ---------------------------------------------------------------------------

function hookEventName(body) {
  const b = body && typeof body === 'object' ? body : {};
  return String(b.hook_event_name || b.event_name || '').trim();
}

/**
 * Distinguish a cursor-agent **CLI** hook from a cursor **IDE** hook. Both surfaces forward
 * through the shared `~/.cursor/hooks.json`, but config-eval permission inference applies
 * ONLY to the CLI — the IDE uses its own permissions (not `cli-config.json`) and already has
 * renderer.log / agent-exec permission probes. The reliable discriminator is `cursor_version`:
 * the CLI ships CalVer (`2026.06.15-…`), the IDE ships SemVer (`3.7.42`). Centralized here so
 * it is easy to revise if cursor changes its versioning.
 */
function isCursorCliHook(body) {
  const v = String((body && body.cursor_version) || '').trim();
  if (!v) return false;
  return /^\d{4}\.\d{2}\b/.test(v); // CalVer year.month… → CLI; SemVer 3.x.y → IDE
}

/**
 * Map a `cursor_version` to Orchestra's surface kind, reusing the same CalVer/SemVer discriminator
 * as {@link isCursorCliHook}: CalVer → the cursor-agent **CLI** ('cli'), any other non-empty
 * version → the Cursor **editor** ('plugin'). Empty (no hook carried a version yet) → '' so the UI
 * shows no surface glyph rather than guessing. Cursor has no separate desktop-app surface.
 */
function cursorSurfaceFromVersion(cursorVersion) {
  const v = String(cursorVersion || '').trim();
  if (!v) return '';
  return /^\d{4}\.\d{2}\b/.test(v) ? 'cli' : 'plugin';
}

const PRE_EVENTS = new Set(['preToolUse', 'beforeShellExecution', 'beforeReadFile', 'beforeMCPExecution']);
const RESOLVE_EVENTS = new Set([
  'postToolUse',
  'postToolUseFailure',
  'afterShellExecution',
  'afterFileEdit',
  'afterMCPExecution',
  'stop',
  'sessionEnd',
]);

function toolNameToCategory(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return null;
  if (name === 'Shell') return 'Shell';
  if (name === 'Read') return 'Read';
  if (name === 'Write' || name === 'Edit') return 'Write';
  if (name === 'WebFetch') return 'WebFetch';
  if (/^mcp[_-]/i.test(name) || name === 'Mcp') return 'Mcp';
  // Grep, Task/sub-agent, AskQuestion, Glob, … are not permission-gated.
  return null;
}

/**
 * Normalize a hook body into the fields the evaluator needs. Returns null for hooks that
 * are not a tool-call (sessionStart, beforeSubmitPrompt, …).
 *
 * To avoid double-counting (cursor fires BOTH preToolUse and beforeShellExecution for one
 * shell command), only `preToolUse` is treated as an ARM-capable tool call. The
 * shell/read/mcp-specific before* events carry the same call and are classified as neutral
 * (they neither arm nor resume); their after* counterparts resume.
 */
function extractToolCall(body) {
  const b = body && typeof body === 'object' ? body : {};
  const eventName = hookEventName(b);
  if (!eventName) return null;

  const conversationId = String(b.conversation_id || b.session_id || '').trim().toLowerCase();
  const toolUseId = String(b.tool_use_id || b.tool_call_id || '').trim();
  const workspaceRoots = Array.isArray(b.workspace_roots)
    ? b.workspace_roots.filter((x) => typeof x === 'string')
    : [];

  const base = {
    event_name: eventName,
    conversation_id: conversationId,
    tool_use_id: toolUseId,
    workspace_roots: workspaceRoots,
    cwd: typeof b.cwd === 'string' ? b.cwd : '',
    is_pre: PRE_EVENTS.has(eventName),
    is_resolve: RESOLVE_EVENTS.has(eventName),
    is_arm_candidate: eventName === 'preToolUse',
    category: null,
    command: '',
    file_path: '',
    domain: '',
    mcp_server: '',
    mcp_tool: '',
    detail: '',
  };

  if (eventName === 'preToolUse' || eventName === 'postToolUse' || eventName === 'postToolUseFailure') {
    const category = toolNameToCategory(b.tool_name);
    base.category = category;
    const input = b.tool_input && typeof b.tool_input === 'object' ? b.tool_input : {};
    if (category === 'Shell') base.command = String(input.command || '');
    else if (category === 'Read' || category === 'Write') base.file_path = String(input.file_path || input.path || '');
    else if (category === 'WebFetch') base.domain = domainFromUrl(input.url || input.domain || '');
    else if (category === 'Mcp') {
      base.mcp_server = String(input.server || b.mcp_server || '');
      base.mcp_tool = String(input.tool || b.tool_name || '');
    }
  } else if (eventName === 'beforeShellExecution' || eventName === 'afterShellExecution') {
    base.category = 'Shell';
    base.command = String(b.command || '');
  } else if (eventName === 'beforeReadFile') {
    base.category = 'Read';
    base.file_path = String(b.file_path || b.path || '');
  } else if (eventName === 'beforeMCPExecution' || eventName === 'afterMCPExecution') {
    base.category = 'Mcp';
    base.mcp_server = String(b.server || b.mcp_server || '');
    base.mcp_tool = String(b.tool || b.tool_name || '');
  } else if (eventName === 'afterFileEdit') {
    base.category = 'Write';
    base.file_path = String(b.file_path || b.path || '');
  } else if (!base.is_resolve) {
    // Not a tool-call event and not a resume event → irrelevant to permission tracking.
    return null;
  }

  base.detail = gateDetail(base);
  return base;
}

function domainFromUrl(urlOrDomain) {
  const s = String(urlOrDomain || '').trim();
  if (!s) return '';
  try {
    return new URL(s).hostname || s;
  } catch {
    // Already a bare domain (or unparseable) — strip any path.
    return s.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  }
}

/** Short human label for a gate, used in recorded episodes (never for matching). */
function gateDetail(call) {
  if (!call || !call.category) return '';
  if (call.category === 'Shell') {
    const seg = shellSegments(call.command)[0];
    const baseName = seg ? seg.base : '';
    return baseName ? `Shell(${baseName})` : 'Shell';
  }
  if (call.category === 'Read' || call.category === 'Write') {
    return call.file_path ? `${call.category}(${call.file_path})` : call.category;
  }
  if (call.category === 'WebFetch') return call.domain ? `WebFetch(${call.domain})` : 'WebFetch';
  if (call.category === 'Mcp') return `Mcp(${call.mcp_server || '*'}:${call.mcp_tool || '*'})`;
  return call.category;
}

// ---------------------------------------------------------------------------
// Config loading + merge
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Nearest ancestor of `start` (inclusive) that contains a `.git` entry, or '' if none. */
function findGitRoot(start) {
  let dir = start;
  // Bound the walk so a stray cwd can't traverse the whole filesystem.
  for (let i = 0; i < 64 && dir; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      /* ignore */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/** Directories from the git root (or the leaf itself) down to `leaf`, inclusive, in order. */
function dirsGitRootToLeaf(leaf) {
  if (!leaf) return [];
  const root = findGitRoot(leaf) || leaf;
  const chain = [];
  let dir = leaf;
  while (dir) {
    chain.push(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.reverse(); // shallow (root) → deep (leaf)
}

function emptyMergedConfig() {
  return { allow: [], deny: [], approvalMode: '' };
}

/**
 * Apply one config object's `permissions` onto the running merge. Each key is REPLACE-if-
 * present (deeper wins): a project `.cursor/cli.json` with `{allow:[],deny:[]}` overrides
 * the global allow list entirely — this is the documented empty-block gotcha, where prompts
 * repeat even after "Always allow" wrote tokens to the global config.
 */
function applyConfigLayer(merged, cfg) {
  if (!cfg || typeof cfg !== 'object') return merged;
  const perms = cfg.permissions && typeof cfg.permissions === 'object' ? cfg.permissions : {};
  if (Array.isArray(perms.allow)) merged.allow = perms.allow.slice();
  if (Array.isArray(perms.deny)) merged.deny = perms.deny.slice();
  const mode = perms.approvalMode ?? cfg.approvalMode;
  if (typeof mode === 'string' && mode) merged.approvalMode = mode;
  return merged;
}

/**
 * Read + merge cursor-cli permission config:
 *   ~/.cursor/cli-config.json (global defaults / "Always allow" target)
 *   then .cursor/cli.json from git-root → cwd (deeper wins), unless disableProjectConfigs.
 *
 * @param {object} [opts]
 * @param {string} [opts.homeDir]
 * @param {string[]} [opts.workspaceRoots]  from the hook body (anchor when cwd is empty)
 * @param {string} [opts.cwd]               leaf dir to walk down to
 * @param {boolean} [opts.disableProjectConfigs]  mirror cursor's --disable-project-configs
 * @param {string} [opts.globalConfigPath]  override (testing)
 * @returns {{allow:string[], deny:string[], approvalMode:string, sources:string[]}}
 */
function loadCursorCliConfig(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const globalConfigPath = opts.globalConfigPath || path.join(homeDir, '.cursor', 'cli-config.json');
  const merged = emptyMergedConfig();
  const sources = [];

  const globalCfg = readJsonFile(globalConfigPath);
  if (globalCfg) {
    applyConfigLayer(merged, globalCfg);
    sources.push(globalConfigPath);
  }

  if (!opts.disableProjectConfigs) {
    const leaf = opts.cwd
      || (Array.isArray(opts.workspaceRoots) && opts.workspaceRoots[0])
      || '';
    for (const dir of dirsGitRootToLeaf(leaf)) {
      const projPath = path.join(dir, '.cursor', 'cli.json');
      const projCfg = readJsonFile(projPath);
      if (projCfg) {
        applyConfigLayer(merged, projCfg);
        sources.push(projPath);
      }
    }
  }

  merged.sources = sources;
  return merged;
}

// ---------------------------------------------------------------------------
// Remote (SSH) config loading
// ---------------------------------------------------------------------------

/** Minimal POSIX single-quote shell escaper (fallback when no shellQuote is injected). */
function defaultShellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a single remote shell command that prints the merged-config inputs with markers:
 * the global `~/.cursor/cli-config.json`, then each candidate dir's `.cursor/cli.json` in
 * shallow→deep order. One round trip; parsed by parseRemoteConfigOutput. Unlike the local
 * loader this does not walk every intermediate dir between git-root and cwd — it reads the
 * workspace roots then cwd (where project configs realistically live); a deeply-nested
 * intermediate `.cursor/cli.json` would be missed (documented parity gap).
 */
function buildRemoteConfigReadCommand(dirs, shellQuote) {
  const q = typeof shellQuote === 'function' ? shellQuote : defaultShellQuote;
  const parts = [
    `printf '===ORCHCFG:global===\\n'`,
    `cat "$HOME/.cursor/cli-config.json" 2>/dev/null`,
    `printf '\\n'`,
  ];
  for (const d of Array.isArray(dirs) ? dirs : []) {
    if (!d) continue;
    const f = `${q(d)}/.cursor/cli.json`;
    parts.push(
      `f=${f}`,
      `if [ -f "$f" ]; then printf '===ORCHCFG:proj===\\n'; cat "$f"; printf '\\n'; fi`
    );
  }
  return parts.join('; ');
}

/** Parse the marker-delimited remote output into a merged config (deeper/later wins). */
function parseRemoteConfigOutput(stdout) {
  const merged = emptyMergedConfig();
  const blocks = String(stdout || '').split('===ORCHCFG:');
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    if (nl === -1) continue; // marker header line without a body
    const body = block.slice(nl + 1).trim();
    if (!body) continue;
    let cfg = null;
    try {
      cfg = JSON.parse(body);
    } catch {
      cfg = null;
    }
    if (cfg) applyConfigLayer(merged, cfg);
  }
  return merged;
}

/**
 * Read + merge a REMOTE machine's cursor-cli permission config over SSH. Mirrors
 * loadCursorCliConfig but for `source:'ssh'` runs, where the config lives on the remote host
 * (the hook's workspace_roots/cwd are remote paths the local fs cannot see). Returns the same
 * `{allow, deny, approvalMode, sources}` shape. Async (one SSH round trip); the live server
 * caches the result and refreshes in the background so the tracker's resolveConfig stays sync.
 *
 * @param {object} opts
 * @param {string} opts.host                ssh host (alias or user@host)
 * @param {string[]} [opts.workspaceRoots]  remote workspace roots from the hook body
 * @param {string} [opts.cwd]               remote cwd from the hook body
 * @param {function} opts.runSsh            (host, cmd, timeoutMs) => Promise<stdout>
 * @param {function} [opts.shellQuote]
 * @param {number} [opts.timeoutMs]
 */
async function loadCursorCliConfigRemote(opts = {}) {
  const host = opts.host;
  const runSsh = opts.runSsh;
  if (!host || typeof runSsh !== 'function') return emptyMergedConfig();
  const roots = Array.isArray(opts.workspaceRoots) ? opts.workspaceRoots.filter(Boolean) : [];
  const dirs = [];
  for (const r of roots) if (!dirs.includes(r)) dirs.push(r);
  if (opts.cwd && !dirs.includes(opts.cwd)) dirs.push(opts.cwd);
  const cmd = buildRemoteConfigReadCommand(dirs, opts.shellQuote);
  let stdout = '';
  try {
    stdout = await runSsh(host, cmd, opts.timeoutMs);
  } catch {
    return emptyMergedConfig();
  }
  const merged = parseRemoteConfigOutput(stdout);
  merged.sources = [`ssh:${host}`];
  return merged;
}

function isRunEverythingMode(approvalMode) {
  const m = String(approvalMode || '').trim().toLowerCase();
  if (!m) return false;
  return RUN_EVERYTHING_MODES.has(m);
}

// ---------------------------------------------------------------------------
// Permission evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate one tool call against a merged config. Decision flow per cursor's model:
 *   deny match → 'deny'  (blocked; the agent continues — NOT a needs-input gate)
 *   else Run Everything (forceMode || approvalMode) → 'auto'
 *   else allow match → 'auto'
 *   else → 'prompt'      (the gate — arm permission_pending)
 *
 * @param {object} body  a hook body (preToolUse / beforeShellExecution / …)
 * @param {object} config merged config from loadCursorCliConfig
 * @param {object} [opts]
 * @param {boolean} [opts.forceMode]  the session --force/--yolo flag (invisible in hooks)
 * @param {string[]} [opts.gateableCategories]
 * @returns {{decision:'prompt'|'auto'|'deny', category:string|null, reason:string, detail:string}}
 */
function evaluatePermission(body, config, opts = {}) {
  const call = extractToolCall(body);
  return evaluateToolCall(call, config, opts);
}

function evaluateToolCall(call, config, opts = {}) {
  const gateable = new Set(
    Array.isArray(opts.gateableCategories) && opts.gateableCategories.length
      ? opts.gateableCategories
      : GATEABLE_CATEGORIES
  );
  if (!call || !call.category || !gateable.has(call.category)) {
    return { decision: 'auto', category: call ? call.category : null, reason: 'non-gateable', detail: '' };
  }

  const cfg = config && typeof config === 'object' ? config : emptyMergedConfig();
  const denyTokens = tokensForCategory(cfg.deny, call.category);
  const allowTokens = tokensForCategory(cfg.allow, call.category);
  const runEverything = !!opts.forceMode || isRunEverythingMode(cfg.approvalMode);

  if (call.category === 'Shell') {
    const segments = shellSegments(call.command);
    if (!segments.length) {
      // Empty command — nothing to gate.
      return { decision: 'auto', category: 'Shell', reason: 'empty-command', detail: call.detail };
    }
    if (segments.some((seg) => denyTokens.some((t) => shellTokenMatchesSegment(t, seg)))) {
      return { decision: 'deny', category: 'Shell', reason: 'deny-match', detail: call.detail };
    }
    if (runEverything) {
      return { decision: 'auto', category: 'Shell', reason: 'run-everything', detail: call.detail };
    }
    const everySegmentAllowed = segments.every((seg) =>
      allowTokens.some((t) => shellTokenMatchesSegment(t, seg))
    );
    if (everySegmentAllowed) {
      return { decision: 'auto', category: 'Shell', reason: 'allow-match', detail: call.detail };
    }
    return { decision: 'prompt', category: 'Shell', reason: 'no-allow-match', detail: call.detail };
  }

  // Single-subject categories: Read / Write / WebFetch / Mcp.
  const subjectMatches = (tokenArg) => {
    if (call.category === 'Read' || call.category === 'Write') {
      return pathTokenMatches(tokenArg, call.file_path, call.workspace_roots, opts.homeDir || os.homedir());
    }
    if (call.category === 'WebFetch') return matchGlob(tokenArg, call.domain, false);
    if (call.category === 'Mcp') return mcpTokenMatches(tokenArg, call.mcp_server, call.mcp_tool);
    return false;
  };

  if (denyTokens.some(subjectMatches)) {
    return { decision: 'deny', category: call.category, reason: 'deny-match', detail: call.detail };
  }
  if (runEverything) {
    return { decision: 'auto', category: call.category, reason: 'run-everything', detail: call.detail };
  }
  if (allowTokens.some(subjectMatches)) {
    return { decision: 'auto', category: call.category, reason: 'allow-match', detail: call.detail };
  }
  return { decision: 'prompt', category: call.category, reason: 'no-allow-match', detail: call.detail };
}

/** `Mcp(server:tool)` — server/tool each generic-glob-matched; missing half defaults to `*`. */
function mcpTokenMatches(tokenArg, server, tool) {
  const colon = String(tokenArg).indexOf(':');
  const serverPat = colon === -1 ? tokenArg : tokenArg.slice(0, colon);
  const toolPat = colon === -1 ? '*' : tokenArg.slice(colon + 1);
  return matchGlob(serverPat, String(server || ''), false) && matchGlob(toolPat, String(tool || ''), false);
}

// ---------------------------------------------------------------------------
// Arm / resume tracker
// ---------------------------------------------------------------------------

// Default grace window before an armed gate becomes *visible* needs-input. Tools that
// auto-run (forced or allowed) resolve within this window and never surface — eliminating
// flicker. A genuine gate (waiting on a human) stays unresolved well past it and surfaces.
const DEFAULT_GRACE_MS = 2000;

/**
 * In-memory permission tracker keyed by conversation_id. Arms `permission_pending` when a
 * `preToolUse` evaluates to 'prompt'; resumes (clears) on the matching after-hook, a later
 * tool call, or a terminal stop — the same arm/resume loop-guard used for Codex/Gemini.
 *
 * Two refinements make it flicker-free without a force signal (cursor exposes none — see the
 * feasibility doc):
 *  1. **Debounce / record-vs-surface split.** Arming records the gate internally immediately,
 *     but it only becomes *visible* (`getVisiblePending`) after `graceMs`. A tool that
 *     auto-runs resolves inside the window → never visible → no flicker. `armed` is for
 *     analytics/recording; `visible` is what the live watch surfaces.
 *  2. **Per-session force latch.** The first time an armed gate auto-resolves *within* the
 *     grace window (it ran without waiting on a human), we infer the session is Run-Everything
 *     (`--force`/`--yolo`, which is invisible in hooks) and latch `force_inferred` for that
 *     conversation — suppressing all further arming. So worst case is one sub-grace,
 *     never-surfaced blip at session start, then nothing.
 *
 * Irreducible residual (documented, accepted): a session Orchestra did NOT launch + hidden
 * `--force` + the session's *first* gateable tool is long-running → it stays armed past the
 * grace window with no fast auto-resolve to latch on, so it surfaces once for the tool's
 * runtime. Identical hook sequence to a real gate; not separable without the TUI capture log.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]    a single merged config (static), used when no resolver given
 * @param {function} [opts.resolveConfig]  (body) => merged config (per-workspace)
 * @param {boolean} [opts.forceMode]  known launch flag (only when Orchestra launched the run)
 * @param {string[]} [opts.gateableCategories]
 * @param {number} [opts.graceMs]
 */
function createCursorCliPermissionTracker(opts = {}) {
  /** @type {Map<string, object>} */
  const byConversation = new Map();
  const graceMs = Number.isFinite(opts.graceMs) && opts.graceMs >= 0 ? opts.graceMs : DEFAULT_GRACE_MS;
  // Drop idle conversations so a long-lived server doesn't accumulate state forever (mirrors
  // the cursor/gemini hook stores). A still-pending gate is kept far longer than a resolved
  // one — a human can sit on a gate for a while.
  const ttlMs = Number.isInteger(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 30 * 60 * 1000;

  function prune(nowMs) {
    for (const [key, state] of byConversation.entries()) {
      const idleFor = nowMs - (state.last_activity_ms || 0);
      const keepFor = state.permission_pending ? Math.max(ttlMs, 2 * 60 * 60 * 1000) : ttlMs;
      if (idleFor > keepFor) byConversation.delete(key);
    }
  }

  function configFor(body) {
    if (typeof opts.resolveConfig === 'function') return opts.resolveConfig(body);
    return opts.config || emptyMergedConfig();
  }

  function blankState(conversationId) {
    return {
      conversation_id: conversationId,
      permission_pending: false,
      pending_tool_use_id: '',
      pending_category: '',
      pending_detail: '',
      pending_command: '',
      pending_file_path: '',
      pending_domain: '',
      pending_mcp_server: '',
      pending_mcp_tool: '',
      armed_at_ms: 0,
      resolved_at_ms: 0,
      resolve_reason: '',
      // Per-session Run-Everything inference (latched when a gate auto-resolves fast).
      force_inferred: false,
      force_inferred_at_ms: 0,
      last_activity_ms: 0,
    };
  }

  function getState(conversationId) {
    const key = String(conversationId || '').trim().toLowerCase();
    return byConversation.get(key) || null;
  }

  /**
   * The currently *visible* (surfaced) needs-input state for a conversation, or null. A gate
   * is visible only once it has been armed for at least `graceMs` (debounce). Resolved or
   * force-latched gates are never visible.
   */
  function getVisiblePending(conversationId, nowMs = Date.now()) {
    const state = getState(conversationId);
    if (!state || !state.permission_pending) return null;
    if (nowMs - state.armed_at_ms < graceMs) return null;
    return state;
  }

  function isPending(conversationId) {
    const state = getState(conversationId);
    return !!(state && state.permission_pending);
  }

  function clearPending(state, nowMs, reason) {
    if (!state.permission_pending) return;
    state.permission_pending = false;
    state.resolved_at_ms = nowMs;
    state.resolve_reason = reason;
    state.pending_tool_use_id = '';
    state.pending_category = '';
    state.pending_detail = '';
    state.pending_command = '';
    state.pending_file_path = '';
    state.pending_domain = '';
    state.pending_mcp_server = '';
    state.pending_mcp_tool = '';
  }

  function samePendingTool(call, state) {
    if (call.tool_use_id && state.pending_tool_use_id) return call.tool_use_id === state.pending_tool_use_id;
    if (!call.category || call.category !== state.pending_category) return false;
    if (call.category === 'Shell') return !!call.command && call.command === state.pending_command;
    if (call.category === 'Read' || call.category === 'Write') {
      return !!call.file_path && call.file_path === state.pending_file_path;
    }
    if (call.category === 'WebFetch') return !!call.domain && call.domain === state.pending_domain;
    if (call.category === 'Mcp') {
      return !!call.mcp_server
        && !!call.mcp_tool
        && call.mcp_server === state.pending_mcp_server
        && call.mcp_tool === state.pending_mcp_tool;
    }
    return false;
  }

  function gatePriority(category) {
    if (category === 'Shell') return 50;
    if (category === 'Write') return 40;
    if (category === 'Mcp') return 30;
    if (category === 'WebFetch') return 20;
    if (category === 'Read') return 10;
    return 0;
  }

  function armPending(state, call, decision, nowMs) {
    state.permission_pending = true;
    state.pending_tool_use_id = call.tool_use_id;
    state.pending_category = decision.category;
    state.pending_detail = decision.detail;
    state.pending_command = call.command;
    state.pending_file_path = call.file_path;
    state.pending_domain = call.domain;
    state.pending_mcp_server = call.mcp_server;
    state.pending_mcp_tool = call.mcp_tool;
    state.armed_at_ms = nowMs;
    state.resolved_at_ms = 0;
    state.resolve_reason = '';
  }

  /**
   * Ingest one hook body. Returns { state, episode } where `episode` is a completed gate
   * episode if this event resolved a pending one, else null.
   */
  function ingest(body, ingestOpts = {}) {
    const nowMs = Number.isFinite(ingestOpts.nowMs) ? ingestOpts.nowMs : Date.now();
    const call = extractToolCall(body);
    if (!call || !call.conversation_id) return { state: null, episode: null };

    const key = call.conversation_id;
    const state = byConversation.get(key) || blankState(key);
    byConversation.set(key, state);
    state.last_activity_ms = nowMs;
    prune(nowMs);

    let episode = null;

    if (call.is_arm_candidate) {
      // Force latched → the session auto-runs everything; never arm (no flicker, no episode).
      if (state.force_inferred) return { state, episode };
      const decision = evaluateToolCall(call, configFor(body), {
        forceMode: opts.forceMode,
        gateableCategories: opts.gateableCategories,
        homeDir: opts.homeDir,
      });

      if (state.permission_pending) {
        const pendingAgeMs = nowMs - state.armed_at_ms;
        if (pendingAgeMs < graceMs) {
          // Cursor can issue parallel tool calls while a Shell gate is still waiting. During
          // the debounce window, keep the higher-confidence gate instead of treating the new
          // preToolUse as proof that the old gate resolved.
          if (
            decision.decision === 'prompt'
            && gatePriority(decision.category) > gatePriority(state.pending_category)
          ) {
            episode = completeEpisode(state, nowMs, 'superseded');
            clearPending(state, nowMs, 'superseded');
            armPending(state, call, decision, nowMs);
          }
          return { state, episode };
        }

        // Once a pending gate has been visible, a later preToolUse is a resume fallback. It
        // never latches force; only matching same-tool completion can do that.
        episode = completeEpisode(state, nowMs, 'next-tool');
        clearPending(state, nowMs, 'next-tool');
      }

      if (decision.decision === 'prompt') {
        armPending(state, call, decision, nowMs);
      }
      return { state, episode };
    }

    if (call.is_resolve && state.permission_pending) {
      const isTerminal = call.event_name === 'stop' || call.event_name === 'sessionEnd';
      // postToolUse/postToolUseFailure for the same tool_use_id is the precise resume. Tool-
      // specific after-hooks are fallbacks only when their payload matches the pending tool.
      // Generic agent hooks are intentionally not resolve events.
      const sameTool = samePendingTool(call, state);
      if (!isTerminal && !sameTool) return { state, episode };
      const reason = isTerminal ? 'stop' : `after:${call.event_name}`;
      episode = completeEpisode(state, nowMs, reason);
      maybeLatchForce(state, episode, nowMs);
      clearPending(state, nowMs, reason);
    }

    return { state, episode };
  }

  // Infer Run-Everything when an armed Shell gate auto-resolved within the grace window via
  // the same tool's successful completion. Latched per conversation for the session. next-
  // tool clears, non-Shell tools, and tool failures are excluded: they are not reliable
  // evidence of auto-approval.
  function maybeLatchForce(state, episode, nowMs) {
    if (!episode || state.force_inferred) return;
    const viaSameToolResolve =
      episode.category === 'Shell'
      && (episode.resolve_reason === 'after:postToolUse'
        || episode.resolve_reason === 'after:afterShellExecution');
    if (viaSameToolResolve && episode.duration_ms < graceMs) {
      state.force_inferred = true;
      state.force_inferred_at_ms = nowMs;
    }
  }

  function completeEpisode(state, nowMs, reason) {
    if (!state.permission_pending) return null;
    const durationMs = nowMs - state.armed_at_ms;
    return {
      conversation_id: state.conversation_id,
      category: state.pending_category,
      detail: state.pending_detail,
      tool_use_id: state.pending_tool_use_id,
      armed_at_ms: state.armed_at_ms,
      resolved_at_ms: nowMs,
      resolve_reason: reason,
      duration_ms: durationMs,
      // Resolved fast via a tool resolve → it auto-ran (forced/allowed), never surfaced.
      auto_inferred: durationMs < graceMs && (reason === 'next-tool' || reason.startsWith('after:')),
      // Whether it was on screen long enough to have been surfaced as needs-input.
      surfaced: durationMs >= graceMs,
    };
  }

  return {
    ingest,
    getState,
    getVisiblePending,
    isPending,
    graceMs,
    list: () => [...byConversation.values()],
  };
}

// ---------------------------------------------------------------------------
// Offline analysis (for the session recorder / replay comparison)
// ---------------------------------------------------------------------------

/**
 * Replay a list of timestamped hook bodies through the tracker and return the predicted
 * permission gate episodes (plus any still-pending at the end). Used by the cursor-cli
 * session recorder to compare config-eval predictions against the capture-log ground truth.
 *
 * @param {Array<{body:object, t_ms:number}>} hookEvents
 * @param {object} [opts]  forwarded to createCursorCliPermissionTracker
 * @returns {{episodes:Array, pending:Array}}
 */
function analyzeHookEvents(hookEvents, opts = {}) {
  const tracker = createCursorCliPermissionTracker(opts);
  const episodes = [];
  let lastMs = 0;
  for (const ev of Array.isArray(hookEvents) ? hookEvents : []) {
    if (!ev || typeof ev !== 'object') continue;
    const body = ev.body || ev;
    const nowMs = Number.isFinite(ev.t_ms) ? ev.t_ms : Number.isFinite(body.t_ms) ? body.t_ms : Date.now();
    lastMs = Math.max(lastMs, nowMs);
    const { episode } = tracker.ingest(body, { nowMs });
    if (episode) episodes.push(episode);
  }
  const pending = tracker
    .list()
    .filter((s) => s.permission_pending)
    .map((s) => ({
      conversation_id: s.conversation_id,
      category: s.pending_category,
      detail: s.pending_detail,
      tool_use_id: s.pending_tool_use_id,
      armed_at_ms: s.armed_at_ms,
      resolved_at_ms: 0,
      resolve_reason: 'still-pending',
      // Was this gate on screen long enough to be surfaced by the end of the stream?
      visible: lastMs - s.armed_at_ms >= tracker.graceMs,
    }));
  const forceInferred = tracker.list().some((s) => s.force_inferred);
  // The gates a user would actually have seen: surfaced episodes + still-visible pendings.
  const visibleCount = episodes.filter((e) => e.surfaced).length + pending.filter((p) => p.visible).length;
  return { episodes, pending, force_inferred: forceInferred, visible_count: visibleCount };
}

module.exports = {
  GATEABLE_CATEGORIES,
  DEFAULT_GRACE_MS,
  // glob / token primitives
  globToRegExp,
  matchGlob,
  parseToken,
  shellSegments,
  shellTokenMatchesSegment,
  pathTokenMatches,
  mcpTokenMatches,
  // extraction + config
  extractToolCall,
  isCursorCliHook,
  cursorSurfaceFromVersion,
  loadCursorCliConfig,
  loadCursorCliConfigRemote,
  buildRemoteConfigReadCommand,
  parseRemoteConfigOutput,
  isRunEverythingMode,
  // evaluation + tracking
  evaluatePermission,
  evaluateToolCall,
  createCursorCliPermissionTracker,
  analyzeHookEvents,
};
