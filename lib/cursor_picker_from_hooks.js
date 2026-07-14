'use strict';

/*
 * Local cursor discovery-merge for the run picker (in-flight generation fix).
 *
 * The cursor picker (server.js `/api/projects/:id/cursor-runs` → cursorHookStore.listRunsForProject)
 * is built purely from in-memory hook snapshots, which are empty on every launch. A cursor agent
 * that started generating while Orchestra was down never delivered its start hook, so it is invisible
 * until it fires another. This module merges disk-discovered generating runs into the snapshot rows
 * on EVERY picker call (always-merge — a zero-rows gate would re-hide the missed run as soon as any
 * other cursor agent fires a hook), mirroring the claude local sibling in claude_picker_from_hooks.js.
 */

const path = require('path');
const { mergeDiscoveryPickerRuns } = require('./discovery_picker_merge');
const { buildWorkspaceSlugSet } = require('./cursor_tracker');
const { cursorSurfaceFromVersion } = require('./cursor_cli_permission');
const { toIso } = require('./active_generation');

function normalizeCursorTranscriptKey(p) {
  if (typeof p !== 'string') return '';
  const trimmed = p.trim();
  return trimmed ? path.resolve(trimmed) : '';
}

function normalizeCursorRunIdKey(id) {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase();
}

/**
 * Candidate identity keys for cursor picker dedup, applied by the shared core to BOTH hook-store
 * rows (listRunsForProject) and discovered disk rows so a hook row always claims the identity first.
 * Verified against real artifacts (~/.cursor, signal-lab captures):
 *  - t:<resolved transcript path> — the reliable cross-surface key. Cursor hooks (cli AND ide) carry
 *    the real <runId>/<runId>.jsonl path, which path.resolve-normalizes to the same string
 *    discoverCursorRuns emits, so it collides for the same run on either surface. Mirrors the hook
 *    store's own normalizeTranscriptPath (path.resolve).
 *  - r:<lowercased run_id> — extra safety, per the locked plan's "cursor = run_id + transcript path".
 *    cursor-CLI's hook conversation_id (⇒ the row's run_id) IS the transcript-dir UUID, so this
 *    collides for cli; cursor-IDE uses a disjoint conv_* id, so an ide hook row's r: key simply never
 *    equals a disk UUID — no false collisions in either direction.
 */
function cursorPickerRunKeys(row) {
  const keys = [];
  const transcript = normalizeCursorTranscriptKey(row?.transcript_path);
  const runId = normalizeCursorRunIdKey(row?.run_id);
  if (transcript) keys.push(`t:${transcript}`);
  if (runId) keys.push(`r:${runId}`);
  return keys;
}

/**
 * Merge locally-discovered cursor runs (discoverCursorRunsForPicker output, bounded with
 * recentOnlyMs) into snapshot-derived hook picker rows (listRunsForProject output).
 * - keeps only discovered rows the artifact classifies as generating === true (done/stale local
 *   history is the hook store's business; discovery exists only to surface in-flight missed runs);
 * - applies the same local scope listRunsForProject uses, expressed in the slug space
 *   discoverCursorRuns already works in (project dir name === workspacePathToProjectSlug of the
 *   agent's workspace); empty workspaces means no filter, like the snapshot path;
 * - stamps every field a hook picker row carries so the picker client cannot tell a discovered row
 *   from a hook row — INCLUDING hook_hint:true, which the picker UI requires (public/app.js drops
 *   rows without it) and which is honest here (a discovered disk run IS a real cursor run) — plus
 *   discovered:true, the one marker distinguishing the two (for live-test discrimination);
 * - dedupes against hook rows by transcript path / run id via the shared core (a hook row wins).
 *
 * @param {object[]} hookRows - cursorHookStore.listRunsForProject(project, { activeOnly }) output
 * @param {object[]} discoveredRows - discoverCursorRunsForPicker output
 * @param {object}   opts
 * @param {string[]} [opts.localWorkspaces] - project's local cursor workspace paths (gating scope)
 */
function mergeLocalCursorDiscoveryPickerRuns(hookRows, discoveredRows, opts = {}) {
  const localWorkspaces = Array.isArray(opts.localWorkspaces)
    ? opts.localWorkspaces.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  const slugSet = localWorkspaces.length ? buildWorkspaceSlugSet(localWorkspaces, 'local') : null;
  const candidates = [];
  for (const run of Array.isArray(discoveredRows) ? discoveredRows : []) {
    if (!run || typeof run !== 'object') continue;
    if (run.generating !== true) continue;
    if (slugSet && !slugSet.has(run.project_slug)) continue;
    const mtimeMs = Number.isFinite(run.mtime_ms) ? run.mtime_ms : 0;
    const runId = typeof run.run_id === 'string' ? run.run_id : '';
    candidates.push({
      source: 'local',
      host: '',
      projects_root: '',
      run_id: runId,
      transcript_path: typeof run.transcript_path === 'string' ? run.transcript_path : '',
      project_slug: typeof run.project_slug === 'string' ? run.project_slug : '',
      mtime_ms: mtimeMs,
      user_preview: typeof run.user_preview === 'string' ? run.user_preview : '',
      // cursor-cli's conversation_id IS the run_id (UUID); cursor-ide resolves off transcript_path,
      // so mirroring run_id here is exactly right for cli and a benign transcript-identity fallback
      // for ide (the disk artifact carries no cursor conv_* id).
      conversation_id: runId,
      // Field parity with the hook picker row (listRunsForProject): mirror its surface derivation
      // (cursorSurfaceFromVersion). A discovered disk run carries no cursor_version — cursor cli and
      // ide share the same agent-transcripts path with no discriminator — so this resolves to '' (no
      // surface glyph rather than guessing), exactly as the snapshot path does for a version-less snap.
      surface: cursorSurfaceFromVersion(run.cursor_version),
      hook_hint: true,
      completion_hint: false,
      terminal_hint: false,
      generating: true,
      held: run.held === true,
      updated_at: toIso(mtimeMs),
      discovered: true,
    });
  }
  const out = mergeDiscoveryPickerRuns(Array.isArray(hookRows) ? hookRows : [], candidates, {
    keyFor: cursorPickerRunKeys,
  });
  out.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return out;
}

module.exports = {
  cursorPickerRunKeys,
  mergeLocalCursorDiscoveryPickerRuns,
};
