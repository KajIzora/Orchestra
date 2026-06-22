'use strict';

/**
 * agy-app signal channel.
 *
 * The Antigravity *desktop app* surfaces permission / cancel state in its SQLite
 * conversation DBs (step_type=21 + permissions blob = permission, plus WAL/log cancel markers),
 * NOT as hook POSTs. The live server reads those DBs (see the readLocalAgyApp* readers
 * in antigravity_cli_tracker.js) and *synthesizes* Gemini hook-store events from them,
 * applying them directly to the in-memory store — so they never reach the HTTP raw tap
 * and the signal recorder can't see them for replay.
 *
 * This module is the single source of truth for that DB-signal -> Gemini-hook-body
 * mapping, shared by:
 *   - server.js (live: applyLocalAgyAppPermissionSignals / applyGeminiCancelSnapshot)
 *   - scripts/signal_session.js (capture: feed the same synthetic bodies into the tail
 *     stream so a recording reproduces what the live server would feed its poller).
 *
 * agy-app's *done/generating/Stop* hooks are real Gemini hooks written to disk at
 * ~/.gemini/antigravity-cli/scratch/hook-debug.log (see gemini_hook_script.js), so those
 * are captured from disk like agy-cli — this channel only fills the DB-only gap.
 *
 * Ignored in production: `stop_hook_executing` (language-server Stop line on normal
 * turn ends as well as cancel). Explicit cancel markers that carry a conversationId ARE mapped.
 */

const {
  readLocalAgyAppPermissionSignals,
  readLocalAgyAppCancelSignals,
  readLocalAgyAppLanguageServerCancelSignals,
} = require('./antigravity_cli_tracker');

/**
 * Gemini hook body for an agy-app cancel (matches the live applyGeminiCancelSnapshot body).
 * @param {string} conversationId
 * @param {{ remoteHost?: string }} [opts]
 */
function agyAppCancelHookBody(conversationId, opts = {}) {
  const remoteHost = opts.remoteHost || '';
  return {
    event_name: 'Stop',
    conversationId,
    ...(remoteHost ? { remote_host: remoteHost } : {}),
    payload: { terminationReason: 'USER_CANCELED', fullyIdle: false },
    agy_cancel_hint: true,
    source_kind: 'hook',
  };
}

/**
 * Map one emitted agy-app DB signal to the Gemini hook body the live server ingests.
 * Returns null for signals with no direct body (e.g. language-server stop_hook_executing).
 *
 * Permission bodies match server.js applyLocalAgyAppPermissionSignals exactly (note the
 * intentional session_id vs conversationId asymmetry the live store relies on).
 */
function agyAppSignalToGeminiHookBody(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const remoteHost = signal.remoteHost || signal.remote_host || signal.source_host || '';
  switch (signal.kind) {
    case 'permission_requested':
      if (!signal.conversationId) return null;
      return {
        event_name: 'Notification',
        session_id: signal.conversationId,
        ...(remoteHost ? { remote_host: remoteHost } : {}),
        notification_type: 'ToolPermission',
        source_kind: 'hook',
        agy_permission_pending: true,
      };
    case 'permission_granted':
      if (!signal.conversationId) return null;
      return {
        event_name: 'PostToolUse',
        conversationId: signal.conversationId,
        ...(remoteHost ? { remote_host: remoteHost } : {}),
        source_kind: 'hook',
        agy_permission_pending: false,
      };
    // agy-app DB readers emit 'context_canceled_by_user'; the agy-cli log reader
    // (parseCliCancelSignals) emits the bare 'context_canceled'. Both mean the same thing.
    case 'context_canceled':
    case 'context_canceled_by_user':
    case 'cancel_in_progress':
      if (!signal.conversationId) return null;
      return agyAppCancelHookBody(signal.conversationId, { remoteHost });
    default:
      return null;
  }
}

/**
 * A capture-side poller that mirrors the server's agy-app DB poll loop, but instead of
 * applying signals it hands each synthesized Gemini hook body to `onEvent`.
 *
 * Owns the same stateful reader cursors the server keeps, and reads in the same order
 * (DB permission, cancel, language-server cancel) so the emitted timeline matches live
 * behavior.
 *
 * @param {{ onEvent: (body: object, signal: object) => void, homeDir?: string,
 *           logPath?: string, sinceMs?: number }} options
 */
function createAgyAppSignalPoller(options = {}) {
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const homeDir = options.homeDir;
  const cancelState = new Map();
  const permissionState = new Map();
  const languageServerCancelState = {};
  // Baseline so we only emit cancel signals that appear after capture starts (mirrors the
  // server using Date.now() at construction for the cancel since-cursor).
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : Date.now();

  const emit = (signal) => {
    const body = agyAppSignalToGeminiHookBody(signal);
    if (body) onEvent(body, signal);
  };

  async function pollOnce() {
    try {
      const out = await readLocalAgyAppPermissionSignals(permissionState, { homeDir, sinceMs });
      for (const signal of out.events || []) emit(signal);
    } catch {
      // keep polling despite app DB read errors
    }
    try {
      const out = await readLocalAgyAppCancelSignals(cancelState, { homeDir, sinceMs });
      for (const signal of out.events || []) emit(signal);
    } catch {
      // keep polling despite transient app cancel DB/WAL read errors
    }
    try {
      const out = await readLocalAgyAppLanguageServerCancelSignals(languageServerCancelState, {
        logPath: options.logPath,
      });
      for (const signal of out.events || []) emit(signal);
    } catch {
      // keep polling despite language-server cancel read errors
    }
  }

  return { pollOnce };
}

module.exports = {
  agyAppSignalToGeminiHookBody,
  agyAppCancelHookBody,
  createAgyAppSignalPoller,
};
