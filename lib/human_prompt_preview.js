/**
 * Normalize Claude / Cowork user-message blobs into plain prompt text for watch-list previews.
 */

function compactWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Prefer explicit user_query wrapper; strip IDE/upload/command scaffolding tags.
 */
function cleanHumanPromptPreview(raw) {
  let t = String(raw || '');
  const userQuery = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (userQuery) {
    t = userQuery[1];
  }

  const stripRes = [
    /<ide_selection>[\s\S]*?<\/ide_selection>/gi,
    /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi,
    /<uploaded_files>[\s\S]*?<\/uploaded_files>/gi,
    /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
    /<command-name>[\s\S]*?<\/command-name>/gi,
    /<command-message>[\s\S]*?<\/command-message>/gi,
    /<command-args>[\s\S]*?<\/command-args>/gi,
    /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
    // Harness-injected envelopes, never human text: `<system-reminder>` blocks are appended to
    // real prompts (drop them, keep the human words); a `<task-notification>` resume has no human
    // words at all. The trailing catch-all clears an unclosed envelope (truncated transcript blob).
    /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
    /<task-notification>[\s\S]*?<\/task-notification>/gi,
    /<(?:system-reminder|task-notification)>[\s\S]*$/gi,
  ];

  let prev;
  do {
    prev = t;
    for (const re of stripRes) {
      t = t.replace(re, ' ');
    }
    t = compactWhitespace(t);
  } while (prev !== t);

  return t;
}

function firstWords(text, maxWords = 10) {
  const one = compactWhitespace(text);
  if (!one) return '';
  const words = one.split(' ');
  if (words.length <= maxWords) return one;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

/** Clean then take at most maxWords words (for transcript-derived previews). */
function truncateCleanHumanPromptPreview(raw, maxWords = 10) {
  return firstWords(cleanHumanPromptPreview(raw), maxWords);
}

module.exports = {
  cleanHumanPromptPreview,
  compactWhitespace,
  firstWords,
  truncateCleanHumanPromptPreview,
};
