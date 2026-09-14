// Single source of truth for every numeric/security limit used across the
// app, so the UI, the chunk-transfer logic, and the validation layer can
// never drift out of sync with each other.

export const STORAGE_KEY = "daricha_user_id";
export const ID_PATTERN = /^[a-z0-9_]{3,20}$/;

export const ROOM_CODE_LIFETIME_MS = 10 * 60 * 1000; // must match server/src/store.js ROOM_TTL_MS
export const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const ROOM_CODE_LENGTH = 8;
export const MAX_RECONNECT_ATTEMPTS = 3;

export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB hard cap per file/voice note
export const CHUNK_SIZE = 16 * 1024; // 16KB — a safe message size for WebRTC data channels
export const BUFFERED_AMOUNT_LIMIT = 1024 * 1024; // back off sending once 1MB is queued
export const MAX_FILE_NAME_LENGTH = 255;
export const ALLOWED_TRANSFER_KINDS = new Set(["file", "voice"]);
// A conservative allow-pattern rather than a long denylist: type/subtype
// tokens only, optional parameters stripped by the browser's File.type
// anyway. Empty mime (some browsers omit it) is tolerated and treated as
// application/octet-stream.
export const MIME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;

export const MAX_MESSAGE_LENGTH = 10000;

export const MAX_VOICE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_VOICE_SIZE = 25 * 1024 * 1024; // 25MB — separate, smaller cap than generic files

export const MAX_PENDING_REQUESTS = 10;
export const INCOMING_REQUEST_TIMEOUT_MS = 30 * 1000; // unanswered requests auto-expire
export const REJECT_COOLDOWN_MS = 60 * 1000; // after being rejected, a peer is blocked for this long
export const MAX_REJECTS_BEFORE_BLOCK = 2;
