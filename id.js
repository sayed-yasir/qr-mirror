// Every id that matters for security bookkeeping (transfer ids, incoming
// request ids) is generated from crypto.getRandomValues rather than
// Math.random, which is not designed to be unpredictable.

export function generateSecureId(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateLocalRoomCode(chars, length) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => chars[n % chars.length]).join("");
}
