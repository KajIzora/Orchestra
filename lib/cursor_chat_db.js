'use strict';

/*
 * cursor_chat_db.js — read the cursor-agent chat store.db for a real-time "pending AskQuestion"
 * (needs-input) signal.
 *
 * Why this exists: cursor-cli emits NO hook and NO transcript marker when the agent asks a question
 * while it is paused. The transcript `AskQuestion` tool_use is only written AFTER the user answers,
 * so it can't drive a needs-input gate. The chat store.db, however, holds the pending question the
 * instant the gate renders (see the signal session deep-dive): the conversation head blob carries an
 * AskQuestion tool-call plus a message-level `providerOptions.cursor.pendingToolCallStartedAtMs`
 * marker, with no tool-result yet. That is the earliest, most reliable question signal we have.
 *
 * Storage shape: store.db is a content-addressed blob store —
 *   blobs(id TEXT PRIMARY KEY, data BLOB)   // id = content hash; immutable, append-only
 *   meta(key TEXT, value TEXT)              // one row; value is hex-encoded JSON holding
 *                                           //   { latestRootBlobId, ... } — the conversation head
 * New conversation state = new blobs appended + latestRootBlobId advancing. The blob `data` is a
 * binary frame with embedded JSON (the frame format is undocumented and version-dependent), so we
 * extract JSON objects by scanning for balanced `{ … }` runs rather than decoding the frame.
 *
 * Read safety (WAL): the live store.db is WAL-mode; while the agent is generating, the real content
 * lives in store.db-wal. A separate read-only connection to a db with an ACTIVE writer reads only
 * the checkpointed main file (misses the WAL) — but a pending question only exists while the gate is
 * HELD, at which point the agent is paused and the db is quiescent. For that quiescent case we copy
 * store.db + -wal + -shm to a temp file and read the COPY read-only (applies the WAL, never locks or
 * checkpoints the agent's live db). When there is no -wal (checkpointed/idle) we read the main file
 * with immutable=1. We validate that the head blob actually resolves, and NEVER cache a torn read,
 * so a db that quiesces right after its final write is re-read until it reads consistently.
 *
 * Remote (source:'ssh') watches: ~/.cursor/chats lives on the REMOTE host (cursor-agent runs
 * headless there), so the synchronous reader below is local-only. The remote transport is the
 * remote-snapshot pattern: run python on the host, copy store.db(+wal+shm) to a remote temp, read
 * the COPY read-only, and return blob hex for LOCAL decoding with the same helpers — see
 * remoteChatDbHeadHexes (head blob, question + permission gates) and remoteChatDbNotificationScan
 * (<system_notification> continuation blobs). Every remote consumer must go through these so there
 * is exactly one store.db-over-ssh transport to keep WAL-safe.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// The binary-frame JSON scanner lives in the generic sqlite delta probe (the capture/tail side);
// importing it here keeps the production reader and the probe from drifting on the cursor store.db
// blob format. cursor-SPECIFIC semantics (pending AskQuestion) stay in this file.
const { extractJsonObjectsFromBuffer } = require('./sqlite_delta_probe');

const SQLITE_BIN = '/usr/bin/sqlite3';
const CHATS_ROOT_PARTS = ['.cursor', 'chats'];

// -- cursor-specific decoders ------------------------------------------------------------------

// The `pendingToolCallStartedAtMs` of an UNANSWERED AskQuestion in a decoded blob, or null. A
// message qualifies when it has the message-level `providerOptions.cursor.pendingToolCallStartedAtMs`
// marker AND an AskQuestion tool-call block. That marker is the needs-input signal; once answered the
// head advances to a message without it. Returns the epoch-ms timestamp so callers can gate on
// linked_at (only treat a question asked AFTER the watch was linked as a fresh gate).
function pendingAskQuestionStartedAtMs(jsonObjects) {
  for (const obj of Array.isArray(jsonObjects) ? jsonObjects : []) {
    const opts = obj && obj.providerOptions && obj.providerOptions.cursor;
    const startedAtMs = opts && opts.pendingToolCallStartedAtMs;
    if (typeof startedAtMs !== 'number') continue;
    const content = Array.isArray(obj.content) ? obj.content : [];
    if (content.some((b) => b && b.type === 'tool-call' && b.toolName === 'AskQuestion')) return startedAtMs;
  }
  return null;
}

// True when a decoded blob carries an unanswered AskQuestion (no linked_at gating). Used by the
// capture-everything session channel + recording builder, where every pending blob is recorded.
function blobHasPendingAskQuestion(jsonObjects) {
  return pendingAskQuestionStartedAtMs(jsonObjects) != null;
}

// The unanswered AskQuestion tool-call of a decoded blob as { startedAtMs, args } (or null). Same
// pending-marker discipline as pendingAskQuestionStartedAtMs, but ALSO returns the tool-call `args`
// ({ title, questions[] }) — the store.db head carries the full question payload WHILE the gate is
// held (verified in signal-lab/cursor-cli/2026-07-11T02-53-53-347Z), so the live-feed question
// adapter can surface the structured payload pre-answer, not only from the delayed transcript row.
function pendingAskQuestionPayload(jsonObjects) {
  for (const obj of Array.isArray(jsonObjects) ? jsonObjects : []) {
    const opts = obj && obj.providerOptions && obj.providerOptions.cursor;
    const startedAtMs = opts && opts.pendingToolCallStartedAtMs;
    if (typeof startedAtMs !== 'number') continue;
    const content = Array.isArray(obj.content) ? obj.content : [];
    for (const b of content) {
      if (b && b.type === 'tool-call' && b.toolName === 'AskQuestion') {
        return { startedAtMs, args: b.args && typeof b.args === 'object' ? b.args : null };
      }
    }
  }
  return null;
}

// The concatenated text of an assistant message among decoded blob objects, or '' when none carries
// text. Used by the live-feed POST-DONE step: cursor's stop hook carries NO text (raw-verified), but
// the FINAL assistant message DOES exist in the store.db as a `role:'assistant'` blob whose `content`
// holds `{type:'text', text}` blocks (verified live: a finished conversation's newest assistant blob
// is the closing handoff). Returns the LAST assistant message found in the passed objects, so the
// caller can scan blobs newest-first and stop at the first hit. Never throws.
function assistantTextFromBlobObjects(jsonObjects) {
  let text = '';
  for (const obj of Array.isArray(jsonObjects) ? jsonObjects : []) {
    if (!obj || obj.role !== 'assistant') continue;
    const content = Array.isArray(obj.content) ? obj.content : [];
    const parts = [];
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
    }
    if (parts.length) text = parts.join('\n'); // last assistant-with-text object in this batch wins
  }
  return text;
}

// -- low-level store.db reads ------------------------------------------------------------------

function runSqliteJson(dbArg, sql, { readonly = false } = {}) {
  const args = readonly ? ['-readonly', '-json', dbArg, sql] : ['-json', dbArg, sql];
  const out = execFileSync(SQLITE_BIN, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const text = String(out || '').trim();
  return text ? JSON.parse(text) : [];
}

// Decode meta → latestRootBlobId from a readable db handle (path or file: URI). meta.value is
// hex-encoded JSON TEXT, so decode once.
function readRootBlobId(dbArg, sqliteOpts) {
  const rows = runSqliteJson(dbArg, 'SELECT value FROM meta LIMIT 1;', sqliteOpts);
  const hex = rows && rows[0] && rows[0].value;
  if (!hex) return '';
  try {
    const meta = JSON.parse(Buffer.from(String(hex), 'hex').toString('utf8'));
    return String(meta.latestRootBlobId || '');
  } catch {
    return '';
  }
}

// Decode meta → name (the human chat title Cursor shows in its tab). Same hex-encoded JSON blob
// as readRootBlobId, different field. Returns '' if absent/undecodable.
function readChatName(dbArg, sqliteOpts) {
  const rows = runSqliteJson(dbArg, 'SELECT value FROM meta LIMIT 1;', sqliteOpts);
  const hex = rows && rows[0] && rows[0].value;
  if (!hex) return '';
  try {
    const meta = JSON.parse(Buffer.from(String(hex), 'hex').toString('utf8'));
    return String(meta.name || '').trim();
  } catch {
    return '';
  }
}

// Whether the head (latest root) blob is a pending AskQuestion. Returns { ok, pending, startedAtMs }:
//   ok=false  → the read was torn/inconsistent (head blob missing or undecodable); caller must NOT
//               cache it and should retry next tick.
//   ok=true   → authoritative for this db state. startedAtMs is the pending marker's epoch-ms (or
//               null) so callers can gate on linked_at.
function readHeadPendingFromDb(dbArg, sqliteOpts) {
  const rootId = readRootBlobId(dbArg, sqliteOpts);
  if (!rootId) return { ok: false, pending: false, startedAtMs: null };
  // blobs(data) is a real BLOB → hex() then decode once. A torn snapshot can name a head blob the
  // blobs table doesn't have yet → treat as not-ok.
  const escaped = rootId.replace(/'/g, "''");
  const rows = runSqliteJson(dbArg, `SELECT hex(data) AS data FROM blobs WHERE id='${escaped}';`, sqliteOpts);
  const dataHex = rows && rows[0] && rows[0].data;
  if (!dataHex) return { ok: false, pending: false, startedAtMs: null };
  const raw = Buffer.from(String(dataHex), 'hex');
  const payload = pendingAskQuestionPayload(extractJsonObjectsFromBuffer(raw));
  // `args` is additive — existing callers (createCursorChatDbReader, remote path) read only
  // ok/pending/startedAtMs; the live-feed question adapter reads args for the gate_open payload.
  return payload
    ? { ok: true, pending: true, startedAtMs: payload.startedAtMs, args: payload.args }
    : { ok: true, pending: false, startedAtMs: null, args: null };
}

function statSig(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

// Read the REMOTE conversation heads (latest root blob per conversation id) over ssh. cursor-agent
// runs headless on the remote (cursor-cli --source ssh), so each conversation's store.db lives on
// the remote at ~/.cursor/chats/<hash>/<conversationId>/ (a sub-agent's sibling store.db is the
// same shape, keyed by the subagent id) — we run python on the host to copy store.db(+wal+shm) to
// a remote temp, read the COPY read-only (the same WAL-safe snapshot the local reader does), and
// return each head blob's hex for LOCAL decoding with the same helpers the local path uses, so any
// pending decision (question OR permission gate) is identical local vs remote.
// `runSsh(host, cmd, timeoutMs)` is the transport (createSshRunner).
// Returns { heads: { [conversationId]: hexOrEmpty } } — '' for a missing dir / torn read — or
// null on transport failure, so callers can distinguish "read fine, no head" from "ssh broke".
async function remoteChatDbHeadHexes({ host, conversationIds = [], runSsh, timeoutMs = 4000 } = {}) {
  const convs = (Array.isArray(conversationIds) ? conversationIds : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  if (!host || !convs.length || typeof runSsh !== 'function') return null;
  const params = Buffer.from(JSON.stringify({ convs }), 'utf8').toString('base64');
  const py = [
    'import json,base64,os,sqlite3,tempfile,shutil,binascii',
    `P=json.loads(base64.b64decode("${params}").decode())`,
    'root=os.path.expanduser("~/.cursor/chats")',
    'def head_hex(conv):',
    '  d=""',
    '  try:',
    '    for h in os.listdir(root):',
    '      cand=os.path.join(root,h,conv)',
    '      if os.path.isdir(cand): d=cand; break',
    '  except OSError: return ""',
    '  if not d: return ""',
    '  db=os.path.join(d,"store.db")',
    '  tmp=tempfile.mkdtemp(prefix="cursor-chatdb-prod-")',
    '  try:',
    '    try:',
    '      shutil.copyfile(db,os.path.join(tmp,"store.db"))',
    '      for suf in ("-wal","-shm"):',
    '        try: shutil.copyfile(db+suf,os.path.join(tmp,"store.db"+suf))',
    '        except OSError: pass',
    '      conn=sqlite3.connect("file:"+os.path.join(tmp,"store.db")+"?mode=ro",uri=True,timeout=0.5)',
    '    except (OSError,sqlite3.Error): return ""',
    '    try:',
    '      r=conn.execute("SELECT value FROM meta LIMIT 1").fetchone()',
    '      root_id=""',
    '      if r and r[0] is not None:',
    '        mh=r[0] if isinstance(r[0],str) else binascii.hexlify(r[0]).decode()',
    '        try: root_id=json.loads(bytes.fromhex(mh).decode("utf-8","ignore")).get("latestRootBlobId","")',
    '        except Exception: root_id=""',
    '      if root_id:',
    '        br=conn.execute("SELECT hex(data) FROM blobs WHERE id=?",(root_id,)).fetchone()',
    '        if br and br[0]: return br[0]',
    '    except sqlite3.Error: return ""',
    '    finally: conn.close()',
    '    return ""',
    '  finally: shutil.rmtree(tmp,ignore_errors=True)',
    'out={"ok":True,"heads":{}}',
    'for c in P.get("convs") or []:',
    '  out["heads"][c]=head_hex(c)',
    'print(json.dumps(out))',
  ].join('\n');
  const cmd = `python3 - <<'CURSOR_PROD_PYEOF'\n${py}\nCURSOR_PROD_PYEOF`;
  try {
    const out = await runSsh(host, cmd, timeoutMs);
    const res = JSON.parse(String(out || '').trim() || '{}');
    if (!res || res.ok !== true || typeof res.heads !== 'object') return null;
    const heads = {};
    for (const conv of convs) heads[conv] = String(res.heads[conv] || '');
    return { heads };
  } catch {
    return null;
  }
}

// Whether the REMOTE conversation head is a pending AskQuestion asked after `sinceMs`. Thin wrapper
// over remoteChatDbHeadHexes (single conversation); the hex is parsed HERE with the same helpers the
// local path uses, so the pending decision is identical local vs remote. Returns false on any
// failure (missing dir, torn read, ssh error) so a cold poll never false-positives.
async function remotePendingAskQuestion({ host, conversationId, sinceMs = 0, runSsh, timeoutMs = 4000 } = {}) {
  if (!host || !conversationId || typeof runSsh !== 'function') return false;
  const res = await remoteChatDbHeadHexes({ host, conversationIds: [conversationId], runSsh, timeoutMs });
  const hex = res && res.heads ? res.heads[String(conversationId).trim()] : '';
  if (!hex) return false;
  const startedAtMs = pendingAskQuestionStartedAtMs(extractJsonObjectsFromBuffer(Buffer.from(String(hex), 'hex')));
  return startedAtMs != null && startedAtMs >= (sinceMs || 0);
}

// Remote blob-id diff scan for queued `<system_notification>` continuation blobs (the cursor-cli
// continuation gate's store.db surface — see lib/cursor_cli_continuation.js). One ssh round-trip:
// snapshot-copy the conversation's remote store.db, list every blob id, and return the raw hex of
// blobs NOT in `knownIds` whose bytes contain the marker (a cheap remote pre-filter — a blob without
// the marker can never be a notification; the authoritative user-role JSON check runs LOCALLY via
// blobIsSystemNotification on the returned hex, identical to the local path). Returns
// { ids, freshHexes } or null on failure (missing dir / ssh error) so a cold scan never counts as a
// baseline.
async function remoteChatDbNotificationScan({
  host,
  conversationId,
  knownIds = [],
  marker = '<system_notification>',
  maxBlobBytes = 262144,
  runSsh,
  timeoutMs = 5000,
} = {}) {
  const conv = String(conversationId || '').trim();
  if (!host || !conv || typeof runSsh !== 'function') return null;
  const params = Buffer.from(
    JSON.stringify({ conv, known: Array.isArray(knownIds) ? knownIds : [], marker, cap: maxBlobBytes }),
    'utf8'
  ).toString('base64');
  const py = [
    'import json,base64,os,sqlite3,tempfile,shutil,binascii',
    `P=json.loads(base64.b64decode("${params}").decode())`,
    'conv=P["conv"]; known=set(P.get("known") or [])',
    'marker=str(P.get("marker") or "<system_notification>").encode()',
    'cap=int(P.get("cap") or 262144)',
    'root=os.path.expanduser("~/.cursor/chats"); d=""',
    'try:',
    '  for h in os.listdir(root):',
    '    cand=os.path.join(root,h,conv)',
    '    if os.path.isdir(cand): d=cand; break',
    'except OSError: pass',
    'out={"ok":False,"ids":[],"fresh_hexes":[]}',
    'if d:',
    '  db=os.path.join(d,"store.db")',
    '  tmp=tempfile.mkdtemp(prefix="cursor-cont-ssh-")',
    '  try:',
    '    try:',
    '      shutil.copyfile(db,os.path.join(tmp,"store.db"))',
    '      for suf in ("-wal","-shm"):',
    '        try: shutil.copyfile(db+suf,os.path.join(tmp,"store.db"+suf))',
    '        except OSError: pass',
    '      conn=sqlite3.connect("file:"+os.path.join(tmp,"store.db")+"?mode=ro",uri=True,timeout=0.5)',
    '      try:',
    '        for (bid,data) in conn.execute("SELECT id, data FROM blobs"):',
    '          bid=str(bid)',
    '          out["ids"].append(bid)',
    '          if bid in known: continue',
    '          raw=bytes(data) if isinstance(data,(bytes,bytearray)) else str(data or "").encode()',
    '          if marker in raw and len(raw)<=cap:',
    '            out["fresh_hexes"].append(binascii.hexlify(raw).decode())',
    '        out["ok"]=True',
    '      finally: conn.close()',
    '    except (OSError,sqlite3.Error): pass',
    '  finally: shutil.rmtree(tmp,ignore_errors=True)',
    'print(json.dumps(out))',
  ].join('\n');
  const cmd = `python3 - <<'CURSOR_CONT_PYEOF'\n${py}\nCURSOR_CONT_PYEOF`;
  try {
    const out = await runSsh(host, cmd, timeoutMs);
    const res = JSON.parse(String(out || '').trim() || '{}');
    if (!res || res.ok !== true) return null;
    return {
      ids: Array.isArray(res.ids) ? res.ids.map(String) : [],
      freshHexes: Array.isArray(res.fresh_hexes) ? res.fresh_hexes.map(String) : [],
    };
  } catch {
    return null;
  }
}

// Locate ~/.cursor/chats/<workspaceHash>/<conversationId>/ (the hash dir is not derivable, so scan).
function findChatDbDir(conversationId, homeDir = os.homedir()) {
  const conv = String(conversationId || '').trim();
  if (!conv) return '';
  const root = path.join(homeDir, ...CHATS_ROOT_PARTS);
  let hashes;
  try {
    hashes = fs.readdirSync(root);
  } catch {
    return '';
  }
  for (const hash of hashes) {
    const candidate = path.join(root, hash, conv);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* not this hash */ }
  }
  return '';
}

// Placeholder titles Cursor uses before a chat is auto-named — treated as "no title yet".
const CURSOR_DEFAULT_NAMES = new Set(['', 'New Agent', 'New Composer', 'New Chat', 'New conversation']);

// Current Cursor stores IDE chat (composer) titles in the GLOBAL state.vscdb — table cursorDiskKV,
// key `composerData:<composerId>`, whose JSON `.name` is the human title. The composerId equals the
// conversation_id Orchestra tracks. This is the live source; ~/.cursor/chats/store.db is legacy.
const CURSOR_GLOBAL_DB_PARTS = [
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'state.vscdb',
];

function cursorComposerTitle(conversationId, homeDir = os.homedir()) {
  const conv = String(conversationId || '').trim();
  if (!conv) return '';
  const dbPath = path.join(homeDir, ...CURSOR_GLOBAL_DB_PARTS);
  try {
    if (!fs.statSync(dbPath).isFile()) return '';
  } catch {
    return '';
  }
  const key = `composerData:${conv}`.replace(/'/g, "''");
  const sql = `SELECT json_extract(value,'$.name') AS name FROM cursorDiskKV WHERE key='${key}' LIMIT 1;`;
  // The DB is live (Cursor holds it in WAL mode); try a WAL-respecting read-only connection first,
  // then an immutable read of the main file. Never throw.
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?immutable=1`]) {
    try {
      const rows = runSqliteJson(uri, sql, { readonly: true });
      const name = rows && rows[0] ? rows[0].name : null;
      if (typeof name !== 'string') return '';
      const trimmed = name.trim();
      return CURSOR_DEFAULT_NAMES.has(trimmed) ? '' : trimmed;
    } catch {
      /* try the next connection strategy */
    }
  }
  return '';
}

// Best-effort human chat title for a LOCAL Cursor conversation. Tries the current global-storage
// composer title first, then the legacy per-chat store.db (meta.name). '' when unavailable or the
// chat is still the unnamed default. Remote/ssh chats live on the remote and aren't read here.
function chatNameForConversation(conversationId, homeDir = os.homedir()) {
  const conv = String(conversationId || '').trim();
  if (!conv) return '';
  const composerTitle = cursorComposerTitle(conv, homeDir);
  if (composerTitle) return composerTitle;

  // Legacy fallback: ~/.cursor/chats/<hash>/<id>/store.db meta.name.
  const dir = findChatDbDir(conv, homeDir);
  if (!dir) return '';
  const dbPath = path.join(dir, 'store.db');
  const walPath = `${dbPath}-wal`;
  let walSt;
  try {
    walSt = fs.statSync(walPath);
  } catch {
    walSt = null;
  }
  let name = '';
  try {
    if (!walSt || walSt.size === 0) {
      name = readChatName(`file:${dbPath}?immutable=1`, { readonly: false });
    } else {
      name = readChatName(dbPath, { readonly: true });
    }
  } catch {
    return '';
  }
  return CURSOR_DEFAULT_NAMES.has(String(name).trim()) ? '' : name;
}

// Read the REMOTE Cursor chat TITLE (store.db meta.name) over ssh. cursor-agent runs headless on the
// remote (cursor-cli --source ssh), so each conversation's store.db lives on the remote at
// ~/.cursor/chats/<hash>/<conversationId>/store.db. Same WAL-safe snapshot transport as
// remoteChatDbHeadHexes (copy store.db+wal+shm to a remote temp, read ?mode=ro), but returns the meta
// `.name` directly — no blob fetch. Returns { titles: { [conversationId]: rawNameOrEmpty } } or null on
// transport failure so callers can tell "read fine, no title" from "ssh broke". Raw (unfiltered).
async function remoteChatDbTitles({ host, conversationIds = [], runSsh, timeoutMs = 4000 } = {}) {
  const convs = (Array.isArray(conversationIds) ? conversationIds : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  if (!host || !convs.length || typeof runSsh !== 'function') return null;
  const params = Buffer.from(JSON.stringify({ convs }), 'utf8').toString('base64');
  const py = [
    'import json,base64,os,sqlite3,tempfile,shutil,binascii',
    `P=json.loads(base64.b64decode("${params}").decode())`,
    'root=os.path.expanduser("~/.cursor/chats")',
    'def title(conv):',
    '  d=""',
    '  try:',
    '    for h in os.listdir(root):',
    '      cand=os.path.join(root,h,conv)',
    '      if os.path.isdir(cand): d=cand; break',
    '  except OSError: return ""',
    '  if not d: return ""',
    '  db=os.path.join(d,"store.db")',
    '  tmp=tempfile.mkdtemp(prefix="cursor-title-prod-")',
    '  try:',
    '    try:',
    '      shutil.copyfile(db,os.path.join(tmp,"store.db"))',
    '      for suf in ("-wal","-shm"):',
    '        try: shutil.copyfile(db+suf,os.path.join(tmp,"store.db"+suf))',
    '        except OSError: pass',
    '      conn=sqlite3.connect("file:"+os.path.join(tmp,"store.db")+"?mode=ro",uri=True,timeout=0.5)',
    '    except (OSError,sqlite3.Error): return ""',
    '    try:',
    '      r=conn.execute("SELECT value FROM meta LIMIT 1").fetchone()',
    '      if r and r[0] is not None:',
    '        mh=r[0] if isinstance(r[0],str) else binascii.hexlify(r[0]).decode()',
    '        try: return json.loads(bytes.fromhex(mh).decode("utf-8","ignore")).get("name","") or ""',
    '        except Exception: return ""',
    '    except sqlite3.Error: return ""',
    '    finally: conn.close()',
    '    return ""',
    '  finally: shutil.rmtree(tmp,ignore_errors=True)',
    'out={"ok":True,"titles":{}}',
    'for c in P.get("convs") or []:',
    '  out["titles"][c]=title(c)',
    'print(json.dumps(out))',
  ].join('\n');
  const cmd = `python3 - <<'CURSOR_TITLE_PYEOF'\n${py}\nCURSOR_TITLE_PYEOF`;
  try {
    const out = await runSsh(host, cmd, timeoutMs);
    const res = JSON.parse(String(out || '').trim() || '{}');
    if (!res || res.ok !== true || typeof res.titles !== 'object') return null;
    const titles = {};
    for (const conv of convs) titles[conv] = String(res.titles[conv] || '');
    return { titles };
  } catch {
    return null;
  }
}

// Single-conversation remote title, filtered through CURSOR_DEFAULT_NAMES exactly like the local
// chatNameForConversation so placeholder names ("New Agent", …) map to ''. Returns '' on any failure.
async function remoteChatNameForConversation({ host, conversationId, runSsh, timeoutMs = 4000 } = {}) {
  const conv = String(conversationId || '').trim();
  if (!host || !conv || typeof runSsh !== 'function') return '';
  const res = await remoteChatDbTitles({ host, conversationIds: [conv], runSsh, timeoutMs });
  const name = res && res.titles ? String(res.titles[conv] || '').trim() : '';
  return CURSOR_DEFAULT_NAMES.has(name) ? '' : name;
}

// Read head-pending for a chat-db dir, choosing the safe strategy for the db's current WAL state.
// Returns { ok, pending, startedAtMs } (see readHeadPendingFromDb).
function readChatDbDirHeadPending(dir) {
  const dbPath = path.join(dir, 'store.db');
  const walPath = `${dbPath}-wal`;
  let walSt;
  try { walSt = fs.statSync(walPath); } catch { walSt = null; }

  if (!walSt || walSt.size === 0) {
    // Checkpointed / idle: the main file is self-consistent. immutable=1 reads it without WAL/SHM
    // and without any locking.
    try {
      return readHeadPendingFromDb(`file:${dbPath}?immutable=1`, { readonly: false });
    } catch {
      return { ok: false, pending: false, startedAtMs: null };
    }
  }

  // Active WAL present. A read-only connection to the LIVE file with a concurrent writer misses the
  // WAL, so copy db+wal+shm to a temp snapshot and read the copy. When the gate is held the db is
  // quiescent and the copy is consistent; mid-write the copy may be torn → readHeadPendingFromDb
  // returns ok=false and the caller retries.
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-chatdb-ro-'));
    const tmpDb = path.join(tmpDir, 'store.db');
    fs.copyFileSync(dbPath, tmpDb);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.copyFileSync(`${dbPath}${suffix}`, `${tmpDb}${suffix}`); } catch { /* shm/wal may vanish on checkpoint */ }
    }
    return readHeadPendingFromDb(tmpDb, { readonly: true });
  } catch {
    return { ok: false, pending: false, startedAtMs: null };
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// The LAST assistant message text from a db handle: scan blobs NEWEST-first (rowid DESC) and return
// the first blob that decodes to an assistant message carrying text. `blobs` is an append-only rowid
// table (CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB) — verified), so the highest-rowid
// assistant-text blob is the conversation's final message; a completed turn's newest such blob is the
// closing handoff. Bounded: scans at most `maxBlobs` newest rows and stops at the first hit (the
// final message pair sits at the top, so this is typically 1-2 decodes). Returns '' when none. A torn
// snapshot simply yields '' (the caller fail-safes to a blank strip). Never throws.
function readChatDbLastAssistantText(dbArg, sqliteOpts, { maxBlobs = 400 } = {}) {
  const limit = Number.isInteger(maxBlobs) && maxBlobs > 0 ? maxBlobs : 400;
  let rows;
  try {
    rows = runSqliteJson(dbArg, `SELECT hex(data) AS data FROM blobs ORDER BY rowid DESC LIMIT ${limit};`, sqliteOpts);
  } catch {
    return '';
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const dataHex = row && row.data;
    if (!dataHex) continue;
    let text = '';
    try {
      text = assistantTextFromBlobObjects(extractJsonObjectsFromBuffer(Buffer.from(String(dataHex), 'hex')));
    } catch {
      text = '';
    }
    if (text) return text; // newest-first → the first hit is the final assistant message
  }
  return '';
}

// Read the LAST assistant message text for a chat-db dir, choosing the WAL-safe strategy for the db's
// current state (mirrors readChatDbDirHeadPending). This fires POST-DONE, when the agent has finished
// and the db is quiescent, so the checkpointed/immutable read is the common path. Returns '' on any
// failure — the caller keeps the blank done strip (fail-safe).
function readChatDbDirLastAssistantText(dir, opts = {}) {
  const dbPath = path.join(dir, 'store.db');
  const walPath = `${dbPath}-wal`;
  let walSt;
  try { walSt = fs.statSync(walPath); } catch { walSt = null; }

  if (!walSt || walSt.size === 0) {
    try {
      return readChatDbLastAssistantText(`file:${dbPath}?immutable=1`, { readonly: false }, opts);
    } catch {
      return '';
    }
  }

  // Active WAL: copy db+wal+shm to a temp snapshot and read the copy (same discipline as the head
  // reader — never lock or checkpoint the agent's live db).
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-chatdb-laa-'));
    const tmpDb = path.join(tmpDir, 'store.db');
    fs.copyFileSync(dbPath, tmpDb);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.copyFileSync(`${dbPath}${suffix}`, `${tmpDb}${suffix}`); } catch { /* shm/wal may vanish on checkpoint */ }
    }
    return readChatDbLastAssistantText(tmpDb, { readonly: true }, opts);
  } catch {
    return '';
  } finally {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// -- production reader (instance with a per-conversation cache) ---------------------------------

/*
 * createCursorChatDbReader — one instance per server (like cursorCliPermissionTracker). Exposes
 * pendingAskQuestion(conversationId, { sinceMs }): boolean. mtime/size-gated so an unchanged db is
 * not re-read, and a torn read is never cached (so a db that quiesces right after writing its pending
 * blob is re-read until it reads consistently, then the result sticks until the next change).
 *
 * sinceMs (the watch's linked_at, epoch-ms) gates on the pending marker's own timestamp: a question
 * asked BEFORE the watch was linked (a stale head left over from a prior turn) is ignored, mirroring
 * the transcript path's cursorRecordAfterLinkedAt check. The CACHE stores the raw startedAtMs so the
 * same cached read can be re-evaluated against different sinceMs without re-reading the db.
 */
function createCursorChatDbReader({ homeDir = os.homedir() } = {}) {
  const cache = new Map(); // conversationId -> { sig, startedAtMs, args }

  // Read (mtime/size-gated) the current head-pending entry for a conversation. Shared by
  // pendingAskQuestion (boolean) and headPendingQuestion (payload) so the live-feed adapter and the
  // watch poller hit the SAME cached read on a given tick instead of two store.db reads.
  function readCached(conv) {
    const dir = findChatDbDir(conv, homeDir);
    if (!dir) return null;
    const dbPath = path.join(dir, 'store.db');
    const sig = `${statSig(dbPath)}|${statSig(`${dbPath}-wal`)}`;
    let entry = cache.get(conv);
    if (!entry || entry.sig !== sig) {
      const res = readChatDbDirHeadPending(dir);
      if (res.ok) {
        entry = { sig, startedAtMs: res.pending ? res.startedAtMs : null, args: res.pending ? res.args || null : null };
        cache.set(conv, entry);
      }
      // Torn read (res.ok false): keep the prior entry (or none) and evaluate that below.
    }
    return entry || null;
  }

  function pendingAskQuestion(conversationId, { sinceMs = 0 } = {}) {
    const conv = String(conversationId || '').trim();
    if (!conv) return false;
    const entry = readCached(conv);
    if (!entry || entry.startedAtMs == null) return false;
    return sinceMs ? entry.startedAtMs >= sinceMs : true;
  }

  // Payload variant for the live feed: the head-pending question's { pending, startedAtMs, args }
  // ({ title, questions[] }), gated on sinceMs exactly like pendingAskQuestion. Never throws.
  function headPendingQuestion(conversationId, { sinceMs = 0 } = {}) {
    const conv = String(conversationId || '').trim();
    if (!conv) return { pending: false, startedAtMs: null, args: null };
    const entry = readCached(conv);
    if (!entry || entry.startedAtMs == null) return { pending: false, startedAtMs: null, args: null };
    if (sinceMs && entry.startedAtMs < sinceMs) return { pending: false, startedAtMs: entry.startedAtMs, args: null };
    return { pending: true, startedAtMs: entry.startedAtMs, args: entry.args || null };
  }

  // POST-DONE final message (live-feed stop text): the conversation's LAST assistant message text, or
  // '' when unavailable. Cursor's stop hook carries NO text; this ONE bounded store.db read (blobs
  // newest-first, stop at the first assistant-text blob) recovers the closing handoff a beat after
  // done. A SEPARATE db-signature cache from the head-pending cache (different query), so the two
  // reads never clobber each other; an unchanged db is not re-scanned. Never throws.
  const lastAssistantCache = new Map(); // conversationId -> { sig, text }
  function lastAssistantText(conversationId) {
    const conv = String(conversationId || '').trim();
    if (!conv) return '';
    const dir = findChatDbDir(conv, homeDir);
    if (!dir) return '';
    const dbPath = path.join(dir, 'store.db');
    const sig = `${statSig(dbPath)}|${statSig(`${dbPath}-wal`)}`;
    const prev = lastAssistantCache.get(conv);
    if (prev && prev.sig === sig) return prev.text;
    let text = '';
    try {
      text = readChatDbDirLastAssistantText(dir);
    } catch {
      text = '';
    }
    lastAssistantCache.set(conv, { sig, text });
    return text;
  }

  return { pendingAskQuestion, headPendingQuestion, lastAssistantText, _cache: cache };
}

module.exports = {
  extractJsonObjectsFromBuffer,
  blobHasPendingAskQuestion,
  pendingAskQuestionStartedAtMs,
  pendingAskQuestionPayload,
  assistantTextFromBlobObjects,
  readChatDbDirLastAssistantText,
  findChatDbDir,
  readChatName,
  cursorComposerTitle,
  chatNameForConversation,
  remoteChatDbTitles,
  remoteChatNameForConversation,
  readChatDbDirHeadPending,
  remotePendingAskQuestion,
  remoteChatDbHeadHexes,
  remoteChatDbNotificationScan,
  createCursorChatDbReader,
  SQLITE_BIN,
};
