'use strict';

/*
 * Provider-agnostic discovery-merge core for the run pickers (in-flight generation fix).
 *
 * Hook snapshots are in-memory only: an agent that started generating while Orchestra was down
 * never delivered its "run started" hook, so a hook-store-only picker cannot see it. Each provider
 * closes that hole by discovering candidate runs from its on-disk artifacts and merging them into
 * the snapshot-derived rows on EVERY picker call (always-merge — a zero-rows gate would re-hide
 * the missed run as soon as any other local agent fires a hook). This module is the one shared
 * piece: dedup + append, nothing else.
 *
 * Contract (locked in docs/TestingFrameworkUpdate/FinalSteps/InFlightAgentFix/Step2Plan.md):
 * - existingRows (hook/snapshot-derived) are kept untouched and always win: every candidate key
 *   of every existing row claims that identity before any discovered row is considered.
 * - keyFor(row) returns an ARRAY of candidate identity keys, because providers key on different
 *   fields (claude: session_id + transcript_path; codex: transcript_path only; cursor: run_id +
 *   transcript path; gemini: conversationId). Non-string/empty entries are ignored.
 * - a discovered row is appended only when it has at least one usable key and NONE of its keys
 *   collide with an already-claimed key. Appended rows claim their keys too, so duplicates
 *   WITHIN the discovered list also collapse (first occurrence wins).
 * - a discovered row with no usable keys is dropped: unknown identity must not risk showing the
 *   same run twice in the picker.
 *
 * Deliberately dumb: provider wrappers do the filtering (generating === true), workspace gating,
 * and row stamping BEFORE calling this, and any sorting after.
 */

function candidateIdentityKeys(keyFor, row) {
  const keys = keyFor(row);
  if (!Array.isArray(keys)) return [];
  return keys.filter((key) => typeof key === 'string' && key);
}

/**
 * Merge discovered picker rows into existing (hook-derived) picker rows without duplicates.
 *
 * @param {object[]} existingRows - hook/snapshot-derived rows; always kept, always win.
 * @param {object[]} discoveredRows - artifact-discovered candidate rows (pre-filtered + stamped).
 * @param {object}   options
 * @param {(row: object) => string[]} options.keyFor - returns the row's candidate identity keys.
 * @returns {object[]} new array: existingRows first (original order), then the appended
 *                     discovered rows (input order). Callers sort.
 */
function mergeDiscoveryPickerRuns(existingRows, discoveredRows, options = {}) {
  const keyFor = typeof options.keyFor === 'function' ? options.keyFor : null;
  if (!keyFor) throw new Error('mergeDiscoveryPickerRuns requires options.keyFor');
  const out = Array.isArray(existingRows) ? [...existingRows] : [];
  const seen = new Set();
  for (const row of out) {
    for (const key of candidateIdentityKeys(keyFor, row)) seen.add(key);
  }
  for (const row of Array.isArray(discoveredRows) ? discoveredRows : []) {
    if (!row || typeof row !== 'object') continue;
    const keys = candidateIdentityKeys(keyFor, row);
    if (!keys.length || keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    out.push(row);
  }
  return out;
}

module.exports = { mergeDiscoveryPickerRuns };
