'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { defaultCursorLogsRoot } = require('./cursor_renderer_permission_probe');

// Shell permissions: requesting shell approval {"toolCallId":"tool_...","approvalMode":"ask-every-time",...}
const REQUESTING_RE = /Shell permissions: requesting shell approval \{.*?"toolCallId":"([^"]+)"/;
// Shell stream: approval gate allowed command {"toolCallId":"tool_..."}
const ALLOWED_RE = /Shell stream: approval gate allowed command \{.*?"toolCallId":"([^"]+)"/;

const EXEC_LOG_REL = path.join('exthost', 'anysphere.cursor-agent-exec', 'Cursor Agent Exec.log');

function listAgentExecLogPaths(logsRoot) {
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
      const execLogPath = path.join(sessionDir, windowEntry.name, EXEC_LOG_REL);
      if (fs.existsSync(execLogPath)) out.push(execLogPath);
    }
  }
  return out.sort();
}

function rendererLogPathForExecLog(execLogPath) {
  // exec log is at <windowDir>/exthost/anysphere.cursor-agent-exec/Cursor Agent Exec.log
  // renderer.log is at <windowDir>/renderer.log
  return path.join(path.dirname(path.dirname(path.dirname(execLogPath))), 'renderer.log');
}

function parseExecLine(line) {
  const text = String(line || '');
  let match = text.match(REQUESTING_RE);
  if (match) return { type: 'requesting', toolCallId: match[1] };
  match = text.match(ALLOWED_RE);
  if (match) return { type: 'allowed', toolCallId: match[1] };
  return null;
}

function watchConversationIds(wt) {
  const ids = new Set();
  const primary = String(wt?.conversation_id || wt?.run_id || '').trim().toLowerCase();
  if (primary) ids.add(primary);
  const transcriptBase = path.basename(wt?.transcript_path || '', '.jsonl').trim().toLowerCase();
  if (transcriptBase) ids.add(transcriptBase);
  return ids;
}

/**
 * Probe that detects shell permission gates from the Cursor Agent Exec extension host log.
 * Unlike the renderer probe (which only fires for main-agent permissions), this log covers
 * both main-agent and sub-agent shell permission requests, making it the universal source.
 *
 * Conversation resolution: the exec log lives at
 *   <session>/<window>/exthost/anysphere.cursor-agent-exec/Cursor Agent Exec.log
 * and the renderer.log for the same window is at
 *   <session>/<window>/renderer.log
 * The renderer probe tracks which composerId holds the agent-loop wakelock in each window,
 * so we ask it for the active composerId to get the conversation_id.
 *
 * @param {object} opts
 * @param {string} [opts.logsRoot]
 * @param {object} [opts.rendererProbe] - instance of createRendererPermissionProbe()
 * @param {() => string} [opts.nowIso]
 */
function createAgentExecPermissionProbe(opts = {}) {
  const logsRoot = defaultCursorLogsRoot(opts.logsRoot || '');
  const rendererProbe = opts.rendererProbe || null;
  const nowIso = typeof opts.nowIso === 'function' ? opts.nowIso : () => new Date().toISOString();

  /** @type {Map<string, number>} */
  const fileOffsets = new Map();
  /** @type {Map<string, string>} */
  const lineCarry = new Map();
  /**
   * conversationId → {toolCallId (latest), exec_log_path, t_iso}
   * @type {Map<string, object>}
   */
  const pendingByConversation = new Map();
  /**
   * toolCallId → conversationId  (reverse lookup for clearing)
   * @type {Map<string, string>}
   */
  const pendingByToolCallId = new Map();

  async function init() {
    const paths = listAgentExecLogPaths(logsRoot);
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
      agent_exec_logs_root: logsRoot,
      agent_exec_log_count: paths.length,
    };
  }

  async function pollOnce(wrap) {
    const events = [];
    const paths = listAgentExecLogPaths(logsRoot);
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

      const rendererLogPath = rendererLogPathForExecLog(logPath);

      for (const line of lines) {
        const parsed = parseExecLine(line);
        if (!parsed) continue;

        const { type, toolCallId } = parsed;

        if (type === 'requesting') {
          const conversationId = rendererProbe
            ? rendererProbe.getActiveComposerIdForLogPath(rendererLogPath)
            : '';
          if (!conversationId) continue; // can't resolve — composerId not yet seen in this window

          const existing = pendingByConversation.get(conversationId);
          if (existing) {
            // Already pending for this conversation — update toolCallId for correct clearing
            if (existing.toolCallId !== toolCallId) {
              pendingByToolCallId.delete(existing.toolCallId);
              existing.toolCallId = toolCallId;
              pendingByToolCallId.set(toolCallId, conversationId);
            }
          } else {
            const t_iso = nowIso();
            pendingByConversation.set(conversationId, { toolCallId, exec_log_path: logPath, t_iso });
            pendingByToolCallId.set(toolCallId, conversationId);
            const event = {
              type: 'permission_requested',
              conversation_id: conversationId,
              composer_id: conversationId,
              wakelock_action: '',
              wakelock_reason: '',
              tool_call_id: toolCallId,
              exec_log_path: logPath,
              renderer_log_path: rendererLogPath,
              t_iso,
              source: 'agent_exec',
            };
            events.push(event);
            if (typeof wrap === 'function') wrap(event);
          }
        } else if (type === 'allowed') {
          const conversationId = pendingByToolCallId.get(toolCallId);
          if (!conversationId) continue;

          pendingByToolCallId.delete(toolCallId);
          const meta = pendingByConversation.get(conversationId);
          if (!meta) continue;

          pendingByConversation.delete(conversationId);
          const event = {
            type: 'permission_cleared',
            conversation_id: conversationId,
            composer_id: conversationId,
            wakelock_action: '',
            wakelock_reason: '',
            tool_call_id: toolCallId,
            exec_log_path: logPath,
            renderer_log_path: rendererLogPath,
            clear_reason: 'approved',
            t_iso: nowIso(),
            source: 'agent_exec',
          };
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

  /**
   * Called externally (e.g. when renderer probe emits generation_ended) to clear any stale
   * pending entry for a conversation that has finished without an explicit approval signal.
   * Returns the permission_cleared event object if there was a pending entry, otherwise null.
   */
  function clearForConversation(conversationId, clearReason = 'generation_ended') {
    const cid = String(conversationId || '').trim().toLowerCase();
    if (!cid || !pendingByConversation.has(cid)) return null;
    const meta = pendingByConversation.get(cid);
    pendingByConversation.delete(cid);
    pendingByToolCallId.delete(meta.toolCallId || '');
    return {
      type: 'permission_cleared',
      conversation_id: cid,
      composer_id: cid,
      wakelock_action: '',
      wakelock_reason: '',
      tool_call_id: meta.toolCallId || '',
      exec_log_path: meta.exec_log_path || '',
      renderer_log_path: '',
      clear_reason: clearReason,
      t_iso: nowIso(),
      source: 'agent_exec',
    };
  }

  function getState() {
    return {
      agent_exec_logs_root: logsRoot,
      agent_exec_log_count: fileOffsets.size,
      agent_exec_permission_pending_count: pendingByConversation.size,
      agent_exec_permission_pending: [...pendingByConversation.keys()],
    };
  }

  function getPendingPermissionEvents() {
    return [...pendingByConversation.entries()].map(([conversationId, meta]) => ({
      type: 'permission_requested',
      conversation_id: conversationId,
      composer_id: conversationId,
      wakelock_action: '',
      wakelock_reason: '',
      tool_call_id: meta.toolCallId || '',
      exec_log_path: meta.exec_log_path || '',
      renderer_log_path: '',
      t_iso: meta.t_iso || nowIso(),
      source: 'agent_exec',
      pending_snapshot: true,
    }));
  }

  function isPermissionPendingForWatch(wt) {
    if (!wt || !pendingByConversation.size) return false;
    for (const id of watchConversationIds(wt)) {
      if (pendingByConversation.has(id)) return true;
    }
    return false;
  }

  return {
    init,
    pollOnce,
    clearForConversation,
    getState,
    getPendingPermissionEvents,
    isPermissionPendingForWatch,
    listAgentExecLogPaths: () => listAgentExecLogPaths(logsRoot),
    pendingByConversation,
  };
}

module.exports = {
  listAgentExecLogPaths,
  rendererLogPathForExecLog,
  parseExecLine,
  createAgentExecPermissionProbe,
};
