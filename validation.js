// Every message that arrives over a PeerJS DataConnection came from
// someone else's browser and must be treated as untrusted input — these
// helpers are the single choke point that all incoming protocol messages
// pass through before anything is done with them.

import {
  MAX_FILE_SIZE,
  MAX_FILE_NAME_LENGTH,
  ALLOWED_TRANSFER_KINDS,
  MIME_PATTERN,
  MAX_MESSAGE_LENGTH,
} from "./constants.js";

const TRANSFER_ID_PATTERN = /^[a-z0-9-]{6,64}$/i;

export function isSafeSize(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_FILE_SIZE;
}

export function validateFileStart(data) {
  if (typeof data.transferId !== "string" || !TRANSFER_ID_PATTERN.test(data.transferId)) {
    return "invalid_transfer_id";
  }
  if (!isSafeSize(data.size)) return "invalid_size";
  if (typeof data.name !== "string" || data.name.length === 0 || data.name.length > MAX_FILE_NAME_LENGTH) {
    return "invalid_name";
  }
  if (data.mime !== undefined && data.mime !== "" && (typeof data.mime !== "string" || !MIME_PATTERN.test(data.mime))) {
    return "invalid_mime";
  }
  const kind = data.kind || "file";
  if (!ALLOWED_TRANSFER_KINDS.has(kind)) return "invalid_kind";
  return null; // valid
}

export function validateFileChunk(data, chunkSizeLimit) {
  if (typeof data.transferId !== "string" || !TRANSFER_ID_PATTERN.test(data.transferId)) {
    return "invalid_transfer_id";
  }
  const chunk = data.chunk;
  const isBinary = chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk);
  if (!isBinary) return "invalid_chunk";
  const byteLength = chunk.byteLength ?? 0;
  if (byteLength === 0 || byteLength > chunkSizeLimit) return "chunk_too_large";
  return null;
}

export function validateOutgoingText(text) {
  if (typeof text !== "string") return "invalid_text";
  if (text.length === 0) return "empty";
  if (text.length > MAX_MESSAGE_LENGTH) return "too_long";
  return null;
}
