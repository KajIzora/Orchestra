const path = require('path');
const os = require('os');

const AGY_HOOK_EVENTS = new Set(['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);

const AGY_CLI_BRAIN_SEGMENT = `${path.sep}antigravity-cli${path.sep}brain${path.sep}`;
const AGY_APP_BRAIN_SEGMENT = `${path.sep}antigravity${path.sep}brain${path.sep}`;
const AGY_TRANSCRIPT_SUFFIX = `${path.sep}.system_generated${path.sep}logs${path.sep}transcript.jsonl`;

function expandHomePath(value, homeDir = os.homedir()) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('~/')) return path.join(homeDir, trimmed.slice(2));
  if (trimmed === '~') return homeDir;
  return trimmed;
}

function agyAgentKindFromArtifactPath(artifactPath) {
  const normalized = String(artifactPath || '').replace(/\\/g, '/');
  if (normalized.includes('/antigravity-cli/brain/')) return 'cli';
  if (normalized.includes('/antigravity/brain/')) return 'app';
  return '';
}

function transcriptPathFromArtifactDirectory(artifactDirectoryPath, homeDir = os.homedir()) {
  const expanded = expandHomePath(artifactDirectoryPath, homeDir);
  if (!expanded) return '';
  const normalized = path.resolve(expanded);
  const suffix = path.join('.system_generated', 'logs', 'transcript.jsonl');
  if (normalized.endsWith(suffix)) return normalized;
  return path.join(normalized, suffix);
}

function isAntigravityTranscriptPath(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return false;
  const normalized = transcriptPath.replace(/\\/g, '/');
  return (
    normalized.includes('/antigravity-cli/brain/') || normalized.includes('/antigravity/brain/')
  );
}

function getAntigravityBrainRoots(homeDir = os.homedir()) {
  const root = path.join(homeDir, '.gemini');
  return [
    path.join(root, 'antigravity-cli', 'brain'),
    path.join(root, 'antigravity', 'brain'),
  ];
}

function getAgyPayload(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
    return body.payload;
  }
  return body;
}

function normalizeAgyHookBody(body = {}, homeDir = os.homedir()) {
  const payload = getAgyPayload(body);
  const conversationId =
    (typeof body.conversationId === 'string' && body.conversationId.trim()) ||
    (typeof body.conversation_id === 'string' && body.conversation_id.trim()) ||
    (typeof payload.conversationId === 'string' && payload.conversationId.trim()) ||
    (typeof body.session_id === 'string' && body.session_id.trim()) ||
    (typeof body.sessionId === 'string' && body.sessionId.trim()) ||
    '';

  const artifactDirectoryPath =
    (typeof body.artifactDirectoryPath === 'string' && body.artifactDirectoryPath) ||
    (typeof payload.artifactDirectoryPath === 'string' && payload.artifactDirectoryPath) ||
    '';

  let transcriptPath =
    (typeof body.transcript_path === 'string' && body.transcript_path.trim()) ||
    (typeof body.transcriptPath === 'string' && body.transcriptPath.trim()) ||
    '';
  if (!transcriptPath && artifactDirectoryPath) {
    transcriptPath = transcriptPathFromArtifactDirectory(artifactDirectoryPath, homeDir);
  }

  const workspacePaths = Array.isArray(body.workspacePaths)
    ? body.workspacePaths
    : Array.isArray(payload.workspacePaths)
      ? payload.workspacePaths
      : [];
  const workspacePath =
    (typeof body.workspace_path === 'string' && body.workspace_path.trim()) ||
    (typeof body.cwd === 'string' && body.cwd.trim()) ||
    (typeof workspacePaths[0] === 'string' && workspacePaths[0].trim()) ||
    '';

  const invocationNumRaw = payload.invocationNum ?? body.invocationNum;
  const invocationNum = Number.isFinite(Number(invocationNumRaw)) ? Number(invocationNumRaw) : null;

  const terminationReason =
    (typeof payload.terminationReason === 'string' && payload.terminationReason) ||
    (typeof body.terminationReason === 'string' && body.terminationReason) ||
    '';

  const fullyIdleRaw = payload.fullyIdle ?? body.fullyIdle;
  const fullyIdle = fullyIdleRaw === true || fullyIdleRaw === 'true';

  const toolCall =
    payload.toolCall && typeof payload.toolCall === 'object'
      ? payload.toolCall
      : body.toolCall && typeof body.toolCall === 'object'
        ? body.toolCall
        : null;

  const toolStepIdxRaw = toolCall?.stepIdx ?? payload.stepIdx ?? body.stepIdx;
  const toolStepIdx = Number.isFinite(Number(toolStepIdxRaw)) ? Number(toolStepIdxRaw) : null;

  return {
    conversationId,
    transcriptPath,
    workspacePath,
    artifactDirectoryPath,
    agy_agent_kind: agyAgentKindFromArtifactPath(artifactDirectoryPath || transcriptPath),
    agy_invocation_num: invocationNum,
    agy_termination_reason: terminationReason,
    agy_fully_idle: fullyIdle,
    agy_tool_call: toolCall,
    agy_tool_step_idx: toolStepIdx,
    agy_payload: payload,
  };
}

function isAgyStopDone(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const reason = String(p.terminationReason || p.termination_reason || '').toUpperCase();
  const fullyIdle = p.fullyIdle === true || p.fully_idle === true;
  return reason === 'NO_TOOL_CALL' && fullyIdle;
}

function isAgyStopCancel(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const reason = String(p.terminationReason || p.termination_reason || '').toUpperCase();
  return reason === 'USER_CANCELED' || reason === 'USER_CANCELLED';
}

function isAgyStopPartialIdle(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return p.fullyIdle === false || p.fully_idle === false;
}

function isBackgroundRunCommand(toolCall, payload) {
  const tc = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const p = payload && typeof payload === 'object' ? payload : {};
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const waitMs = Number(
    tc.waitMsBeforeAsync ??
      p.waitMsBeforeAsync ??
      tc.WaitMsBeforeAsync ??
      args.waitMsBeforeAsync ??
      args.WaitMsBeforeAsync ??
      0
  );
  return Number.isFinite(waitMs) && waitMs > 5000;
}

function isPermissionGatedPreToolUse(toolCall, payload) {
  const tc = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const name = String(tc.name || '').trim();
  if (!name) return false;
  if (name === 'ask_question') return false;
  if (isBackgroundRunCommand(tc, payload)) return false;
  if (tc.toolAction || tc.toolSummary) return false;
  if (name === 'run_command' || name === 'write_to_file' || name === 'replace_file_content') {
    return true;
  }
  return false;
}

function isAskQuestionPreToolUse(toolCall) {
  return String(toolCall?.name || '').trim() === 'ask_question';
}

// The `schedule` tool is how agy defers a turn ("wake me in N seconds to continue"),
// e.g. while waiting on a foreground `sleep`/poll. A pending schedule means the agent
// is NOT done, so partial-stop idle detection must wait at least until the wakeup.
const AGY_SCHEDULE_DEFAULT_SECONDS = 60; // used when DurationSeconds is missing/unparseable
const AGY_SCHEDULE_MAX_SECONDS = 1800; // cap so a pathological duration can't hang the watch

function agyScheduleWakeupAtMs(toolCall, nowMs = Date.now()) {
  if (String(toolCall?.name || '').trim() !== 'schedule') return 0;
  const args = toolCall && typeof toolCall.args === 'object' && toolCall.args ? toolCall.args : {};
  const raw = Number(args.DurationSeconds ?? args.durationSeconds);
  let seconds = Number.isFinite(raw) && raw > 0 ? raw : AGY_SCHEDULE_DEFAULT_SECONDS;
  if (seconds > AGY_SCHEDULE_MAX_SECONDS) seconds = AGY_SCHEDULE_MAX_SECONDS;
  return nowMs + seconds * 1000;
}

function parseHookDebugPayloadLine(block) {
  const match = block.match(/PAYLOAD:\s*(\{[\s\S]*?\})(?=\nALL_ENV:|\n=== HOOK END ===|$)/m);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseHookDebugBlocks(text) {
  const events = [];
  const chunks = String(text || '').split('=== HOOK START ===');
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const hookMatch = chunk.match(/HOOK:\s*(\S+)/);
    const hookName = hookMatch ? hookMatch[1].trim() : '';
    if (!hookName || hookName === 'unknown') continue;
    const payload = parseHookDebugPayloadLine(chunk);
    const dateMatch = chunk.match(/DATE:\s*(\S+)/);
    events.push({
      hook_event_name: hookName,
      event_name: hookName,
      payload,
      ...payload,
      hook_debug_at: dateMatch ? dateMatch[1] : '',
    });
  }
  return events;
}

module.exports = {
  AGY_HOOK_EVENTS,
  AGY_CLI_BRAIN_SEGMENT,
  AGY_APP_BRAIN_SEGMENT,
  AGY_TRANSCRIPT_SUFFIX,
  expandHomePath,
  agyAgentKindFromArtifactPath,
  transcriptPathFromArtifactDirectory,
  isAntigravityTranscriptPath,
  getAntigravityBrainRoots,
  getAgyPayload,
  normalizeAgyHookBody,
  isAgyStopDone,
  isAgyStopCancel,
  isAgyStopPartialIdle,
  isBackgroundRunCommand,
  isPermissionGatedPreToolUse,
  isAskQuestionPreToolUse,
  agyScheduleWakeupAtMs,
  parseHookDebugBlocks,
};
