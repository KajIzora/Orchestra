'use strict';

/*
 * cursor_cli_permission_probe.js — LIVE (production) cursor-CLI permission gate detection from the
 * chat store.db, for BOTH the parent and its Task sub-agents.
 *
 * WHY THIS EXISTS. The older production path (cursor_cli_permission.js config-eval on preToolUse
 * hooks, wired via getCursorPermissionPendingHint) has two structural holes:
 *   1. preToolUse fires UNRELIABLY in interactive cursor-agent sessions — when it doesn't fire the
 *      gate is never armed and the live watch never flips to needs_input.
 *   2. A Task sub-agent's inner tool calls fire NO hooks at all, so config-eval is blind to them.
 * The chat store.db has neither hole: the conversation HEAD blob records the pending gateable tool
 * call the instant the gate renders (providerOptions.cursor.pendingToolCallStartedAtMs), independent
 * of hooks, and each sub-agent has its own sibling store.db. This probe reads those heads, config-
 * evals the pending tool call (reusing the SAME evaluator as the hook path, so no second policy to
 * drift), and emits parent-attributed `permission_requested` / `permission_cleared` events — the
 * SAME event shape the renderer/composerHeaders probes emit, so they ride through the shared
 * applyCursorRendererPermissionEvents. This makes production match the signal-replay grading exactly
 * (the replay drives applyCursorRendererPermissionEvents off the store.db too).
 *
 * SHAPE. Mirrors createComposerHeadersGateProbe: init()/pollOnce(watches, wrap)/getState(), plus
 * isPermissionPendingForWatch(tracking) so shouldResumeCursorWatch holds the pause while the gate is
 * still on the store.db head. All file/db I/O is injected (deps) so the diff logic is unit-testable
 * without a real store.db.
 *
 * LOCAL vs SSH. One probe instance owns ONE watch source (opts.watchSource, default 'local'):
 * `--source ssh` runs the agent (and its store.db, and each sub-agent's sibling store.db) on the
 * remote host, so server.js runs a SECOND instance with watchSource:'ssh' whose injected deps read
 * the remote heads through createSshCursorCliHeadGateReader below — a background-refreshed cache
 * over the remoteChatDbHeadHexes transport (the same store.db-over-ssh path the question reader
 * uses). The reader's read() is synchronous-from-cache with a COLD MISS = [] (never a false gate);
 * the edge/scope logic in this probe is identical local vs remote.
 *
 * SCOPE KEYS. A "scope" is one store.db that can be parked at a gate: the parent (key = conversation
 * id) or a sub-agent (key = `${conversationId}::${subagentId}`). Every scope, parent or child, is
 * ATTRIBUTED to the parent conversation on its emitted events, so the parent watch is the one that
 * flips to needs_input — exactly what the user is watching.
 */

const {
  subagentStoreDbPath,
  readHeadPendingGates,
  storeDbFingerprint,
  pendingGatesFromBlobJson,
} = require('./cursor_cli_subagent_gate');
const { extractJsonObjectsFromBuffer, remoteChatDbHeadHexes } = require('./cursor_chat_db');

function firstDetail(gates) {
  for (const g of gates) if (g && g.detail) return g.detail;
  return (gates[0] && gates[0].category) || 'permission';
}

function createCursorCliStoreDbPermissionProbe(opts = {}) {
  const nowIso = typeof opts.nowIso === 'function' ? opts.nowIso : () => new Date().toISOString();
  // Injectable I/O (real implementations wired in server.js; fakes in tests):
  //   findStoreDbPath(conversationId) -> absolute store.db path | ''
  //   resolveConfig(watch) -> cursor-cli permission config object
  //   listSubagentIds(watch, parentStoreDbPath) -> string[]  (Task sub-agent ids for this watch)
  //   readHead(storeDbPath, config) -> pending-gate[]  (head-only; [] when not parked)
  //   fingerprint(storeDbPath) -> string  (cheap change-detector; re-read only on change)
  const findStoreDbPath = opts.findStoreDbPath || (() => '');
  const resolveConfig = opts.resolveConfig || (() => ({}));
  const listSubagentIds = opts.listSubagentIds || (() => []);
  const readHead = typeof opts.readHead === 'function'
    ? opts.readHead
    : (storeDbPath, config) => readHeadPendingGates(storeDbPath, config);
  const fingerprint = typeof opts.fingerprint === 'function' ? opts.fingerprint : storeDbFingerprint;
  // Which watches this instance owns: 'local' (default) skips ssh watches; 'ssh' skips local ones.
  const watchSource = opts.watchSource === 'ssh' ? 'ssh' : 'local';
  // Sub-agent store.db locator — injectable so the ssh instance can mint remote read tokens
  // (`ssh\0host\0subId`) instead of local filesystem paths.
  const resolveSubagentStoreDbPath =
    typeof opts.subagentStoreDbPath === 'function' ? opts.subagentStoreDbPath : subagentStoreDbPath;
  // Read at most once per interval per store.db (store.db writes can be bursty). 0 = every poll.
  const minReadIntervalMs = Number.isFinite(opts.minReadIntervalMs) ? opts.minReadIntervalMs : 0;
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : () => Date.now();

  // scopeKey -> { conversationId, subagent, subagentId, detail } for gates currently observed pending.
  const pendingByScope = new Map();
  // storeDbPath -> { fp, gates, atMs } cache so an unchanged store.db is not re-copied/parsed.
  const readCache = new Map();

  function readHeadCached(storeDbPath, config) {
    if (!storeDbPath) return [];
    const cached = readCache.get(storeDbPath);
    const t = nowMs();
    if (cached && minReadIntervalMs > 0 && (t - cached.atMs) < minReadIntervalMs) return cached.gates;
    let fp = '';
    try { fp = fingerprint(storeDbPath); } catch { fp = ''; }
    if (cached && fp && fp === cached.fp) { cached.atMs = t; return cached.gates; }
    let gates = [];
    try { gates = readHead(storeDbPath, config) || []; } catch { gates = []; }
    readCache.set(storeDbPath, { fp, gates, atMs: t });
    return gates;
  }

  // Compute the set of scopes currently parked at a gate across one watch (parent + sub-agents).
  function scopesForWatch(watch) {
    const conversationId = (watch && (watch.conversation_id || watch.conversationId)) || '';
    if (!conversationId) return [];
    const parentStoreDbPath = findStoreDbPath(conversationId);
    if (!parentStoreDbPath) return []; // no chats/ store.db → not a local cursor-CLI conversation
    let config = {};
    try { config = resolveConfig(watch) || {}; } catch { config = {}; }
    const scopes = [];
    const parentGates = readHeadCached(parentStoreDbPath, config);
    if (parentGates.length) {
      scopes.push({ key: conversationId, conversationId, subagent: false, subagentId: '', detail: firstDetail(parentGates) });
    }
    let subIds = [];
    try { subIds = listSubagentIds(watch, parentStoreDbPath) || []; } catch { subIds = []; }
    for (const subId of subIds) {
      if (!subId) continue;
      const childPath = resolveSubagentStoreDbPath(subId, { parentStoreDbPath });
      if (!childPath) continue;
      const childGates = readHeadCached(childPath, config);
      if (childGates.length) {
        scopes.push({
          key: `${conversationId}::${subId}`,
          conversationId,
          subagent: true,
          subagentId: subId,
          detail: firstDetail(childGates),
        });
      }
    }
    return scopes;
  }

  async function init() {
    // Nothing to seed at startup: with no active watches there are no store.dbs to read. Pending
    // state is built entirely from pollOnce transitions.
    pendingByScope.clear();
    readCache.clear();
    return { cursor_cli_store_db_permission_probe: true };
  }

  // watches: array of local cursor watch tracking objects. Returns permission_requested/_cleared
  // events (also passed to `wrap` one-by-one, mirroring the other probes).
  async function pollOnce(watches, wrap) {
    const events = [];
    const list = Array.isArray(watches) ? watches : [];
    // Current pending scope set across every polled watch.
    const currentByKey = new Map();
    const watchedConvIds = new Set();
    for (const watch of list) {
      if (!watch) continue;
      // One instance per source: the local probe skips ssh watches (remote store.db — owned by the
      // ssh instance) and vice versa.
      const src = watch.source === 'ssh' ? 'ssh' : 'local';
      if (src !== watchSource) continue;
      const conversationId = watch.conversation_id || watch.conversationId || '';
      if (conversationId) watchedConvIds.add(conversationId);
      for (const scope of scopesForWatch(watch)) currentByKey.set(scope.key, scope);
    }
    // Rising edges: a scope now parked that wasn't before.
    for (const [key, scope] of currentByKey) {
      if (pendingByScope.has(key)) continue;
      pendingByScope.set(key, scope);
      const event = {
        type: 'permission_requested',
        conversation_id: scope.conversationId,
        composer_id: scope.conversationId,
        subagent: scope.subagent,
        subagent_id: scope.subagentId || undefined,
        gate_type: 'permission',
        source: 'store_db',
        detail: scope.detail,
        t_iso: nowIso(),
      };
      events.push(event);
      if (typeof wrap === 'function') wrap(event);
    }
    // Falling edges: a scope previously parked that cleared. Only reconcile scopes whose parent
    // conversation was actually polled this tick — a watch that finished/was removed must NOT have
    // its last pending scope interpreted as an approval (leave it; it ages out when the watch is
    // re-polled, or is irrelevant once the task is done).
    for (const [key, scope] of [...pendingByScope.entries()]) {
      if (currentByKey.has(key)) continue;
      if (!watchedConvIds.has(scope.conversationId)) continue;
      pendingByScope.delete(key);
      const event = {
        type: 'permission_cleared',
        conversation_id: scope.conversationId,
        composer_id: scope.conversationId,
        subagent: scope.subagent,
        subagent_id: scope.subagentId || undefined,
        gate_type: 'permission',
        source: 'store_db',
        // The head moved off the pending tool call → the gate was answered (the tool ran). Use the
        // canonical 'approved' reason so the shared resume path fires, same as the other probes.
        clear_reason: 'approved',
        cleared_via: 'store_db_head_advanced',
        t_iso: nowIso(),
      };
      events.push(event);
      if (typeof wrap === 'function') wrap(event);
    }
    return events;
  }

  // Resume guard: hold the pause while ANY scope of this watch's conversation is still parked.
  function isPermissionPendingForWatch(tracking) {
    const conv = (tracking && (tracking.conversation_id || tracking.conversationId)) || '';
    if (!conv) return false;
    for (const scope of pendingByScope.values()) if (scope.conversationId === conv) return true;
    return false;
  }

  function getState() {
    return {
      cursor_cli_store_db_pending_count: pendingByScope.size,
      cursor_cli_store_db_pending: [...pendingByScope.values()].map((s) => ({
        conversation_id: s.conversationId,
        subagent: s.subagent,
        subagent_id: s.subagentId,
      })),
    };
  }

  return { init, pollOnce, getState, isPermissionPendingForWatch, _scopesForWatch: scopesForWatch };
}

/*
 * createSshCursorCliHeadGateReader — the remote (`--source ssh`) analogue of readHeadPendingGates,
 * shaped for the probe's synchronous readHead dep. The remote conversation head is fetched over
 * ssh via remoteChatDbHeadHexes (the SAME snapshot-copy transport remotePendingAskQuestion uses —
 * copy store.db(+wal+shm) to a remote temp, read the copy read-only, return the head blob hex) and
 * decoded LOCALLY with the same pendingGatesFromBlobJson + config-eval the local path uses, so the
 * gate decision is identical local vs remote.
 *
 *   read(host, conv, config) — SYNCHRONOUS: returns the last successfully-decoded gates and
 *     schedules a background refresh when the entry is stale (ttlMs, ~2-3s). A COLD MISS returns
 *     [] — never a false gate. A transport failure keeps the previous entry (a gate that was
 *     pending stays pending — holding on stale data is safe; the probe's falling edge only fires
 *     off a successful head advance).
 *   isWarm(host, conv) — a successful remote read landed within warmMaxAgeMs. server.js uses this
 *     to decide store.db-probe OWNERSHIP for ssh watches (mirroring the local
 *     localCursorCliStoreDbPath check): while warm, the config-eval hook tracker's hint/resume
 *     guard is suppressed; if ssh dies the ownership decays and the config-eval fallback returns.
 */
function createSshCursorCliHeadGateReader(opts = {}) {
  const runSsh = opts.runSsh;
  const fetchHeadHexes = typeof opts.fetchHeadHexes === 'function'
    ? opts.fetchHeadHexes
    : ({ host, conversationIds, timeoutMs: t }) =>
        remoteChatDbHeadHexes({ host, conversationIds, runSsh, timeoutMs: t });
  const decodeGates = typeof opts.decodeGates === 'function'
    ? opts.decodeGates
    : (hex, config) =>
        pendingGatesFromBlobJson(extractJsonObjectsFromBuffer(Buffer.from(String(hex), 'hex')), config);
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 2500;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000;
  const warmMaxAgeMs = Number.isFinite(opts.warmMaxAgeMs) ? opts.warmMaxAgeMs : 30000;
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : () => Date.now();

  const cache = new Map(); // host\0conv -> { gates, okAtMs }
  const lastAttemptMs = new Map(); // host\0conv -> ms (throttles retries after failures too)
  const inFlight = new Set();

  function scheduleRefresh(key, host, conv, config) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    lastAttemptMs.set(key, nowMs());
    Promise.resolve()
      .then(() => fetchHeadHexes({ host, conversationIds: [conv], timeoutMs }))
      .then((res) => {
        if (!res || !res.heads) return; // transport failure — keep the previous entry
        const hex = String(res.heads[conv] || '');
        let gates = [];
        if (hex) {
          try { gates = decodeGates(hex, config) || []; } catch { gates = []; }
        }
        cache.set(key, { gates, okAtMs: nowMs() });
      })
      .catch(() => { /* keep the previous entry */ })
      .finally(() => {
        inFlight.delete(key);
      });
  }

  function read(host, conv, config) {
    const h = String(host || '').trim();
    const c = String(conv || '').trim();
    if (!h || !c) return [];
    const key = `${h}\0${c}`;
    const attempted = lastAttemptMs.get(key);
    // Never-attempted always schedules; afterwards the TTL throttles refreshes AND failure retries.
    if (attempted === undefined || nowMs() - attempted >= ttlMs) scheduleRefresh(key, h, c, config || {});
    const entry = cache.get(key);
    return entry ? entry.gates : [];
  }

  function isWarm(host, conv) {
    const entry = cache.get(`${String(host || '').trim()}\0${String(conv || '').trim()}`);
    return !!(entry && entry.okAtMs && nowMs() - entry.okAtMs < warmMaxAgeMs);
  }

  return { read, isWarm, _cache: cache };
}

module.exports = { createCursorCliStoreDbPermissionProbe, createSshCursorCliHeadGateReader };
