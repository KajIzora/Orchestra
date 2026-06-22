function stripUserQueryWrapper(raw) {
  const t = String(raw).trim();
  const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return (m ? m[1] : t).trim();
}

function extractUserMessageText(obj) {
  const msg = obj && obj.message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.trim();
  if (!Array.isArray(msg.content)) return '';
  const pieces = [];
  for (const block of msg.content) {
    if (block && typeof block.text === 'string') pieces.push(block.text);
  }
  return pieces.join('\n').trim();
}

function firstWords(text, maxWords) {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  const w = one.split(' ');
  if (w.length <= maxWords) return one;
  return `${w.slice(0, maxWords).join(' ')}…`;
}

/**
 * From transcript tail text, take the most recent `role: user` line and return
 * the first maxWords of its plain text (after stripping common wrappers).
 */
function latestUserWordsPreviewFromTailText(tailText, maxWords = 10) {
  if (!tailText) return '';
  const lines = tailText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (obj.role !== 'user') continue;
    const raw = extractUserMessageText(obj);
    const cleaned = stripUserQueryWrapper(raw).replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    return firstWords(cleaned, maxWords);
  }
  return '';
}

module.exports = {
  latestUserWordsPreviewFromTailText,
};
