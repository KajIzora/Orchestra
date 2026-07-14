'use strict';

/*
 * agy_summaries.js — resolve a human chat TITLE for a Gemini "agy" (Antigravity) conversation by
 * reading Antigravity's on-disk summary stores. Two local sources, both keyed by conversation UUID:
 *
 *   agy-app  ~/.gemini/antigravity/agyhub_summaries_proto.pb
 *            A protobuf "hub" file (~1MB, rewritten live). No .proto schema is shipped, so we do a
 *            tolerant STRUCTURAL walk of the protobuf wire format. Every relevant field is
 *            length-delimited (wire type 2). The observed framing is:
 *              Hub     { repeated Entry entries = 1 }     // top level: repeated tag 0x0a
 *              Entry   { string conversation_id = 1;      //   tag 0x0a  → a 36-char UUID
 *                        Summary summary = 2 }            //   tag 0x12  → nested message
 *              Summary { string title = 1; ... }          //   first nested field, tag 0x0a
 *            We read ONLY Entry.field#1 (the UUID) and Summary.field#1 (the title). Protobuf
 *            serializes fields in ascending field-number order, so when a title is present it is the
 *            first byte of the Summary sub-message (tag 0x0a); an empty/omitted title simply leaves
 *            us with ''. Every other field is skipped by its declared length, so unknown or
 *            reordered fields never derail the walk. Corrupt/truncated runs abort that entry and we
 *            resync on the next top-level 0x0a tag.
 *
 *   agy-cli  ~/.gemini/antigravity-cli/conversation_summaries.db
 *            sqlite: table conversation_summaries(conversation_id TEXT PK, title TEXT NOT NULL, ...).
 *            Read by shelling out to the sqlite3 binary read-only (same approach as
 *            lib/cursor_chat_db.js). May legitimately be EMPTY (0 rows) — handled as "no titles".
 *
 * titleForConversation(conversationId, homeDir?) → the title, or '' when unknown. A non-empty title
 * from EITHER source wins; the proto hub (agy-app) is preferred over the cli db when both have one.
 * The convId→title map is cached and only rebuilt when a source file's mtime/size changes (and at
 * most once per refresh window), so the hot poll path is a plain Map lookup, not a 1MB re-parse.
 * NEVER throws — any read/parse error yields '' / an empty map.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SQLITE_BIN = '/usr/bin/sqlite3';
const HUB_PARTS = ['.gemini', 'antigravity', 'agyhub_summaries_proto.pb'];
const CLI_DB_PARTS = ['.gemini', 'antigravity-cli', 'conversation_summaries.db'];

// Even when a source file is being rewritten live (the hub is), don't re-stat + re-parse more than
// this often. A title that appears a second late in the picker is invisible; a 1MB re-parse on every
// poll tick is not worth it.
const MIN_REFRESH_MS = 1500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -- protobuf helpers --------------------------------------------------------------------------

// Read a base-128 varint at offset `i`. Returns { value, next }. `value` is -1 on a truncated run
// (caller must bail). Uses multiplication rather than `<<` so a length past 2^31 can't wrap; all
// lengths here are far below 2^53.
function readVarint(buf, i) {
  let value = 0;
  let mul = 1;
  let n = 0;
  while (i + n < buf.length) {
    const byte = buf[i + n];
    value += (byte & 0x7f) * mul;
    n += 1;
    if ((byte & 0x80) === 0) return { value, next: i + n };
    mul *= 128;
    if (mul > Number.MAX_SAFE_INTEGER) break;
  }
  return { value: -1, next: i + n };
}

// Advance past one field whose tag starts at `j` and whose wire type is `wire`. Returns the offset
// after the field, or -1 if it can't be skipped safely (truncation / group wire types 3-4).
function skipField(buf, j, end, wire) {
  if (wire === 0) {
    const lv = readVarint(buf, j + 1);
    return lv.value < 0 ? -1 : lv.next;
  }
  if (wire === 1) return j + 1 + 8 <= end ? j + 1 + 8 : -1; // 64-bit
  if (wire === 5) return j + 1 + 4 <= end ? j + 1 + 4 : -1; // 32-bit
  if (wire === 2) {
    const lv = readVarint(buf, j + 1);
    if (lv.value < 0) return -1;
    const fend = lv.next + lv.value;
    return fend <= end ? fend : -1;
  }
  return -1; // groups / unknown wire type → bail
}

// Read the first field of a Summary sub-message [start,end) IF it is field #1, wire type 2 (the
// title). Returns the trimmed title, or '' when the first field isn't the title (empty/omitted) or
// the read is truncated.
function summaryTitle(buf, start, end) {
  if (start >= end || buf[start] !== 0x0a) return ''; // 0x0a = field 1, wire type 2
  const lv = readVarint(buf, start + 1);
  if (lv.value < 0) return '';
  const tstart = lv.next;
  const tend = tstart + lv.value;
  if (tend > end) return '';
  return buf.toString('utf8', tstart, tend).trim();
}

// Parse one Entry [start,end) and, if it yields a UUID conversation_id + non-empty title, record it.
function parseHubEntry(buf, start, end, map) {
  let convId = '';
  let title = '';
  let j = start;
  while (j < end) {
    const tag = buf[j];
    const wire = tag & 0x07;
    const field = tag >> 3;
    if (wire !== 2) {
      const nxt = skipField(buf, j, end, wire);
      if (nxt < 0) return;
      j = nxt;
      continue;
    }
    const lv = readVarint(buf, j + 1);
    if (lv.value < 0) return;
    const fstart = lv.next;
    const fend = fstart + lv.value;
    if (fend > end) return;
    if (field === 1 && !convId) {
      convId = buf.toString('utf8', fstart, fend).trim();
    } else if (field === 2 && !title) {
      title = summaryTitle(buf, fstart, fend);
    }
    j = fend;
  }
  if (convId && title && UUID_RE.test(convId)) {
    map.set(convId.toLowerCase(), title);
  }
}

// Tolerant structural walk of the agy hub .pb → Map<lowercased convId, title>. Never throws.
function parseHubProto(buf) {
  const map = new Map();
  if (!Buffer.isBuffer(buf) || buf.length === 0) return map;
  const n = buf.length;
  let i = 0;
  while (i < n) {
    // Top level: we only care about field #1, wire type 2 (tag 0x0a) = one Entry. Any other byte is
    // a resync point (skip it and keep scanning).
    if (buf[i] !== 0x0a) {
      i += 1;
      continue;
    }
    const lv = readVarint(buf, i + 1);
    if (lv.value < 0) break;
    const start = lv.next;
    const end = start + lv.value;
    if (lv.value < 2 || end > n) {
      i += 1;
      continue;
    }
    parseHubEntry(buf, start, end, map);
    i = end;
  }
  return map;
}

// -- sqlite (agy-cli) --------------------------------------------------------------------------

// Read conversation_summaries → Map<lowercased convId, title>. Read-only (won't lock/checkpoint a
// live db); an empty table or a missing/locked db yields an empty map. Never throws.
function parseCliDb(dbPath) {
  const map = new Map();
  let out;
  try {
    out = execFileSync(
      SQLITE_BIN,
      [
        '-readonly',
        '-json',
        dbPath,
        "SELECT conversation_id, title FROM conversation_summaries WHERE title <> '';",
      ],
      { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch {
    return map; // missing db, no such table, locked, or sqlite3 absent
  }
  const text = String(out || '').trim();
  if (!text) return map;
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return map;
  }
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    const id = row && typeof row.conversation_id === 'string' ? row.conversation_id.trim() : '';
    const title = row && typeof row.title === 'string' ? row.title.trim() : '';
    if (id && title) map.set(id.toLowerCase(), title);
  }
  return map;
}

// -- cached map --------------------------------------------------------------------------------

function statSig(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return ''; // missing file → empty signature (still a valid, stable key)
  }
}

// Build the merged convId→title map for a home dir. The cli db is applied first, then the proto hub
// overrides it, so a title present in BOTH sources resolves to the hub's (agy-app preferred). Both
// helpers only ever contribute non-empty titles, so a missing entry in one source never blanks the
// other. Never throws.
function buildMap(homeDir) {
  const map = new Map();
  try {
    const cli = parseCliDb(path.join(homeDir, ...CLI_DB_PARTS));
    for (const [k, v] of cli) map.set(k, v);
  } catch {
    /* best-effort */
  }
  try {
    const buf = fs.readFileSync(path.join(homeDir, ...HUB_PARTS));
    const hub = parseHubProto(buf);
    for (const [k, v] of hub) map.set(k, v);
  } catch {
    /* best-effort */
  }
  return map;
}

// Single-slot cache: the production hot path uses exactly one home dir. Rebuilds only when a source
// file's mtime/size changes, and at most once per MIN_REFRESH_MS even while the hub is rewritten
// live. A different home dir (tests / verification) simply forces a rebuild.
let cache = { homeDir: null, key: null, map: new Map(), builtAtMs: 0 };

function ensureMap(homeDir) {
  const now = Date.now();
  if (cache.homeDir === homeDir && cache.key !== null && now - cache.builtAtMs < MIN_REFRESH_MS) {
    return cache.map;
  }
  const key = `${statSig(path.join(homeDir, ...HUB_PARTS))}|${statSig(path.join(homeDir, ...CLI_DB_PARTS))}`;
  if (cache.homeDir === homeDir && cache.key === key) {
    cache.builtAtMs = now; // unchanged files → keep the map, refresh the throttle window
    return cache.map;
  }
  let map;
  try {
    map = buildMap(homeDir);
  } catch {
    map = new Map();
  }
  cache = { homeDir, key, map, builtAtMs: now };
  return map;
}

/**
 * titleForConversation(conversationId, homeDir?) → the human chat title for an agy conversation, or
 * '' if unknown. Backed by a cached convId→title map (invalidated by the .pb/.db mtime). Never throws.
 */
function titleForConversation(conversationId, homeDir = os.homedir()) {
  try {
    const id = String(conversationId || '').trim().toLowerCase();
    if (!id) return '';
    return ensureMap(homeDir).get(id) || '';
  } catch {
    return '';
  }
}

// Drop the cache (tests / long-lived processes that want to force a re-read).
function clearCache() {
  cache = { homeDir: null, key: null, map: new Map(), builtAtMs: 0 };
}

module.exports = {
  titleForConversation,
  parseHubProto,
  parseCliDb,
  buildMap,
  clearCache,
  SQLITE_BIN,
};
