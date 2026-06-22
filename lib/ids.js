const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function encodeTime(now, len) {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ALPHABET.length;
    out = ALPHABET[mod] + out;
    now = (now - mod) / ALPHABET.length;
  }
  return out;
}

function ulid() {
  return encodeTime(Date.now(), 10) + randomChars(16);
}

function projectId() {
  return `proj_${ulid()}`;
}

function taskId() {
  return `task_${ulid()}`;
}

module.exports = { ulid, projectId, taskId };
