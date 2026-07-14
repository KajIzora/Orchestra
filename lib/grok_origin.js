'use strict';

/*
 * grok_origin.js — classify GROK-ORIGIN hook posts arriving on the claude/cursor taps.
 *
 * grok 0.2.93 scans ~/.claude/settings.json and ~/.cursor/hooks.json by default and RUNS the
 * Orchestra hook forwarders from grok sessions (ReconPlaybook §7 "Vendor-compat contamination");
 * the documented kill-switch env vars are ignored by the runtime hook engine, so any grok launch
 * outside the fake-HOME shim POSTs grok-shaped payloads to /api/claude-hooks/event and
 * /api/cursor-hooks/event. Those payloads must NEVER ingest as claude/cursor state:
 * claude_hook_store.normalizeEventName already reads the camelCase `hookEventName` key, so a grok
 * `stop`/`user_prompt_submit` would otherwise parse as a real claude Stop/UserPromptSubmit and
 * drive snapshots, pickers and the raw hook tap.
 *
 * DETECTION (all three signals verified against the R2a capture,
 * docs/TestingFrameworkUpdate/FinalSteps/LiveFeed/grok/evidence/hook_capture_payloads.jsonl):
 *   1. the event name rides ONLY the camelCase `hookEventName` key (claude sends hook_event_name;
 *      cursor sends hook_event_name/event_name) with a snake_case value ('session_start',
 *      'user_prompt_submit', 'pre_tool_use', 'stop', …);
 *   2. corroborated by EITHER a UUIDv7 session id (grok session ids are time-ordered v7; claude/
 *      cursor ids are v4) OR a transcript path under a .grok state dir
 *      (~/.grok/sessions/<group>/<sid>/updates.jsonl).
 * Requiring the corroboration keeps a hypothetical future claude/cursor build that legitimately
 * switches to camelCase keys from being mis-dropped.
 */

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GROK_STATE_PATH_RE = /[\\/]\.grok[\\/]/;
// grok hook event names observed in 0.2.93 (snake_case values on the camelCase key).
const GROK_EVENT_NAME_RE = /^[a-z]+(?:_[a-z]+)*$/;

function isGrokOriginHookBody(body) {
  if (!body || typeof body !== 'object') return false;
  const camel = typeof body.hookEventName === 'string' ? body.hookEventName.trim() : '';
  if (!camel || !GROK_EVENT_NAME_RE.test(camel)) return false;
  // A real claude/cursor payload carries its own snake_case name key — never classify those.
  if (typeof body.hook_event_name === 'string' && body.hook_event_name.trim()) return false;
  if (typeof body.event_name === 'string' && body.event_name.trim()) return false;
  const sid = typeof body.sessionId === 'string' ? body.sessionId.trim()
    : typeof body.session_id === 'string' ? body.session_id.trim() : '';
  if (UUID_V7_RE.test(sid)) return true;
  const transcript = typeof body.transcriptPath === 'string' ? body.transcriptPath
    : typeof body.transcript_path === 'string' ? body.transcript_path : '';
  return GROK_STATE_PATH_RE.test(String(transcript || ''));
}

// One log line per (tap, grok session) — a single grok turn fires many hooks and the point of the
// line is the AUDIT TRAIL (which sessions leaked), not a per-event firehose. Bounded set.
const LOGGED_MAX = 200;
const logged = new Set();

function logGrokOriginOnce(tap, body, logFn = console.warn) {
  const sid =
    (typeof body?.sessionId === 'string' && body.sessionId) ||
    (typeof body?.session_id === 'string' && body.session_id) ||
    '(no session id)';
  const key = `${tap}:${sid}`;
  if (logged.has(key)) return false;
  if (logged.size >= LOGGED_MAX) logged.clear();
  logged.add(key);
  try {
    logFn(
      `[${tap}] grok-origin hook post classified and ignored (grok 0.2.93 vendor-compat bug fires the ` +
        `${tap} tap from grok sessions; hookEventName=${body?.hookEventName || '?'} sessionId=${sid}). ` +
        'Not ingested as state. Launch grok through the fake-HOME shim to silence this.'
    );
  } catch {
    /* logging must never break ingestion */
  }
  return true;
}

module.exports = {
  isGrokOriginHookBody,
  logGrokOriginOnce,
  UUID_V7_RE,
};
