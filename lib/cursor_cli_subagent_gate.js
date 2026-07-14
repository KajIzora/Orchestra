'use strict';

/*
 * cursor_cli_subagent_gate.js — derive a cursor-cli SUB-AGENT permission gate from the child store.db.
 *
 * A Task sub-agent's inner tool calls fire NO hooks (cursor-agent only hooks the parent's direct
 * tools), so the config-eval-on-hooks derivation in cursor_cli_permission.js is blind to them. But the
 * sub agent has its OWN chat store.db — a sibling of the parent's, named by the subagent_id
 * (`~/.cursor/chats/<projecthash>/<subagent_id>/store.db`) — and while it is blocked awaiting approval,
 * the pending gateable tool call is recorded there as
 *   providerOptions.cursor.pendingToolCallStartedAtMs  +  a `tool-call` content block
 * i.e. the SAME real-time pending marker the question path uses (blobHasPendingAskQuestion), just on a
 * gateable toolName (Shell/Write/Read/WebFetch/Mcp) instead of AskQuestion.
 *
 * This module: (1) maps that store.db tool-call to a synthetic preToolUse body so it can reuse the
 * canonical extractToolCall + evaluateToolCall (no second evaluator to drift), (2) keeps only calls the
 * config would PROMPT on (an allowlisted call is not a gate), and (3) locates + reads the child
 * store.db. The caller attributes the resulting gate to the PARENT watch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractJsonObjectsFromBuffer } = require('./sqlite_delta_probe');
const { extractToolCall, evaluateToolCall } = require('./cursor_cli_permission');

const CURSOR_CHATS_ROOT = path.join(os.homedir(), '.cursor', 'chats');

// A store.db `tool-call` content block → a synthetic `preToolUse` hook body, so the canonical
// extractToolCall (which reads tool_name + tool_input.command/path/url) turns it into the same call
// shape evaluateToolCall expects. Store.db arg field names (observed): Shell→command, Read/Write→path.
function toolCallBlockToHookBody(block, { conversationId = '', workspaceRoots = [], cwd = '' } = {}) {
  const args = (block && (block.args || block.input || block.arguments)) || {};
  const toolInput = {};
  if (args.command != null) toolInput.command = args.command;
  if (args.path != null) { toolInput.path = args.path; toolInput.file_path = args.path; }
  if (args.file_path != null) toolInput.file_path = args.file_path;
  if (args.url != null) toolInput.url = args.url;
  if (args.domain != null) toolInput.domain = args.domain;
  if (args.server != null) toolInput.server = args.server;
  if (args.tool != null) toolInput.tool = args.tool;
  return {
    hook_event_name: 'preToolUse',
    tool_name: block && block.toolName,
    tool_input: toolInput,
    tool_call_id: (block && block.toolCallId) || '',
    conversation_id: conversationId,
    workspace_roots: Array.isArray(workspaceRoots) ? workspaceRoots : [],
    cwd: cwd || '',
  };
}

/**
 * Pure (no I/O): given the decoded JSON objects of ONE store.db blob and the permission config,
 * return the pending gateable tool-calls that would PROMPT — i.e. active sub-agent permission gates.
 * @returns {{tool_call_id:string, category:string, detail:string, tool_name:string,
 *            pending_started_at_ms:number}[]}
 */
function pendingGatesFromBlobJson(jsonObjects, config, opts = {}) {
  const out = [];
  for (const obj of Array.isArray(jsonObjects) ? jsonObjects : []) {
    const cursorOpts = obj && obj.providerOptions && obj.providerOptions.cursor;
    if (!cursorOpts || typeof cursorOpts.pendingToolCallStartedAtMs !== 'number') continue;
    const content = Array.isArray(obj.content) ? obj.content : [];
    for (const block of content) {
      if (!block || block.type !== 'tool-call') continue;
      const call = extractToolCall(toolCallBlockToHookBody(block, opts));
      if (!call || !call.category) continue;
      const decision = evaluateToolCall(call, config || {}, { forceMode: !!opts.forceMode });
      if (decision.decision !== 'prompt') continue; // allowlisted / run-everything / denied → not a gate
      out.push({
        tool_call_id: (block.toolCallId || '').trim(),
        category: decision.category,
        detail: decision.detail,
        tool_name: block.toolName,
        pending_started_at_ms: cursorOpts.pendingToolCallStartedAtMs,
      });
    }
  }
  return out;
}

/**
 * Locate a sub-agent's chat store.db. It is a sibling dir of the parent's store.db, named by the
 * subagent_id: `<projecthash>/<subagent_id>/store.db`. We know the parent's store.db path, so its
 * grandparent is the project-hash dir. Falls back to scanning the chats root.
 */
function subagentStoreDbPath(subagentId, { parentStoreDbPath = '', chatsRoot = CURSOR_CHATS_ROOT } = {}) {
  const id = String(subagentId || '').trim();
  if (!id) return '';
  if (parentStoreDbPath) {
    const projectDir = path.dirname(path.dirname(parentStoreDbPath));
    const candidate = path.join(projectDir, id, 'store.db');
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    for (const hash of fs.readdirSync(chatsRoot)) {
      const candidate = path.join(chatsRoot, hash, id, 'store.db');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* chats root missing */ }
  return '';
}

// Copy db+wal to a temp file (never lock the live store.db) and read every blob's bytes in ONE
// sqlite3 call (id + hex(data), tab-separated — hex never contains a tab or newline).
function readStoreDbBlobs(storeDbPath, { sqlite3Path = 'sqlite3' } = {}) {
  if (!storeDbPath || !fs.existsSync(storeDbPath)) return [];
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curcli-subgate-'));
    const dest = path.join(tmpDir, 'store.db');
    fs.copyFileSync(storeDbPath, dest);
    for (const ext of ['-wal', '-shm']) {
      try { if (fs.existsSync(storeDbPath + ext)) fs.copyFileSync(storeDbPath + ext, dest + ext); } catch { /* best effort */ }
    }
    const res = spawnSync(
      sqlite3Path,
      [dest, "SELECT id || char(9) || hex(data) FROM blobs;"],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10000 }
    );
    if (res.status !== 0) return [];
    const blobs = [];
    for (const line of String(res.stdout || '').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      const hex = line.slice(tab + 1).trim();
      if (!hex) continue;
      blobs.push({ id, json: extractJsonObjectsFromBuffer(Buffer.from(hex, 'hex')) });
    }
    return blobs;
  } catch {
    return [];
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// Read only the HEAD (latest root) blob's pending gates — the authoritative "is the conversation
// parked at a gate right NOW" read. store.db blobs are content-addressed and IMMUTABLE, so an old
// pending marker never clears (readSubagentPendingGates, which scans every blob, would surface stale
// gates forever); the head pointer (meta.latestRootBlobId) is what moves as the conversation
// progresses, so a resolved gate drops out exactly when a new head is written. Used by the live
// production probe for BOTH the parent store.db and each sub-agent store.db. Copies db+wal to a temp
// (never locks the live db). Returns [] on a torn/missing/undecodable read (caller retries next tick).
function readHeadPendingGates(storeDbPath, config, opts = {}) {
  if (!storeDbPath || !fs.existsSync(storeDbPath)) return [];
  const sqlite3Path = opts.sqlite3Path || 'sqlite3';
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curcli-headgate-'));
    const dest = path.join(tmpDir, 'store.db');
    fs.copyFileSync(storeDbPath, dest);
    for (const ext of ['-wal', '-shm']) {
      try { if (fs.existsSync(storeDbPath + ext)) fs.copyFileSync(storeDbPath + ext, dest + ext); } catch { /* best effort */ }
    }
    // meta.value is ALREADY hex-encoded JSON TEXT carrying latestRootBlobId → select it raw and
    // decode ONCE (mirrors readRootBlobId in cursor_chat_db.js and the ssh python reader). The
    // previous `SELECT hex(value)` double-wrapped the hex, the single decode then yielded the
    // literal "7b22…" string, JSON.parse threw, and the catch returned [] on EVERY real store.db —
    // the head probe was structurally blind, so local cursor-cli permission gates never flipped
    // needs_input (Phase-3 cursor-cli findings1 §5, root-caused on the permission-hold diagnostic).
    const metaRes = spawnSync(sqlite3Path, [dest, 'SELECT value FROM meta LIMIT 1;'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10000 });
    if (metaRes.status !== 0) return [];
    let rootId = '';
    try {
      const metaHex = String(metaRes.stdout || '').trim();
      if (!metaHex) return [];
      const meta = JSON.parse(Buffer.from(metaHex, 'hex').toString('utf8'));
      rootId = String(meta.latestRootBlobId || '');
    } catch { return []; }
    if (!rootId) return [];
    const escaped = rootId.replace(/'/g, "''");
    const blobRes = spawnSync(sqlite3Path, [dest, `SELECT hex(data) FROM blobs WHERE id='${escaped}';`],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10000 });
    if (blobRes.status !== 0) return [];
    const dataHex = String(blobRes.stdout || '').trim();
    if (!dataHex) return [];
    const json = extractJsonObjectsFromBuffer(Buffer.from(dataHex, 'hex'));
    return pendingGatesFromBlobJson(json, config, opts).map((g) => ({ ...g, blob_id: rootId }));
  } catch {
    return [];
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// Cheap change-detector so callers can skip the copy+decode when the store.db is unchanged.
function storeDbFingerprint(storeDbPath) {
  let fp = '';
  for (const p of [storeDbPath, `${storeDbPath}-wal`]) {
    try { const st = fs.statSync(p); fp += `${st.mtimeMs}:${st.size};`; } catch { /* missing */ }
  }
  return fp;
}

/** Read one sub-agent store.db and return its currently-pending gates (config-eval'd). */
function readSubagentPendingGates(storeDbPath, config, opts = {}) {
  const gates = [];
  for (const blob of readStoreDbBlobs(storeDbPath, opts)) {
    for (const g of pendingGatesFromBlobJson(blob.json, config, opts)) gates.push({ ...g, blob_id: blob.id });
  }
  return gates;
}

module.exports = {
  CURSOR_CHATS_ROOT,
  toolCallBlockToHookBody,
  pendingGatesFromBlobJson,
  subagentStoreDbPath,
  readStoreDbBlobs,
  readSubagentPendingGates,
  readHeadPendingGates,
  storeDbFingerprint,
};
