// Thin client for the Daricha backend. Every call is best-effort: if no
// backend is configured (VITE_API_BASE_URL unset) or it's unreachable, the
// app falls back to a clearly-labelled "local-only" mode instead of
// pretending everything is fully secured — see App.jsx's `backendStatus`.

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export const isBackendConfigured = () => Boolean(BASE_URL);

async function request(path, { method = "GET", token, body } = {}) {
  if (!BASE_URL) throw new Error("backend_not_configured");
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    const error = new Error(payload?.error || `http_${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// ---- session ----
// An anonymous, short-lived session token — not a user account, and never
// derived from or equal to the user's permanent @id.
export const createSession = () => request("/api/auth/session", { method: "POST" });

// ---- rooms ----
export const createRoom = (sessionToken) =>
  request("/api/rooms", { method: "POST", token: sessionToken });

export const validateRoom = (sessionToken, code, roomToken) =>
  request(`/api/rooms/${encodeURIComponent(code)}/validate?token=${encodeURIComponent(roomToken)}`, {
    token: sessionToken,
  });

export const consumeRoom = (sessionToken, code, roomToken) =>
  request(`/api/rooms/${encodeURIComponent(code)}/consume`, {
    method: "POST",
    token: sessionToken,
    body: { token: roomToken },
  });

// ---- TURN ----
export const fetchTurnCredentials = (sessionToken) => request("/api/turn", { token: sessionToken });
