'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const RELEASED_WAKELOCK_RE =
  /\[ComposerWakelockManager\]\s+Released\s+wakelock\b.*reason="([^"]+)".*composerId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const ACQUIRED_WAKELOCK_RE =
  /\[ComposerWakelockManager\]\s+Acquired\s+wakelock\b.*reason="([^"]+)".*composerId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const PERMISSION_REQUEST_REASON = 'user-approval-requested';
const GENERATION_START_REASON = 'agent-loop';
const GENERATION_END_REASON = 'generation-ended';
const PERMISSION_CLEAR_REASONS = new Set(['agent-loop-resumed', GENERATION_END_REASON]);

function defaultCursorLogsRoot(override = '') {
  const root = String(override || process.env.CURSOR_LOGS_ROOT || '').trim();
  if (root) return path.resolve(root);
  return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'logs');
}

function listRendererLogPaths(logsRoot) {
  const out = [];
  if (!fs.existsSync(logsRoot)) return out;
  let sessionEntries = [];
  try {
    sessionEntries = fs.readdirSync(logsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const sessionEntry of sessionEntries) {
    const sessionDir = path.join(logsRoot, sessionEntry.name);
    let windowEntries = [];
    try {
      windowEntries = fs.readdirSync(sessionDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const windowEntry of windowEntries) {
      if (!windowEntry.name.startsWith('window')) continue;
      const rendererPath = path.join(sessionDir, windowEntry.name, 'renderer.log');
      if (fs.existsSync(rendererPath)) out.push(rendererPath);
    }
  }
  return out.sort();
}

function parseWakelockLine(line) {
  const text = String(line || '');
  let match = text.match(RELEASED_WAKELOCK_RE);
  if (match) {
    return {
      action: 'released',
      reason: match[1],
      conversation_id: match[2].toLowerCase(),
    };
  }
  match = text.match(ACQUIRED_WAKELOCK_RE);
  if (match) {
    return {
      action: 'acquired',
      reason: match[1],
      conversation_id: match[2].toLowerCase(),
    };
  }
  return null;
}

function clearReasonForWakelock(parsed) {
  if (parsed.action === 'acquired' && parsed.reason === 'agent-loop-resumed') return 'approved';
  if (parsed.action === 'released' && parsed.reason === GENERATION_END_REASON) return 'generation_ended';
  return '';
}

function baseWakelockEvent(parsed, meta = {}) {
  return {
    conversation_id: parsed.conversation_id,
    composer_id: parsed.conversation_id,
    wakelock_action: parsed.action,
    wakelock_reason: parsed.reason,
    renderer_log_path: meta.renderer_log_path || '',
    log_line_preview: meta.log_line_preview || '',
  };
}

function pushPermissionCleared(out, parsed, pendingByConversation, meta, clearReason) {
  const conversationId = parsed.conversation_id;
  if (!pendingByConversation.has(conversationId)) return;
  pendingByConversation.delete(conversationId);
  out.push({
    type: 'permission_cleared',
    ...baseWakelockEvent(parsed, meta),
    clear_reason: clearReason,
  });
}

/**
 * Apply one parsed wakelock line to pending state and return probe events to emit.
 * @param {object} parsed from parseWakelockLine
 * @param {Map<string, object>} pendingByConversation
 * @param {object} meta renderer_log_path, log_line_preview
 * @returns {object[]}
 */
function wakelockEventsFromParsed(parsed, pendingByConversation, meta = {}) {
  if (!parsed?.conversation_id) return [];
  const out = [];
  const conversationId = parsed.conversation_id;

  if (parsed.action === 'acquired' && parsed.reason === GENERATION_START_REASON) {
    out.push({
      type: 'generation_started',
      ...baseWakelockEvent(parsed, meta),
    });
    return out;
  }

  if (parsed.action === 'released' && parsed.reason === PERMISSION_REQUEST_REASON) {
    if (!pendingByConversation.has(conversationId)) {
      pendingByConversation.set(conversationId, {
        requested_reason: parsed.reason,
        renderer_log_path: meta.renderer_log_path || '',
      });
      out.push({
        type: 'permission_requested',
        ...baseWakelockEvent(parsed, meta),
      });
    }
    return out;
  }

  if (parsed.action === 'released' && parsed.reason === GENERATION_END_REASON) {
    pushPermissionCleared(out, parsed, pendingByConversation, meta, 'generation_ended');
    out.push({
      type: 'generation_ended',
      ...baseWakelockEvent(parsed, meta),
    });
    return out;
  }

  const clearReason = clearReasonForWakelock(parsed);
  if (!clearReason || !PERMISSION_CLEAR_REASONS.has(parsed.reason)) return out;
  pushPermissionCleared(out, parsed, pendingByConversation, meta, clearReason);
  return out;
}

function oneLinePreview(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function watchConversationIds(wt) {
  const ids = new Set();
  const primary = String(wt?.conversation_id || wt?.run_id || '').trim().toLowerCase();
  if (primary) ids.add(primary);
  const transcriptBase = path.basename(wt?.transcript_path || '', '.jsonl').trim().toLowerCase();
  if (transcriptBase) ids.add(transcriptBase);
  return ids;
}

/** True while renderer.log still has an uncleared user-approval-requested for this watch. */
function watchMatchesPendingPermission(wt, pendingByConversation) {
  if (!wt || !pendingByConversation?.size) return false;
  for (const id of watchConversationIds(wt)) {
    if (pendingByConversation.has(id)) return true;
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} [opts.logsRoot]
 * @param {() => string} [opts.nowIso]
 * @param {(line: string) => object|null} [opts.parseLine]
 */
function createRendererPermissionProbe(opts = {}) {
  const logsRoot = defaultCursorLogsRoot(opts.logsRoot || '');
  const nowIso = typeof opts.nowIso === 'function' ? opts.nowIso : () => new Date().toISOString();
  const parseLine = typeof opts.parseLine === 'function' ? opts.parseLine : parseWakelockLine;

  /** @type {Map<string, number>} */
  const fileOffsets = new Map();
  /** @type {Map<string, string>} */
  const lineCarry = new Map();
  /** @type {Map<string, object>} */
  const pendingByConversation = new Map();
  /** rendererLogPath → composerId for the conversation currently holding an agent-loop wakelock */
  const activeComposerByLogPath = new Map();

  async function init() {
    const paths = listRendererLogPaths(logsRoot);
    fileOffsets.clear();
    lineCarry.clear();
    for (const logPath of paths) {
      try {
        const st = await fsp.stat(logPath);
        fileOffsets.set(logPath, st.size);
      } catch {
        // race: skip
      }
    }
    return {
      renderer_logs_root: logsRoot,
      renderer_log_count: paths.length,
      renderer_permission_baseline_ok: paths.length > 0,
      renderer_permission_pending_count: pendingByConversation.size,
    };
  }

  async function pollOnce(wrap) {
    const events = [];
    const paths = listRendererLogPaths(logsRoot);
    const seen = new Set(paths);

    for (const logPath of paths) {
      let st;
      try {
        st = await fsp.stat(logPath);
      } catch {
        continue;
      }

      let offset = fileOffsets.get(logPath);
      if (!Number.isFinite(offset)) offset = st.size;
      if (st.size < offset) offset = 0;

      if (st.size <= offset) {
        fileOffsets.set(logPath, offset);
        continue;
      }

      const bytesToRead = st.size - offset;
      const fd = await fsp.open(logPath, 'r');
      let chunk = '';
      try {
        const buf = Buffer.alloc(bytesToRead);
        await fd.read(buf, 0, bytesToRead, offset);
        chunk = buf.toString('utf8');
      } finally {
        await fd.close();
      }

      fileOffsets.set(logPath, st.size);
      const carry = lineCarry.get(logPath) || '';
      const text = carry + chunk;
      const lines = text.split('\n');
      const incomplete = text.endsWith('\n') ? '' : lines.pop() || '';
      lineCarry.set(logPath, incomplete);

      for (const line of lines) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        const rawEvents = wakelockEventsFromParsed(parsed, pendingByConversation, {
          renderer_log_path: logPath,
          log_line_preview: oneLinePreview(line),
        });
        for (const raw of rawEvents) {
          const event = { ...raw, t_iso: nowIso() };
          if (event.type === 'permission_requested' && event.conversation_id) {
            const pending = pendingByConversation.get(event.conversation_id);
            if (pending) {
              pending.t_iso = event.t_iso;
              pending.log_line_preview = event.log_line_preview || '';
              pending.wakelock_reason = event.wakelock_reason || '';
            }
          }
          if (event.type === 'generation_started' && event.conversation_id) {
            activeComposerByLogPath.set(logPath, event.conversation_id);
          }
          events.push(event);
          if (typeof wrap === 'function') wrap(event);
        }
      }
    }

    for (const knownPath of [...fileOffsets.keys()]) {
      if (!seen.has(knownPath)) {
        fileOffsets.delete(knownPath);
        lineCarry.delete(knownPath);
      }
    }

    return events;
  }

  function getState() {
    return {
      renderer_logs_root: logsRoot,
      renderer_log_count: fileOffsets.size,
      renderer_permission_pending_count: pendingByConversation.size,
      renderer_permission_pending: [...pendingByConversation.keys()],
    };
  }

  function getPendingPermissionEvents() {
    return [...pendingByConversation.entries()].map(([conversationId, meta]) => ({
      type: 'permission_requested',
      conversation_id: conversationId,
      composer_id: conversationId,
      wakelock_action: 'released',
      wakelock_reason: meta?.wakelock_reason || PERMISSION_REQUEST_REASON,
      renderer_log_path: meta?.renderer_log_path || '',
      log_line_preview: meta?.log_line_preview || '',
      t_iso: meta?.t_iso || nowIso(),
      pending_snapshot: true,
    }));
  }

  return {
    init,
    pollOnce,
    getState,
    getPendingPermissionEvents,
    isPermissionPendingForWatch: (wt) => watchMatchesPendingPermission(wt, pendingByConversation),
    getActiveComposerIdForLogPath: (lp) => activeComposerByLogPath.get(lp) || '',
    listRendererLogPaths: () => listRendererLogPaths(logsRoot),
    pendingByConversation,
  };
}

module.exports = {
  defaultCursorLogsRoot,
  listRendererLogPaths,
  parseWakelockLine,
  wakelockEventsFromParsed,
  watchMatchesPendingPermission,
  createRendererPermissionProbe,
  PERMISSION_REQUEST_REASON,
  GENERATION_START_REASON,
  GENERATION_END_REASON,
};
