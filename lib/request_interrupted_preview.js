/**
 * Synthetic user rows when Claude Code or Cursor stops generation mid-turn.
 * Cursor may append "for tool use"; Claude Code uses the base phrase only.
 */
function isUserRequestInterruptedPreview(input) {
  const norm = String(input || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!norm) return false;
  return norm === '[request interrupted by user]' || norm.startsWith('[request interrupted by user ');
}

module.exports = {
  isUserRequestInterruptedPreview,
};
