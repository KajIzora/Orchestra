'use strict';

/*
 * Screen-scrape diff for the Terminal.app / iTerm2 pull source (§3.1 pass 2). Those apps expose a
 * tab's text as a whole snapshot — no command boundaries, no output stream — so to surface only
 * NEW output as feed notes we diff successive snapshots. We anchor on the last few non-blank lines
 * of the previous snapshot and emit whatever follows them, which tolerates the visible screen
 * scrolling as new lines arrive. Coarse by nature (a repeated prompt line can mis-anchor) and
 * bounded (a first read / cleared screen catches up at most maxCatchup lines) so it never floods.
 */

const ANCHOR_LINES = 3;
const DEFAULT_MAX_CATCHUP = 60;

function splitSnapshot(text) {
  const lines = String(text == null ? '' : text)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing blank padding
  return lines;
}

// Last start index where `lines` contains the contiguous sequence `seq`; -1 if absent.
function lastIndexOfSeq(lines, seq) {
  if (!seq.length) return -1;
  for (let i = lines.length - seq.length; i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      if (lines[i + j] !== seq[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Diff a fresh terminal snapshot against the previous anchor.
 * @param {string[]|null} prevAnchor last emitted anchor (up to ANCHOR_LINES non-blank lines), or []
 * @param {string} snapshotText current terminal text
 * @returns {{lines: string[], anchor: string[]}} lines = new output to emit; anchor = next anchor
 */
function diffSnapshot(prevAnchor, snapshotText, { maxCatchup = DEFAULT_MAX_CATCHUP } = {}) {
  const lines = splitSnapshot(snapshotText);
  const nextAnchor = lines.filter(Boolean).slice(-ANCHOR_LINES);

  if (!prevAnchor || !prevAnchor.length) {
    // First read: catch up on the last N lines — never dump the whole scrollback.
    return { lines: lines.slice(-maxCatchup), anchor: nextAnchor };
  }

  const idx = lastIndexOfSeq(lines, prevAnchor);
  if (idx >= 0) {
    const emit = lines.slice(idx + prevAnchor.length);
    // Nothing new → keep the old anchor (don't drift it forward onto unchanged text).
    return { lines: emit, anchor: emit.length ? nextAnchor : prevAnchor };
  }

  // Anchor is gone (screen cleared or scrolled past the retained window): bounded catch-up.
  return { lines: lines.slice(-maxCatchup), anchor: nextAnchor };
}

module.exports = { diffSnapshot, splitSnapshot, lastIndexOfSeq, ANCHOR_LINES, DEFAULT_MAX_CATCHUP };
