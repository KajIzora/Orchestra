const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  assertValidRemoteSource,
  createSshRunner,
} = require('./remote_cursor_tracker');

const CANCEL_RE = /Cancelling in-progress response for conversation ([0-9a-f-]{36})/i;
const CREATED_CONVERSATION_RE = /Created conversation ([0-9a-f-]{36})/i;
const CONTEXT_CANCELED_RE = /context canceled(?: by user)?/i;
const PERMISSION_REQUEST_RE = /Surfacing tool confirmation:\s*\"([^\"]+)\"\s*at step\s*(\d+)/i;
const PERMISSION_RESPONSE_RE =
  /Responding to tool confirmation:\s*convID=([0-9a-f-]{36}),\s*stepIdx=(\d+),\s*approved=(true|false)/i;
// How many of the newest cli-*.log files to tail for permission/cancel signals.
// Each concurrent agy-cli conversation writes its own log, so this must cover the
// number of agents that can be active at once. 3 was too low for the test harness,
// which launches a full wave of agy-cli jobs in parallel (--no-max): a gate/cancel
// scenario whose log fell outside the 3 newest never had its signal read, so its
// watch never cleared. Reads are incremental (offsets) and unchanged files are
// skipped, so a higher cap is cheap even for normal single-agent use.
const DEFAULT_MAX_FILES = 32;
const DEFAULT_MAX_APP_DBS = 5;
const DEFAULT_REMOTE_TIMEOUT_MS = 3000;
const AGY_APP_CANCEL_READ_MAX_BYTES = 512 * 1024;
const AGY_APP_PERMISSION_WAL_READ_MAX_BYTES = 512 * 1024;
const AGY_APP_PERMISSION_TOOL_TYPES = ['command', 'write_file'];
const DEFAULT_APP_LANGUAGE_SERVER_LOG = path.join(
  os.homedir(),
  'Library',
  'Logs',
  'Antigravity',
  'language_server.log'
);
const SQLITE_BIN = '/usr/bin/sqlite3';
const execFileAsync = promisify(execFile);

function getAgyCliLogDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'log');
}

function getAgyAppConversationsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'antigravity', 'conversations');
}

function getAgyCliConversationsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations');
}

function parseCliCancelSignals(chunk = '', options = {}) {
  const out = [];
  let latestConversationId = options.conversationId || '';
  for (const line of String(chunk || '').split('\n')) {
    const created = line.match(CREATED_CONVERSATION_RE);
    if (created) latestConversationId = created[1];
    const m = line.match(CANCEL_RE);
    if (m) {
      latestConversationId = m[1];
      out.push({
        kind: 'cancel_in_progress',
        conversationId: m[1],
        raw: line,
      });
      continue;
    }
    if (latestConversationId && CONTEXT_CANCELED_RE.test(line)) {
      out.push({
        kind: 'context_canceled',
        conversationId: latestConversationId,
        raw: line,
      });
    }
  }
  return out;
}

function latestCliConversationId(chunk = '') {
  let conversationId = '';
  for (const line of String(chunk || '').split('\n')) {
    const created = line.match(CREATED_CONVERSATION_RE);
    if (created) conversationId = created[1];
  }
  return conversationId;
}

function parseCliPermissionSignals(chunk = '') {
  const out = [];
  for (const line of String(chunk || '').split('\n')) {
    const req = line.match(PERMISSION_REQUEST_RE);
    if (req) {
      out.push({
        kind: 'permission_requested',
        tool_label: req[1],
        step_index: Number.parseInt(req[2], 10),
        raw: line,
      });
      continue;
    }
    const resp = line.match(PERMISSION_RESPONSE_RE);
    if (resp) {
      out.push({
        kind: 'permission_granted',
        conversationId: resp[1],
        step_index: Number.parseInt(resp[2], 10),
        approved: String(resp[3]).toLowerCase() === 'true',
        raw: line,
      });
    }
  }
  return out;
}

function parseAppLanguageServerCancelSignals(chunk = '') {
  const out = [];
  for (const line of String(chunk || '').split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    const cancelMatch = raw.match(/Cancelling in-progress response for conversation ([0-9a-f-]{36})/i);
    if (cancelMatch) {
      out.push({
        kind: 'cancel_in_progress',
        conversationId: cancelMatch[1],
        raw,
      });
      continue;
    }
    if (/context canceled(?: by user)?/i.test(raw)) {
      out.push({ kind: 'context_canceled', raw });
      continue;
    }
    if (/signal:\s*killed/i.test(raw) && /hook/i.test(raw)) {
      out.push({ kind: 'hook_killed', raw });
      continue;
    }
    if (/task-app-hooks_Stop_0_0": executing command/.test(raw)) {
      out.push({ kind: 'stop_hook_executing', raw });
    }
  }
  return out;
}

function readVarint(buf, pos) {
  let out = 0;
  let shift = 0;
  let i = pos;
  while (i < buf.length && shift <= 28) {
    const byte = buf[i];
    out |= (byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) return { value: out, pos: i };
    shift += 7;
  }
  return null;
}

function mostlyPrintable(text) {
  if (!text || text.length < 3) return false;
  let printable = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable += 1;
  }
  return printable / text.length > 0.85;
}

function parsePermissionBlobFields(buf, depth = 0) {
  const strings = [];
  let approved = false;
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key) break;
    pos = key.pos;
    const wire = key.value & 0x7;
    if (wire === 0) {
      const value = readVarint(buf, pos);
      if (!value) break;
      if (value.value === 1) approved = true;
      pos = value.pos;
      continue;
    }
    if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      pos = len.pos;
      const end = pos + len.value;
      if (end > buf.length) break;
      const slice = buf.subarray(pos, end);
      const text = slice.toString('utf8');
      if (mostlyPrintable(text)) strings.push(text);
      if (depth < 4) {
        const nested = parsePermissionBlobFields(slice, depth + 1);
        strings.push(...nested.strings);
        approved = approved || nested.approved;
      }
      pos = end;
      continue;
    }
    if (wire === 1) {
      pos += 8;
      continue;
    }
    if (wire === 5) {
      pos += 4;
      continue;
    }
    break;
  }
  return { strings, approved };
}

function parseAgyAppPermissionBlob(hex = '') {
  const clean = String(hex || '').trim();
  if (!clean || !/^[a-f0-9]+$/i.test(clean) || clean.length % 2 !== 0) return null;
  let buf;
  try {
    buf = Buffer.from(clean, 'hex');
  } catch {
    return null;
  }
  const parsed = parsePermissionBlobFields(buf);
  const strings = [...new Set(parsed.strings.map((s) => s.trim()).filter(Boolean))];
  const toolType = strings.find((s) => ['command', 'write_file'].includes(s)) || strings[0] || '';
  const detail = strings.find((s) => s !== toolType && (s.startsWith('/') || /\s/.test(s))) || '';
  if (!toolType && !detail) return null;
  return {
    tool_type: toolType,
    detail,
    approved: parsed.approved,
  };
}

// File-edit permission gates (write_to_file / edit_file) are NOT stored as a `permissions` blob like
// shell-command gates are — they are a step_type=5 step whose step_payload carries the tool call, and
// the gate is "open" while status=9 (awaiting the user). The payload is protobuf with an embedded JSON
// tool-args object; pull a tool name + target file out of the ASCII bits for display.
const AGY_APP_FILE_EDIT_TOOLS = ['write_to_file', 'edit_file', 'replace_in_file', 'create_file', 'apply_diff'];
const AGY_APP_FILE_EDIT_STEP_TYPE = 5;

function parseAgyAppFileEditGate(payloadHex = '') {
  const out = { tool_type: 'file_edit', detail: '' };
  const clean = String(payloadHex || '').trim();
  if (!clean || !/^[a-f0-9]+$/i.test(clean) || clean.length % 2 !== 0) return out;
  let text = '';
  try {
    text = Buffer.from(clean, 'hex').toString('utf8');
  } catch {
    return out;
  }
  const tool = AGY_APP_FILE_EDIT_TOOLS.find((t) => text.includes(t));
  if (tool) out.tool_type = tool;
  const target = text.match(/"TargetFile"\s*:\s*"([^"]+)"/);
  const summary = text.match(/"toolSummary"\s*:\s*"([^"]+)"/);
  out.detail = (target && target[1]) || (summary && summary[1]) || '';
  return out;
}

// Normalize one steps-table row into a permission signal, covering BOTH gate encodings:
//   - shell / command gates: a `permissions` blob whose approved flag drives requested vs granted
//   - file-edit gates: step_type=5 with NO blob; status=9 = awaiting the user (requested), else granted
// Returns null for rows that are not a gate, so a row reader can over-select (e.g. every step_type=5)
// and let this filter — non-gated writes never hit status=9, and the caller's request/grant dedup
// drops a row first seen already-granted.
function agyAppPermissionRowSignal(row) {
  if (row && row.permissions_hex) {
    const parsed = parseAgyAppPermissionBlob(row.permissions_hex);
    if (!parsed) return null;
    return {
      status: parsed.approved ? 'granted' : 'requested',
      tool_type: parsed.tool_type,
      detail: parsed.detail,
      approved: parsed.approved,
    };
  }
  if (row && Number.parseInt(row.step_type, 10) === AGY_APP_FILE_EDIT_STEP_TYPE) {
    const requested = Number.parseInt(row.status, 10) === 9;
    const fe = parseAgyAppFileEditGate(row.payload_hex);
    return { status: requested ? 'requested' : 'granted', tool_type: fe.tool_type, detail: fe.detail, approved: !requested };
  }
  return null;
}

function parseAgyAppPermissionBlobsFromBytes(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'latin1');
  const events = [];
  const seenAtOffset = new Set();

  for (const toolType of AGY_APP_PERMISSION_TOOL_TYPES) {
    const tag = Buffer.concat([Buffer.from([0x0a, toolType.length]), Buffer.from(toolType, 'utf8')]);
    let idx = 0;
    while (idx < buf.length) {
      const found = buf.indexOf(tag, idx);
      if (found === -1) break;
      idx = found + 1;
      if (seenAtOffset.has(found)) continue;
      seenAtOffset.add(found);

      let pos = found + tag.length;
      if (pos >= buf.length || buf[pos] !== 0x12) continue;
      const len = readVarint(buf, pos + 1);
      if (!len || len.value < 0) continue;
      const detailStart = len.pos;
      const detailEnd = detailStart + len.value;
      if (detailEnd > buf.length) continue;
      const detail = buf.subarray(detailStart, detailEnd).toString('utf8').trim();
      if (!detail) continue;
      const windowEnd = Math.min(buf.length, detailEnd + 32);
      const approved = buf.indexOf(Buffer.from([0x10, 0x01]), detailEnd, windowEnd) !== -1;
      events.push({
        kind: approved ? 'permission_granted' : 'permission_requested',
        tool_type: toolType,
        detail,
        approved,
        blob_offset: found,
      });
    }
  }

  return events;
}

async function listRecentCliLogs(homeDir = os.homedir(), maxFiles = DEFAULT_MAX_FILES) {
  const dir = getAgyCliLogDir(homeDir);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = entries
    .filter((ent) => ent.isFile() && /^cli-.*\.log$/i.test(ent.name))
    .map((ent) => path.join(dir, ent.name));
  const withStats = [];
  for (const file of files) {
    try {
      const st = await fsp.stat(file);
      withStats.push({ file, mtimeMs: st.mtimeMs || 0, size: st.size || 0 });
    } catch {
      // ignore racey file
    }
  }
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats.slice(0, maxFiles);
}

async function listRecentAgyConversationDbs(conversationsDir, maxFiles = DEFAULT_MAX_APP_DBS) {
  const dir = conversationsDir;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = entries
    .filter((ent) => ent.isFile() && /^[0-9a-f-]{36}\.db$/i.test(ent.name))
    .map((ent) => path.join(dir, ent.name));
  const withStats = [];
  for (const file of files) {
    try {
      const st = await fsp.stat(file);
      let mtimeMs = st.mtimeMs || 0;
      const wal = `${file}-wal`;
      try {
        const walSt = await fsp.stat(wal);
        mtimeMs = Math.max(mtimeMs, walSt.mtimeMs || 0);
      } catch {
        // WAL is absent once SQLite checkpoints the database.
      }
      withStats.push({
        file,
        conversationId: path.basename(file, '.db'),
        mtimeMs,
      });
    } catch {
      // ignore racey file
    }
  }
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats.slice(0, maxFiles);
}

async function listRecentAgyAppConversationDbs(homeDir = os.homedir(), maxFiles = DEFAULT_MAX_APP_DBS) {
  return listRecentAgyConversationDbs(getAgyAppConversationsDir(homeDir), maxFiles);
}

async function listRecentAgyCliConversationDbs(homeDir = os.homedir(), maxFiles = DEFAULT_MAX_FILES) {
  return listRecentAgyConversationDbs(getAgyCliConversationsDir(homeDir), maxFiles);
}

async function isReadableSqliteDb(dbPath) {
  try {
    const st = await fsp.stat(dbPath);
    if (!st.size || st.size < 16) return false;
    const fh = await fsp.open(dbPath, 'r');
    try {
      const buf = Buffer.alloc(16);
      await fh.read(buf, 0, 16, 0);
      return buf.toString('utf8', 0, 16) === 'SQLite format 3\u0000';
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

async function readAgyAppPermissionRows(dbPath) {
  // Select shell/command gates (a permissions blob) AND file-edit gates (step_type=5, no blob — the
  // gate lives in status=9 + step_payload). agyAppPermissionRowSignal() filters non-gate rows.
  const sql =
    'SELECT idx, step_type, status, hex(permissions) AS permissions_hex, hex(step_payload) AS payload_hex ' +
    'FROM steps WHERE (permissions IS NOT NULL AND length(permissions) > 0) OR step_type = 5 ORDER BY idx ASC;';
  const { stdout } = await execFileAsync(SQLITE_BIN, ['-readonly', '-json', dbPath, sql], {
    timeout: 2500,
  });
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return [];
  const rows = JSON.parse(trimmed);
  return Array.isArray(rows) ? rows : [];
}

async function readFileRange(file, startOffset, endOffset) {
  const len = Math.max(0, endOffset - startOffset);
  if (!len) return Buffer.alloc(0);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, startOffset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function readLatestCliConversationId(file, endOffset) {
  const maxBytes = 512 * 1024;
  const end = Number.isFinite(endOffset) && endOffset > 0 ? endOffset : 0;
  const start = Math.max(0, end - maxBytes);
  try {
    const buf = await readFileRange(file, start, end);
    return latestCliConversationId(buf.toString('utf8'));
  } catch {
    return '';
  }
}

/**
 * Incrementally scan local agy CLI logs for cancel lines.
 *
 * @param {Map<string, number>} offsets
 * @param {{ homeDir?: string, maxFiles?: number }} [options]
 */
async function readLocalAgyCliCancelSignals(offsets, options = {}) {
  const state = offsets instanceof Map ? offsets : new Map();
  const files = await listRecentCliLogs(options.homeDir, options.maxFiles);
  const events = [];
  for (const item of files) {
    const known = state.get(item.file);
    const startOffset = Number.isFinite(known) ? known : item.size;
    if (item.size <= startOffset) {
      state.set(item.file, item.size);
      continue;
    }
    let chunk = '';
    try {
      const fh = await fsp.open(item.file, 'r');
      try {
        const len = item.size - startOffset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, startOffset);
        chunk = buf.slice(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    state.set(item.file, item.size);
    const fallbackConversationId = CONTEXT_CANCELED_RE.test(chunk)
      ? await readLatestCliConversationId(item.file, item.size)
      : '';
    for (const signal of parseCliCancelSignals(chunk, { conversationId: fallbackConversationId })) {
      events.push({ ...signal, source_file: item.file });
    }
  }
  return { events };
}

function offsetMapToJson(state) {
  const out = {};
  if (!(state instanceof Map)) return out;
  for (const [file, offset] of state.entries()) {
    if (typeof file !== 'string' || !file) continue;
    const n = Number(offset);
    if (!Number.isFinite(n) || n < 0) continue;
    out[file] = Math.floor(n);
  }
  return out;
}

/**
 * Incrementally scan remote agy CLI logs for cancel lines.
 *
 * @param {{ host: string, projects_root?: string }} remote
 * @param {Map<string, number>} offsets
 * @param {{ runSsh?: Function, timeoutMs?: number, maxFiles?: number }} [options]
 */
async function readRemoteAgyCliCancelSignals(remote, offsets, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const state = offsets instanceof Map ? offsets : new Map();
  const runSsh = options.runSsh || createSshRunner();
  const maxFiles =
    Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const offsetsJson = JSON.stringify(offsetMapToJson(state));
  const cmd =
    `python3 - <<'PY'\n` +
    `import glob, json, os, re\n` +
    `offsets = json.loads(${JSON.stringify(offsetsJson)})\n` +
    `max_files = ${JSON.stringify(maxFiles)}\n` +
    `root = os.path.expanduser('~/.gemini/antigravity-cli/log')\n` +
    `files = []\n` +
    `for p in glob.glob(os.path.join(root, 'cli-*.log')):\n` +
    `  try:\n` +
    `    st = os.stat(p)\n` +
    `  except OSError:\n` +
    `    continue\n` +
    `  files.append({'file': p, 'mtime_ms': int(st.st_mtime * 1000), 'size': int(st.st_size)})\n` +
    `files.sort(key=lambda x: x['mtime_ms'], reverse=True)\n` +
    `chunks = []\n` +
    `new_offsets = {}\n` +
    `for item in files[:max_files]:\n` +
    `  p = item['file']\n` +
    `  size = item['size']\n` +
    `  try:\n` +
    `    start = int(offsets.get(p, size))\n` +
    `  except Exception:\n` +
    `    start = size\n` +
    `  if start < 0:\n` +
    `    start = size\n` +
    `  if size <= start:\n` +
    `    new_offsets[p] = size\n` +
    `    continue\n` +
    `  try:\n` +
    `    with open(p, 'r', encoding='utf-8', errors='ignore') as f:\n` +
    `      f.seek(start)\n` +
    `      data = f.read(size - start)\n` +
    `  except OSError:\n` +
    `    new_offsets[p] = size\n` +
    `    continue\n` +
    `  conversation_id = ''\n` +
    `  if 'context canceled' in data.lower():\n` +
    `    try:\n` +
    `      with open(p, 'r', encoding='utf-8', errors='ignore') as f:\n` +
    `        f.seek(max(0, size - 512 * 1024))\n` +
    `        prefix = f.read(min(size, 512 * 1024))\n` +
    `      for m in re.finditer(r'Created conversation ([0-9a-f-]{36})', prefix, re.I):\n` +
    `        conversation_id = m.group(1)\n` +
    `    except OSError:\n` +
    `      conversation_id = ''\n` +
    `  new_offsets[p] = size\n` +
    `  if data:\n` +
    `    chunks.append({'file': p, 'text': data, 'conversation_id': conversation_id})\n` +
    `print(json.dumps({'offsets': new_offsets, 'chunks': chunks}))\n` +
    `PY`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
  const parsed = JSON.parse(String(stdout || '{}'));
  const events = [];
  if (parsed.offsets && typeof parsed.offsets === 'object') {
    for (const [file, offset] of Object.entries(parsed.offsets)) {
      const n = Number(offset);
      if (typeof file === 'string' && file && Number.isFinite(n) && n >= 0) {
        state.set(file, Math.floor(n));
      }
    }
  }
  for (const chunk of Array.isArray(parsed.chunks) ? parsed.chunks : []) {
    const file = typeof chunk?.file === 'string' ? chunk.file : '';
    for (const signal of parseCliCancelSignals(chunk?.text || '', { conversationId: chunk?.conversation_id || '' })) {
      events.push({ ...signal, source_file: file, source_host: cfg.host });
    }
  }
  return { events };
}

/**
 * Incrementally scan remote agy CLI logs for permission request/response lines.
 *
 * @param {{ host: string, projects_root?: string }} remote
 * @param {Map<string, number>} offsets
 * @param {{ runSsh?: Function, timeoutMs?: number, maxFiles?: number }} [options]
 */
async function readRemoteAgyCliPermissionSignals(remote, offsets, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const state = offsets instanceof Map ? offsets : new Map();
  const runSsh = options.runSsh || createSshRunner();
  const maxFiles =
    Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const offsetsJson = JSON.stringify(offsetMapToJson(state));
  const cmd =
    `python3 - <<'PY'\n` +
    `import glob, json, os\n` +
    `offsets = json.loads(${JSON.stringify(offsetsJson)})\n` +
    `max_files = ${JSON.stringify(maxFiles)}\n` +
    `root = os.path.expanduser('~/.gemini/antigravity-cli/log')\n` +
    `files = []\n` +
    `for p in glob.glob(os.path.join(root, 'cli-*.log')):\n` +
    `  try:\n` +
    `    st = os.stat(p)\n` +
    `  except OSError:\n` +
    `    continue\n` +
    `  files.append({'file': p, 'mtime_ms': int(st.st_mtime * 1000), 'size': int(st.st_size)})\n` +
    `files.sort(key=lambda x: x['mtime_ms'], reverse=True)\n` +
    `chunks = []\n` +
    `new_offsets = {}\n` +
    `for item in files[:max_files]:\n` +
    `  p = item['file']\n` +
    `  size = item['size']\n` +
    `  try:\n` +
    `    start = int(offsets.get(p, size))\n` +
    `  except Exception:\n` +
    `    start = size\n` +
    `  if start < 0:\n` +
    `    start = size\n` +
    `  if size <= start:\n` +
    `    new_offsets[p] = size\n` +
    `    continue\n` +
    `  try:\n` +
    `    with open(p, 'r', encoding='utf-8', errors='ignore') as f:\n` +
    `      f.seek(start)\n` +
    `      data = f.read(size - start)\n` +
    `  except OSError:\n` +
    `    new_offsets[p] = size\n` +
    `    continue\n` +
    `  new_offsets[p] = size\n` +
    `  if data:\n` +
    `    chunks.append({'file': p, 'text': data})\n` +
    `print(json.dumps({'offsets': new_offsets, 'chunks': chunks}))\n` +
    `PY`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
  const parsed = JSON.parse(String(stdout || '{}'));
  const events = [];
  if (parsed.offsets && typeof parsed.offsets === 'object') {
    for (const [file, offset] of Object.entries(parsed.offsets)) {
      const n = Number(offset);
      if (typeof file === 'string' && file && Number.isFinite(n) && n >= 0) {
        state.set(file, Math.floor(n));
      }
    }
  }
  for (const chunk of Array.isArray(parsed.chunks) ? parsed.chunks : []) {
    const file = typeof chunk?.file === 'string' ? chunk.file : '';
    for (const signal of parseCliPermissionSignals(chunk?.text || '')) {
      events.push({ ...signal, source_file: file, source_host: cfg.host });
    }
  }
  return { events };
}

/**
 * Incrementally scan local agy CLI logs for permission request/response lines.
 *
 * @param {Map<string, number>} offsets
 * @param {{ homeDir?: string, maxFiles?: number }} [options]
 */
async function readLocalAgyCliPermissionSignals(offsets, options = {}) {
  const state = offsets instanceof Map ? offsets : new Map();
  const files = await listRecentCliLogs(options.homeDir, options.maxFiles);
  const events = [];
  for (const item of files) {
    const known = state.get(item.file);
    const startOffset = Number.isFinite(known) ? known : item.size;
    if (item.size <= startOffset) {
      state.set(item.file, item.size);
      continue;
    }
    let chunk = '';
    try {
      const fh = await fsp.open(item.file, 'r');
      try {
        const len = item.size - startOffset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, startOffset);
        chunk = buf.slice(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    state.set(item.file, item.size);
    const signals = parseCliPermissionSignals(chunk);
    // "Surfacing tool confirmation" lines carry no conversation id, so resolve it
    // from the log file they came from (same as the cancel path). Without this the
    // server has to guess which conversation the permission belongs to, which
    // misroutes when several agy-cli runs are active at once.
    let fileConversationId = '';
    if (signals.some((s) => s.kind === 'permission_requested' && !s.conversationId)) {
      fileConversationId = await readLatestCliConversationId(item.file, item.size);
    }
    for (const signal of signals) {
      events.push({
        ...signal,
        conversationId: signal.conversationId || fileConversationId,
        source_file: item.file,
      });
    }
  }
  return { events };
}

async function readLocalAgyAppCancelSignals(state, options = {}) {
  const seen = state instanceof Map ? state : new Map();
  const files = await listRecentAgyAppConversationDbs(options.homeDir, options.maxFiles);
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0;
  const initialReadMaxBytes =
    Number.isInteger(options.initialReadMaxBytes) && options.initialReadMaxBytes > 0
      ? options.initialReadMaxBytes
      : AGY_APP_CANCEL_READ_MAX_BYTES;
  const events = [];
  for (const item of files) {
    const targets = [
      { file: item.file, kind: 'db' },
      { file: `${item.file}-wal`, kind: 'wal' },
    ];
    for (const target of targets) {
      let st;
      try {
        st = await fsp.stat(target.file);
      } catch {
        continue;
      }
      const previous = seen.get(target.file);
      const entry =
        previous && typeof previous === 'object'
          ? previous
          : { offset: Number.isFinite(previous) ? previous : st.size, emitted: new Set() };
      if (!(entry.emitted instanceof Set)) entry.emitted = new Set();
      if (!Number.isFinite(entry.offset)) entry.offset = st.size;
      if (!previous) {
        const shouldScanNewFile = sinceMs && st.mtimeMs >= sinceMs - 1000;
        seen.set(target.file, entry);
        if (!shouldScanNewFile) continue;
      }
      if (st.size < entry.offset) {
        entry.offset = st.size;
        entry.emitted.clear();
        seen.set(target.file, entry);
        continue;
      }
      const startOffset = previous ? entry.offset : Math.max(0, st.size - initialReadMaxBytes);
      if (previous && st.size <= entry.offset) {
        seen.set(target.file, entry);
        continue;
      }
      let chunk;
      try {
        chunk = await readFileRange(target.file, startOffset, st.size);
      } catch {
        continue;
      }
      entry.offset = st.size;
      seen.set(target.file, entry);
      const text = chunk.toString('latin1');
      if (!/context canceled(?: by user)?/i.test(text)) continue;
      const key = `context_canceled:${target.kind}:${entry.offset}`;
      if (entry.emitted.has(key)) continue;
      entry.emitted.add(key);
      events.push({
        kind: 'context_canceled_by_user',
        conversationId: item.conversationId,
        source_file: target.file,
        source: target.kind,
      });
    }
  }
  return { events };
}

async function readLocalAgyAppLanguageServerCancelSignals(state, options = {}) {
  const file =
    typeof options.logPath === 'string' && options.logPath.trim()
      ? options.logPath.trim()
      : DEFAULT_APP_LANGUAGE_SERVER_LOG;
  const holder = state && typeof state === 'object' ? state : {};
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { events: [] };
  }
  if (!Number.isFinite(holder.offset)) holder.offset = st.size;
  if (st.size < holder.offset) holder.offset = st.size;
  if (st.size <= holder.offset) return { events: [] };
  let chunk = '';
  try {
    const buf = await readFileRange(file, holder.offset, st.size);
    chunk = buf.toString('utf8');
  } catch {
    holder.offset = st.size;
    return { events: [] };
  }
  holder.offset = st.size;
  const events = parseAppLanguageServerCancelSignals(chunk).map((event) => ({
    ...event,
    source_file: file,
  }));
  return { events };
}

/**
 * Poll recent Antigravity app conversation DBs for permission rows.
 *
 * @param {Map<string, string>} state
 * @param {{ homeDir?: string, maxFiles?: number, conversationIds?: Iterable<string> }} [options]
 */
async function readLocalAgyDbPermissionSignals(state, options = {}) {
  const seen = state instanceof Map ? state : new Map();
  const conversationsDir =
    typeof options.conversationsDir === 'string' && options.conversationsDir.trim()
      ? options.conversationsDir.trim()
      : getAgyAppConversationsDir(options.homeDir);
  const allFiles = await listRecentAgyConversationDbs(conversationsDir, options.maxFiles);
  // Optional per-conversation scope: when the caller knows which conversation(s) belong to it
  // (e.g. one signal:session child), restrict the scan to those DBs. Without this, every concurrent
  // caller re-reads every conversation's DB+WAL each poll; past a handful of agents that overruns
  // the poll interval and the gate (permission/question) is detected late or missed. Empty/absent
  // ⇒ scan all (unchanged single-agent behavior).
  const onlyConvIds =
    options.conversationIds && typeof options.conversationIds[Symbol.iterator] === 'function'
      ? new Set(options.conversationIds)
      : null;
  const files =
    onlyConvIds && onlyConvIds.size
      ? allFiles.filter((item) => onlyConvIds.has(item.conversationId))
      : allFiles;
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0;
  const events = [];
  for (const item of files) {
    const walFile = `${item.file}-wal`;
    const walOffsetKey = `${walFile}::permission_wal_offset`;
    const walEmittedPrefix = `${walFile}::permission_wal_emitted::`;
    try {
      const st = await fsp.stat(walFile);
      const previousOffset = seen.get(walOffsetKey);
      const shouldScanNewWal = !Number.isFinite(previousOffset) && sinceMs && st.mtimeMs >= sinceMs - 1000;
      const startOffset = Number.isFinite(previousOffset)
        ? previousOffset
        : shouldScanNewWal
          ? Math.max(0, st.size - AGY_APP_PERMISSION_WAL_READ_MAX_BYTES)
          : st.size;
      if (st.size < startOffset) {
        seen.set(walOffsetKey, st.size);
      } else if (st.size > startOffset) {
        const readStart = Math.max(0, st.size - startOffset > AGY_APP_PERMISSION_WAL_READ_MAX_BYTES
          ? st.size - AGY_APP_PERMISSION_WAL_READ_MAX_BYTES
          : startOffset);
        const chunk = await readFileRange(walFile, readStart, st.size);
        seen.set(walOffsetKey, st.size);
        for (const parsed of parseAgyAppPermissionBlobsFromBytes(chunk)) {
          const dedupeKey = `${walEmittedPrefix}${parsed.kind}:${parsed.tool_type}:${parsed.detail}`;
          if (seen.has(dedupeKey)) continue;
          seen.set(dedupeKey, true);
          events.push({
            kind: parsed.kind,
            conversationId: item.conversationId,
            tool_type: parsed.tool_type,
            detail: parsed.detail,
            approved: parsed.approved,
            source_file: walFile,
            source: 'wal',
          });
        }
      } else {
        seen.set(walOffsetKey, st.size);
      }
    } catch {
      // WAL may be absent between checkpoints; SQLite row polling below is still authoritative.
    }

    let rows = [];
    try {
      if (await isReadableSqliteDb(item.file)) {
        rows = await readAgyAppPermissionRows(item.file);
      }
    } catch {
      continue;
    }
    for (const row of rows) {
      const stepIndex = Number.parseInt(row.idx, 10);
      if (!Number.isInteger(stepIndex)) continue;
      const sig = agyAppPermissionRowSignal(row);
      if (!sig) continue;
      const key = `${item.file}::${stepIndex}`;
      const previous = seen.get(key);
      seen.set(key, sig.status);
      if (previous === sig.status) continue;
      if (!previous && sig.status === 'granted') continue;
      events.push({
        kind: sig.status === 'granted' ? 'permission_granted' : 'permission_requested',
        conversationId: item.conversationId,
        step_index: stepIndex,
        tool_type: sig.tool_type,
        detail: sig.detail,
        approved: sig.approved,
        source_file: item.file,
      });
    }
  }
  return { events };
}

async function readLocalAgyAppPermissionSignals(state, options = {}) {
  return readLocalAgyDbPermissionSignals(state, {
    ...options,
    conversationsDir: getAgyAppConversationsDir(options.homeDir),
  });
}

async function readLocalAgyCliDbPermissionSignals(state, options = {}) {
  return readLocalAgyDbPermissionSignals(state, {
    ...options,
    maxFiles: Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES,
    conversationsDir: getAgyCliConversationsDir(options.homeDir),
  });
}

/**
 * Poll remote agy-cli conversation DBs for permission rows/WAL bytes.
 *
 * The remote side only returns raw changed data. Local JS keeps the same parser/dedupe
 * behavior as local DB polling, so local and SSH agy-cli permission semantics stay aligned.
 */
async function readRemoteAgyCliDbPermissionSignals(remote, state, options = {}) {
  const cfg = assertValidRemoteSource(remote);
  const seen = state instanceof Map ? state : new Map();
  const runSsh = options.runSsh || createSshRunner();
  const maxFiles =
    Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES;
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0;
  const offsetsJson = JSON.stringify(offsetMapToJson(seen));
  const emitted = {};
  for (const [key, value] of seen.entries()) {
    if (typeof key === 'string' && key.includes('::permission_wal_emitted::') && value === true) {
      emitted[key] = true;
    }
  }
  const emittedJson = JSON.stringify(emitted);
  const cmd =
    `python3 - <<'PY'\n` +
    `import binascii, glob, json, os, sqlite3\n` +
    `offsets = json.loads(${JSON.stringify(offsetsJson)})\n` +
    `emitted = json.loads(${JSON.stringify(emittedJson)})\n` +
    `max_files = ${JSON.stringify(maxFiles)}\n` +
    `since_ms = ${JSON.stringify(sinceMs)}\n` +
    `wal_read_max = ${JSON.stringify(AGY_APP_PERMISSION_WAL_READ_MAX_BYTES)}\n` +
    `root = os.path.expanduser('~/.gemini/antigravity-cli/conversations')\n` +
    `files = []\n` +
    `for p in glob.glob(os.path.join(root, '*.db')):\n` +
    `  base = os.path.basename(p)[:-3]\n` +
    `  if len(base) != 36:\n` +
    `    continue\n` +
    `  try:\n` +
    `    st = os.stat(p)\n` +
    `    mtime_ms = int(st.st_mtime * 1000)\n` +
    `    wal = p + '-wal'\n` +
    `    try:\n` +
    `      wst = os.stat(wal)\n` +
    `      mtime_ms = max(mtime_ms, int(wst.st_mtime * 1000))\n` +
    `    except OSError:\n` +
    `      pass\n` +
    `    files.append({'file': p, 'conversationId': base, 'mtime_ms': mtime_ms})\n` +
    `  except OSError:\n` +
    `    pass\n` +
    `files.sort(key=lambda x: x['mtime_ms'], reverse=True)\n` +
    `out = {'offsets': {}, 'rows': [], 'wal_chunks': []}\n` +
    `for item in files[:max_files]:\n` +
    `  db = item['file']\n` +
    `  cid = item['conversationId']\n` +
    `  wal = db + '-wal'\n` +
    `  wal_key = wal + '::permission_wal_offset'\n` +
    `  try:\n` +
    `    st = os.stat(wal)\n` +
    `    prev = offsets.get(wal_key)\n` +
    `    prev_num = int(prev) if isinstance(prev, (int, float, str)) and str(prev).lstrip('-').isdigit() else None\n` +
    `    should_scan_new = prev_num is None and since_ms and int(st.st_mtime * 1000) >= since_ms - 1000\n` +
    `    start = prev_num if prev_num is not None else (max(0, int(st.st_size) - wal_read_max) if should_scan_new else int(st.st_size))\n` +
    `    if int(st.st_size) < start:\n` +
    `      out['offsets'][wal_key] = int(st.st_size)\n` +
    `    elif int(st.st_size) > start:\n` +
    `      read_start = max(0, int(st.st_size) - wal_read_max) if int(st.st_size) - start > wal_read_max else start\n` +
    `      with open(wal, 'rb') as f:\n` +
    `        f.seek(read_start)\n` +
    `        chunk = f.read(int(st.st_size) - read_start)\n` +
    `      out['offsets'][wal_key] = int(st.st_size)\n` +
    `      out['wal_chunks'].append({'file': wal, 'conversationId': cid, 'hex': binascii.hexlify(chunk).decode('ascii')})\n` +
    `    else:\n` +
    `      out['offsets'][wal_key] = int(st.st_size)\n` +
    `  except OSError:\n` +
    `    pass\n` +
    `  try:\n` +
    `    uri = 'file:' + db + '?mode=ro'\n` +
    `    conn = sqlite3.connect(uri, uri=True, timeout=0.1)\n` +
    `    try:\n` +
    `      cur = conn.execute('SELECT idx, step_type, status, hex(permissions) AS permissions_hex, hex(step_payload) AS payload_hex FROM steps WHERE (permissions IS NOT NULL AND length(permissions) > 0) OR step_type = 5 ORDER BY idx ASC')\n` +
    `      for idx, step_type, status, permissions_hex, payload_hex in cur.fetchall():\n` +
    `        out['rows'].append({'file': db, 'conversationId': cid, 'idx': idx, 'step_type': step_type, 'status': status, 'permissions_hex': permissions_hex or '', 'payload_hex': payload_hex or ''})\n` +
    `    finally:\n` +
    `      conn.close()\n` +
    `  except Exception:\n` +
    `    pass\n` +
    `print(json.dumps(out))\n` +
    `PY`;
  const stdout = await runSsh(cfg.host, cmd, options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
  const parsed = JSON.parse(String(stdout || '{}'));
  if (parsed.offsets && typeof parsed.offsets === 'object') {
    for (const [key, offset] of Object.entries(parsed.offsets)) {
      const n = Number(offset);
      if (typeof key === 'string' && key && Number.isFinite(n) && n >= 0) {
        seen.set(key, Math.floor(n));
      }
    }
  }

  const events = [];
  for (const chunk of Array.isArray(parsed.wal_chunks) ? parsed.wal_chunks : []) {
    const file = typeof chunk?.file === 'string' ? chunk.file : '';
    const conversationId = typeof chunk?.conversationId === 'string' ? chunk.conversationId : '';
    let buf = Buffer.alloc(0);
    try {
      buf = Buffer.from(String(chunk?.hex || ''), 'hex');
    } catch {
      buf = Buffer.alloc(0);
    }
    for (const parsedPermission of parseAgyAppPermissionBlobsFromBytes(buf)) {
      const dedupeKey = `${file}::permission_wal_emitted::${parsedPermission.kind}:${parsedPermission.tool_type}:${parsedPermission.detail}`;
      if (seen.has(dedupeKey)) continue;
      seen.set(dedupeKey, true);
      events.push({
        kind: parsedPermission.kind,
        conversationId,
        tool_type: parsedPermission.tool_type,
        detail: parsedPermission.detail,
        approved: parsedPermission.approved,
        source_file: file,
        source: 'wal',
        source_host: cfg.host,
      });
    }
  }

  for (const row of Array.isArray(parsed.rows) ? parsed.rows : []) {
    const stepIndex = Number.parseInt(row.idx, 10);
    if (!Number.isInteger(stepIndex)) continue;
    const sig = agyAppPermissionRowSignal(row);
    if (!sig) continue;
    const file = typeof row.file === 'string' ? row.file : '';
    const key = `${file}::${stepIndex}`;
    const previous = seen.get(key);
    seen.set(key, sig.status);
    if (previous === sig.status) continue;
    if (!previous && sig.status === 'granted') continue;
    events.push({
      kind: sig.status === 'granted' ? 'permission_granted' : 'permission_requested',
      conversationId: row.conversationId || '',
      step_index: stepIndex,
      tool_type: sig.tool_type,
      detail: sig.detail,
      approved: sig.approved,
      source_file: file,
      source_host: cfg.host,
    });
  }

  return { events };
}

/**
 * True when the conversation DB still has at least one step with an unapproved permissions blob.
 * Used on watch-link and cancel guards so a pending prompt is not missed after the poll cursor
 * already recorded the request before the user linked tracking.
 */
async function agySessionHasPendingPermission(sessionId, options = {}) {
  const sid = String(sessionId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(sid)) return false;
  const conversationsDir =
    typeof options.conversationsDir === 'string' && options.conversationsDir.trim()
      ? options.conversationsDir.trim()
      : getAgyAppConversationsDir(options.homeDir);
  const dbPath = path.join(conversationsDir, `${sid}.db`);
  try {
    if (!(await isReadableSqliteDb(dbPath))) return false;
    const rows = await readAgyAppPermissionRows(dbPath);
    for (const row of rows) {
      const sig = agyAppPermissionRowSignal(row);
      if (sig && sig.status === 'requested') return true;
    }
  } catch {
    // missing DB or transient sqlite read error
  }
  return false;
}

async function agyAppSessionHasPendingPermission(sessionId, options = {}) {
  return agySessionHasPendingPermission(sessionId, {
    ...options,
    conversationsDir: getAgyAppConversationsDir(options.homeDir),
  });
}

async function agyCliSessionHasPendingPermission(sessionId, options = {}) {
  return agySessionHasPendingPermission(sessionId, {
    ...options,
    conversationsDir: getAgyCliConversationsDir(options.homeDir),
  });
}

module.exports = {
  getAgyCliLogDir,
  getAgyCliConversationsDir,
  getAgyAppConversationsDir,
  parseCliCancelSignals,
  latestCliConversationId,
  parseCliPermissionSignals,
  parseAppLanguageServerCancelSignals,
  parseAgyAppPermissionBlob,
  parseAgyAppFileEditGate,
  agyAppPermissionRowSignal,
  listRecentCliLogs,
  listRecentAgyCliConversationDbs,
  listRecentAgyAppConversationDbs,
  readLocalAgyCliCancelSignals,
  readRemoteAgyCliCancelSignals,
  readRemoteAgyCliPermissionSignals,
  readLocalAgyCliPermissionSignals,
  readLocalAgyCliDbPermissionSignals,
  readRemoteAgyCliDbPermissionSignals,
  readLocalAgyAppCancelSignals,
  readLocalAgyAppLanguageServerCancelSignals,
  readLocalAgyAppPermissionSignals,
  readLocalAgyDbPermissionSignals,
  agySessionHasPendingPermission,
  agyAppSessionHasPendingPermission,
  agyCliSessionHasPendingPermission,
};
