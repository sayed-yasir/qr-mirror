import { useCallback, useEffect, useRef, useState } from "react";
import Peer from "peerjs";
import QRCode from "qrcode";
import {
  AlertTriangle,
  Camera,
  Check,
  Copy,
  ExternalLink,
  Link2,
  LogOut,
  Maximize,
  Mic,
  Monitor,
  Moon,
  Paperclip,
  RefreshCw,
  RotateCw,
  Send,
  Smartphone,
  Sun,
  User,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import {
  STORAGE_KEY,
  ID_PATTERN,
  ROOM_CODE_LIFETIME_MS,
  ROOM_CODE_CHARS,
  ROOM_CODE_LENGTH,
  MAX_RECONNECT_ATTEMPTS,
  MAX_FILE_SIZE,
  CHUNK_SIZE,
  BUFFERED_AMOUNT_LIMIT,
  MAX_FILE_NAME_LENGTH,
  MIME_PATTERN,
  MAX_MESSAGE_LENGTH,
  MAX_VOICE_DURATION_MS,
  MAX_VOICE_SIZE,
  MAX_PENDING_REQUESTS,
  INCOMING_REQUEST_TIMEOUT_MS,
  REJECT_COOLDOWN_MS,
  MAX_REJECTS_BEFORE_BLOCK,
} from "./lib/constants.js";
import { generateSecureId, generateLocalRoomCode } from "./lib/id.js";
import { validateFileStart, validateFileChunk, validateOutgoingText } from "./lib/validation.js";
import { createTransferSink } from "./lib/opfs.js";
import {
  isBackendConfigured,
  createSession,
  createRoom as apiCreateRoom,
  validateRoom as apiValidateRoom,
  consumeRoom as apiConsumeRoom,
  fetchTurnCredentials,
} from "./lib/api.js";

const DEFAULT_ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] }];

// A self-hosted PeerServer is entirely opt-in via env vars — nothing here
// is hard-coded, and if unset the app simply uses PeerJS Cloud, same as
// before. See server/.env.example + this project's .env.example.
const PEER_SERVER_HOST = import.meta.env.VITE_PEER_SERVER_HOST || "";
const PEER_SERVER_PORT = import.meta.env.VITE_PEER_SERVER_PORT ? Number(import.meta.env.VITE_PEER_SERVER_PORT) : undefined;
const PEER_SERVER_PATH = import.meta.env.VITE_PEER_SERVER_PATH || "/";
const PEER_SERVER_KEY = import.meta.env.VITE_PEER_SERVER_KEY || "peerjs";
const PEER_SERVER_SECURE = import.meta.env.VITE_PEER_SERVER_SECURE === "true";

function buildPeerOptions(iceServers = DEFAULT_ICE_SERVERS) {
  const opts = { debug: 0, config: { iceServers } };
  if (PEER_SERVER_HOST) {
    opts.host = PEER_SERVER_HOST;
    if (PEER_SERVER_PORT) opts.port = PEER_SERVER_PORT;
    opts.path = PEER_SERVER_PATH;
    opts.key = PEER_SERVER_KEY;
    opts.secure = PEER_SERVER_SECURE;
  }
  return opts;
}

const formatFileSize = (bytes) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
};

// Turns a raw PeerJS id into something readable. Rooms are deliberately
// anonymous — joining a room never reveals the host's permanent username.
const labelForPeerId = (id) => {
  if (!id) return "";
  if (id.startsWith("daricha-id-")) return "@" + id.slice("daricha-id-".length);
  if (id.startsWith("daricha-room-")) return "میزبان اتاق";
  return id;
};

export default function App() {
  // ---- theme ----
  const [darkMode, setDarkMode] = useState(false);

  // ---- backend session (anonymous, short-lived — never the permanent @id) ----
  const [backendStatus, setBackendStatus] = useState("checking"); // checking | local-only | connected | unreachable
  const sessionTokenRef = useRef(null);
  const [iceServers, setIceServers] = useState(DEFAULT_ICE_SERVERS);
  const [iceServersReady, setIceServersReady] = useState(false);
  const [turnConfigured, setTurnConfigured] = useState(false);

  // ---- identity / registration ----
  const [userId, setUserId] = useState(() => localStorage.getItem(STORAGE_KEY));
  const [isLoggedIn, setIsLoggedIn] = useState(() => !!localStorage.getItem(STORAGE_KEY));
  const [idInput, setIdInput] = useState("");
  const [idError, setIdError] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);

  // ---- peer connections ----
  const peerRef = useRef(null);
  const roomPeerRef = useRef(null);
  const connRef = useRef(null);
  const [isPeerOnline, setIsPeerOnline] = useState(false);
  const [isRoomOnline, setIsRoomOnline] = useState(false);
  const [peerError, setPeerError] = useState("");
  const [peerRetryNonce, setPeerRetryNonce] = useState(0);
  // "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "rejected" | "expired" | "failed"
  const [connectionStatus, setConnectionStatus] = useState("idle");
  const [remotePeerId, setRemotePeerId] = useState("");
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const manualCloseRef = useRef(false);
  const isConnected = connectionStatus === "connected";
  const localStreamRef = useRef(null);

  // ---- incoming connection / call approval queue (rate-limited) ----
  const [incomingRequests, setIncomingRequests] = useState([]);
  const rejectHistoryRef = useRef({}); // peerId -> { count, blockedUntil }
  const pendingTimersRef = useRef({}); // requestId -> timeoutId

  // ---- connect-by-id form ----
  const [connectIdInput, setConnectIdInput] = useState("");
  const [connectError, setConnectError] = useState("");

  // ---- connect-by-room (QR) ----
  const [roomCode, setRoomCode] = useState(() => generateLocalRoomCode(ROOM_CODE_CHARS, ROOM_CODE_LENGTH));
  const [roomMode, setRoomMode] = useState("local"); // "local" | "server"
  const roomTokenRef = useRef(null);
  const roomCodeRef = useRef(roomCode);
  const urlRoomHintRef = useRef({ code: "", token: "" });
  const [manualRoomInput, setManualRoomInput] = useState("");
  const [connectMode, setConnectMode] = useState("qr"); // "qr" | "id"
  const [shareLink, setShareLink] = useState("");
  const qrContainerRef = useRef(null);

  // ---- screen share ----
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const [isMuted, setIsMuted] = useState(false);
  const [rotation, setRotation] = useState(0);

  // ---- chat ----
  const [messages, setMessages] = useState([
    {
      id: "1",
      text: "خوش اومدی! به Daricha خوش اومدید 👋 کافیه متن و صدا را ایمن و بدون سرور به اشتراک بگذارید",
      self: false,
      time: "اکنون",
      type: "text",
    },
  ]);
  const [messageInput, setMessageInput] = useState("");
  const [copiedField, setCopiedField] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);

  // ---- chunked file / voice transfer ----
  const [activeTransfers, setActiveTransfers] = useState([]);
  const transfersRef = useRef({}); // incoming: transferId -> { name, size, mime, kind, received, discarded, chain }
  const cancelFlagsRef = useRef({}); // outgoing: transferId -> boolean
  const objectUrlsRef = useRef(new Set());
  const trackObjectUrl = (url) => {
    objectUrlsRef.current.add(url);
    return url;
  };

  // ---- PWA install ----
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);
  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  // ---------------------------------------------------------------------
  // backend session — anonymous, short-lived, never tied to the @id
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!isBackendConfigured()) {
      setBackendStatus("local-only");
      return undefined;
    }
    let cancelled = false;
    createSession()
      .then((res) => {
        if (cancelled) return;
        sessionTokenRef.current = res.token;
        setBackendStatus("connected");
      })
      .catch(() => {
        if (!cancelled) setBackendStatus("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // TURN credentials (short-lived) once we know whether the backend is reachable
  useEffect(() => {
    if (backendStatus === "checking") return undefined;
    if (backendStatus !== "connected") {
      setIceServersReady(true); // no backend — proceed on STUN-only defaults
      return undefined;
    }
    let cancelled = false;
    fetchTurnCredentials(sessionTokenRef.current)
      .then((res) => {
        if (cancelled) return;
        setIceServers(res.iceServers?.length ? res.iceServers : DEFAULT_ICE_SERVERS);
        setTurnConfigured(Boolean(res.turnConfigured));
      })
      .catch(() => {
        // keep STUN-only defaults
      })
      .finally(() => {
        if (!cancelled) setIceServersReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [backendStatus]);

  // ---------------------------------------------------------------------
  // lifecycle: install prompt, ?host=/?room=/?rt= query params
  // ---------------------------------------------------------------------
  useEffect(() => {
    const onBeforeInstall = (event) => {
      event.preventDefault();
      setDeferredPrompt(event);
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    const params = new URLSearchParams(window.location.search);
    const hostFromQuery = params.get("host");
    if (hostFromQuery) setConnectIdInput(hostFromQuery);
    const roomFromQuery = params.get("room");
    if (roomFromQuery) {
      const code = roomFromQuery.toUpperCase();
      setManualRoomInput(code);
      urlRoomHintRef.current = { code, token: params.get("rt") || "" };
    }

    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  // Wake Lock: only worth holding while there's an actual live connection.
  useEffect(() => {
    if (!isConnected) return undefined;
    let wakeLock = null;
    let cancelled = false;
    (async () => {
      try {
        if ("wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
          if (cancelled) wakeLock.release().catch(() => {});
        }
      } catch {
        // ignore — wake lock isn't critical
      }
    })();
    return () => {
      cancelled = true;
      if (wakeLock) wakeLock.release().catch(() => {});
    };
  }, [isConnected]);

  // Screen sharing must not survive past the session that authorized it —
  // if the connection drops for any reason, stop sending video immediately.
  useEffect(() => {
    if (connectionStatus !== "connected" && localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
    }
  }, [connectionStatus]);

  // theme -> color-scheme
  useEffect(() => {
    document.documentElement.style.colorScheme = darkMode ? "dark" : "light";
  }, [darkMode]);

  // Share link only ever carries the temporary room code (+ an opaque
  // server token when available) — never the host's permanent username.
  useEffect(() => {
    if (!roomCode) return;
    let link = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    if (roomMode === "server" && roomTokenRef.current) {
      link += `&rt=${encodeURIComponent(roomTokenRef.current)}`;
    }
    setShareLink(link);
  }, [roomCode, roomMode]);

  // ---------------------------------------------------------------------
  // QR rendering — generated fully client-side, works offline too.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!shareLink || connectMode !== "qr" || !qrContainerRef.current) return undefined;
    const container = qrContainerRef.current;
    let cancelled = false;

    QRCode.toDataURL(shareLink, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: "H",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((dataUrl) => {
        if (cancelled) return;
        container.innerHTML = "";
        const img = document.createElement("img");
        img.alt = `QR for ${shareLink}`;
        img.width = 240;
        img.height = 240;
        img.style.display = "block";
        img.style.borderRadius = "8px";
        img.src = dataUrl;
        container.appendChild(img);
      })
      .catch(() => {
        if (cancelled) return;
        container.innerHTML =
          '<p style="color:#71717a;font-size:12px;text-align:center;max-width:200px">ساخت QR ممکن نشد — از اتصال با آیدی استفاده کن</p>';
      });

    return () => {
      cancelled = true;
    };
  }, [shareLink, connectMode]);

  // ---------------------------------------------------------------------
  // room lifecycle — real server-checked rooms when a backend is
  // available, a clearly-labelled weaker local fallback otherwise
  // ---------------------------------------------------------------------
  const requestNewRoom = useCallback(async () => {
    if (backendStatus === "connected") {
      try {
        const room = await apiCreateRoom(sessionTokenRef.current);
        roomTokenRef.current = room.token;
        setRoomCode(room.code);
        setRoomMode("server");
        return;
      } catch {
        // fall through to local mode on any backend hiccup
      }
    }
    roomTokenRef.current = null;
    setRoomCode(generateLocalRoomCode(ROOM_CODE_CHARS, ROOM_CODE_LENGTH));
    setRoomMode("local");
  }, [backendStatus]);

  useEffect(() => {
    if (!isLoggedIn || backendStatus === "checking") return;
    requestNewRoom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, backendStatus]);

  // Rooms auto-rotate periodically. A `setInterval` alone is not a real
  // security boundary (client code can be paused/edited) — the backend
  // independently enforces `expiresAt` on every validate/consume call, so
  // this is a UX nicety on top of a real server-side check, not the check
  // itself.
  useEffect(() => {
    if (!isLoggedIn) return undefined;
    const timer = setInterval(() => requestNewRoom(), ROOM_CODE_LIFETIME_MS);
    return () => clearInterval(timer);
  }, [isLoggedIn, requestNewRoom]);

  const rotateRoomAfterUse = useCallback(
    (usedCode) => {
      if (backendStatus === "connected" && usedCode) {
        apiConsumeRoom(sessionTokenRef.current, usedCode, roomTokenRef.current || "").catch(() => {});
      }
      requestNewRoom();
    },
    [backendStatus, requestNewRoom]
  );

  // ---------------------------------------------------------------------
  // chat helper
  // ---------------------------------------------------------------------
  const addMessage = (message) => {
    setMessages((prev) => [
      ...prev,
      {
        id: generateSecureId(6),
        time: new Date().toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" }),
        self: message.self ?? false,
        type: message.type || "text",
        ...message,
      },
    ]);
  };

  // ---------------------------------------------------------------------
  // incoming binary data (chat text + validated, chunked file/voice
  // transfer streamed to OPFS rather than buffered in RAM)
  // ---------------------------------------------------------------------
  const handleIncomingData = useCallback((data) => {
    if (!data || typeof data !== "object") return;

    if (data.type === "text") {
      if (typeof data.text !== "string" || data.text.length === 0 || data.text.length > MAX_MESSAGE_LENGTH) return;
      addMessage({ text: data.text, self: false, type: "text" });
      return;
    }

    if (data.type === "file-start") {
      const err = validateFileStart(data);
      if (err) {
        try {
          connRef.current?.send({ type: "file-cancel-request", transferId: data.transferId });
        } catch {
          // ignore
        }
        return;
      }
      const kind = data.kind || "file";
      const record = { name: data.name, size: data.size, mime: data.mime, kind, received: 0, discarded: false };
      record.chain = createTransferSink(data.transferId).catch(() => null);
      transfersRef.current[data.transferId] = record;
      setActiveTransfers((prev) => [
        ...prev,
        { id: data.transferId, name: data.name, size: data.size, kind, direction: "down", progress: 0 },
      ]);
      return;
    }

    if (data.type === "file-chunk") {
      const record = transfersRef.current[data.transferId];
      if (!record || record.discarded) return;
      const err = validateFileChunk(data, CHUNK_SIZE);
      if (err) {
        record.discarded = true;
        delete transfersRef.current[data.transferId];
        setActiveTransfers((prev) => prev.filter((t) => t.id !== data.transferId));
        record.chain?.then((sink) => sink?.abort());
        return;
      }
      const byteLength = data.chunk.byteLength;
      record.received += byteLength;
      if (record.received > record.size) {
        record.discarded = true;
        delete transfersRef.current[data.transferId];
        setActiveTransfers((prev) => prev.filter((t) => t.id !== data.transferId));
        record.chain.then((sink) => sink?.abort());
        addMessage({ text: `انتقال «${record.name}» بیشتر از حجم اعلام‌شده بود و لغو شد`, self: false, type: "text" });
        return;
      }
      record.chain = record.chain.then(async (sink) => {
        if (!sink || record.discarded) return sink;
        await sink.write(data.chunk);
        return sink;
      });
      const progress = record.size ? Math.min(100, Math.round((record.received / record.size) * 100)) : 0;
      setActiveTransfers((prev) => prev.map((t) => (t.id === data.transferId ? { ...t, progress } : t)));
      return;
    }

    if (data.type === "file-end") {
      const record = transfersRef.current[data.transferId];
      delete transfersRef.current[data.transferId];
      setActiveTransfers((prev) => prev.filter((t) => t.id !== data.transferId));
      if (!record || record.discarded) return;
      if (record.received !== record.size) {
        record.chain.then((sink) => sink?.abort());
        addMessage({ text: `انتقال «${record.name}» ناقص بود و نادیده گرفته شد`, self: false, type: "text" });
        return;
      }
      record.chain.then(async (sink) => {
        if (!sink) {
          addMessage({ text: `دریافت «${record.name}» با خطا مواجه شد`, self: false, type: "text" });
          return;
        }
        const blob = await sink.finalize(record.mime);
        const url = trackObjectUrl(URL.createObjectURL(blob));
        if (record.kind === "voice") {
          addMessage({ self: false, type: "voice", voiceUrl: url, time: "اکنون" });
        } else {
          setFiles((prev) => [...prev, { name: record.name, size: record.size, url, self: false }]);
          addMessage({
            text: `فایل دریافت شد: ${record.name}`,
            self: false,
            type: "file",
            fileName: record.name,
            fileSize: record.size,
            fileUrl: url,
          });
        }
      });
      return;
    }

    if (data.type === "file-cancel") {
      const record = transfersRef.current[data.transferId];
      delete transfersRef.current[data.transferId];
      setActiveTransfers((prev) => prev.filter((t) => t.id !== data.transferId));
      if (record) record.chain?.then((sink) => sink?.abort());
      addMessage({ text: "ارسال فایل توسط طرف مقابل لغو شد", self: false, type: "text" });
      return;
    }

    if (data.type === "file-cancel-request") {
      if (cancelFlagsRef.current[data.transferId] !== undefined) {
        cancelFlagsRef.current[data.transferId] = true;
      }
    }
  }, []);

  // ---------------------------------------------------------------------
  // outgoing chunked transfer (shared by file uploads and voice notes)
  // ---------------------------------------------------------------------
  const sendInChunks = useCallback((blob, name, kind) => {
    if (blob.size > MAX_FILE_SIZE) {
      addMessage({
        text: `حجم «${name}» (${formatFileSize(blob.size)}) بیشتر از حد مجاز (${formatFileSize(MAX_FILE_SIZE)}) است`,
        self: true,
        type: "text",
      });
      return;
    }
    const safeName = String(name).slice(0, MAX_FILE_NAME_LENGTH);
    const safeMime = MIME_PATTERN.test(blob.type || "") ? blob.type : "";

    // Optimistic local echo — shows up locally right away, connected or not.
    const localUrl = trackObjectUrl(URL.createObjectURL(blob));
    if (kind === "voice") {
      addMessage({ self: true, type: "voice", voiceUrl: localUrl, time: "اکنون" });
    } else {
      setFiles((prev) => [...prev, { name: safeName, size: blob.size, url: localUrl, self: true }]);
      addMessage({
        text: `فایل ارسال شد: ${safeName}`,
        self: true,
        type: "file",
        fileName: safeName,
        fileSize: blob.size,
        fileUrl: localUrl,
      });
    }

    const conn = connRef.current;
    if (!conn || !conn.open) return; // nothing connected — local-only

    const transferId = generateSecureId(8);
    cancelFlagsRef.current[transferId] = false;
    conn.send({ type: "file-start", transferId, name: safeName, size: blob.size, mime: safeMime, kind });
    setActiveTransfers((prev) => [
      ...prev,
      { id: transferId, name: safeName, size: blob.size, kind, direction: "up", progress: 0 },
    ]);

    let offset = 0;
    const reader = new FileReader();
    const finishTransfer = () => setActiveTransfers((prev) => prev.filter((t) => t.id !== transferId));

    const sendNext = () => {
      if (cancelFlagsRef.current[transferId]) {
        try {
          conn.send({ type: "file-cancel", transferId });
        } catch {
          // ignore
        }
        delete cancelFlagsRef.current[transferId];
        finishTransfer();
        return;
      }
      const dc = conn.dataChannel;
      if (dc && dc.bufferedAmount > BUFFERED_AMOUNT_LIMIT) {
        setTimeout(sendNext, 50);
        return;
      }
      reader.readAsArrayBuffer(blob.slice(offset, offset + CHUNK_SIZE));
    };

    reader.onload = (event) => {
      if (cancelFlagsRef.current[transferId]) {
        sendNext();
        return;
      }
      const chunk = event.target.result;
      try {
        conn.send({ type: "file-chunk", transferId, chunk });
      } catch {
        finishTransfer();
        return;
      }
      offset += chunk.byteLength;
      const progress = blob.size ? Math.min(100, Math.round((offset / blob.size) * 100)) : 100;
      setActiveTransfers((prev) => prev.map((t) => (t.id === transferId ? { ...t, progress } : t)));
      if (offset < blob.size) {
        sendNext();
      } else {
        try {
          conn.send({ type: "file-end", transferId });
        } catch {
          // ignore
        }
        delete cancelFlagsRef.current[transferId];
        finishTransfer();
      }
    };

    sendNext();
  }, []);

  const cancelTransfer = (transfer) => {
    if (transfer.direction === "up") {
      cancelFlagsRef.current[transfer.id] = true;
    } else {
      const record = transfersRef.current[transfer.id];
      if (record) record.discarded = true;
      setActiveTransfers((prev) => prev.filter((x) => x.id !== transfer.id));
      record?.chain?.then((sink) => sink?.abort());
      try {
        connRef.current?.send({ type: "file-cancel-request", transferId: transfer.id });
      } catch {
        // ignore
      }
    }
  };

  // ---------------------------------------------------------------------
  // reconnect (bounded, with backoff — then manual retry)
  // ---------------------------------------------------------------------
  const bindConnectionRef = useRef(() => {});

  const attemptReconnect = useCallback((targetPeerId) => {
    if (manualCloseRef.current || !peerRef.current || !targetPeerId) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      // a room-based connection that keeps failing almost certainly means
      // the (single-use, short-lived) room is simply gone, not a network blip
      setConnectionStatus(targetPeerId.startsWith("daricha-room-") ? "expired" : "disconnected");
      return;
    }
    setConnectionStatus("reconnecting");
    const delay = 2000 * 2 ** reconnectAttemptsRef.current;
    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectAttemptsRef.current += 1;
      try {
        const conn = peerRef.current.connect(targetPeerId, { reliable: true });
        let opened = false;
        conn.on("open", () => {
          opened = true;
          reconnectAttemptsRef.current = 0;
          bindConnectionRef.current(conn);
        });
        conn.on("error", () => {
          if (!opened) attemptReconnect(targetPeerId);
        });
      } catch {
        attemptReconnect(targetPeerId);
      }
    }, delay);
  }, []);

  // ---------------------------------------------------------------------
  // bind a data connection once it's approved
  // ---------------------------------------------------------------------
  const bindConnection = useCallback(
    (conn) => {
      connRef.current = conn;
      manualCloseRef.current = false;
      let hasOpened = false;

      const markOpen = () => {
        hasOpened = true;
        reconnectAttemptsRef.current = 0;
        setConnectionStatus("connected");
        setRemotePeerId(conn.peer);
        addMessage({ text: `متصل شد به ${labelForPeerId(conn.peer)}`, self: false, type: "text" });
      };
      // an incoming connection may already be open by the time the user
      // taps "قبول" (approval takes real time), so check both paths
      if (conn.open) markOpen();
      conn.on("open", markOpen);

      conn.on("data", handleIncomingData);

      conn.on("close", () => {
        if (manualCloseRef.current) {
          setConnectionStatus("idle");
          return;
        }
        if (!hasOpened) {
          // closed before ever opening = the other side declined, not a
          // network drop — don't chase it with reconnect attempts
          setConnectionStatus("rejected");
          return;
        }
        addMessage({ text: "اتصال قطع شد", self: false, type: "text" });
        attemptReconnect(conn.peer);
      });
    },
    [attemptReconnect, handleIncomingData]
  );

  useEffect(() => {
    bindConnectionRef.current = bindConnection;
  }, [bindConnection]);

  // ---------------------------------------------------------------------
  // consent queue — every unsolicited connection or call waits here.
  // Rate-limited: capped queue, no duplicate pending requests per peer,
  // auto-expiry, and a cooldown block after repeated rejections.
  // ---------------------------------------------------------------------
  const pushIncomingRequest = useCallback((kind, ref, source) => {
    const peerId = ref.peer;
    const history = rejectHistoryRef.current[peerId];
    if (history && history.blockedUntil > Date.now()) {
      try {
        ref.close();
      } catch {
        // ignore
      }
      return;
    }
    setIncomingRequests((prev) => {
      if (prev.length >= MAX_PENDING_REQUESTS || prev.some((r) => r.peerId === peerId)) {
        try {
          ref.close();
        } catch {
          // ignore
        }
        return prev;
      }
      const id = generateSecureId(8);
      pendingTimersRef.current[id] = setTimeout(() => {
        setIncomingRequests((curr) => curr.filter((r) => r.id !== id));
        try {
          ref.close();
        } catch {
          // ignore
        }
        delete pendingTimersRef.current[id];
      }, INCOMING_REQUEST_TIMEOUT_MS);
      return [...prev, { id, kind, ref, peerId, source }];
    });
  }, []);

  const handleIncomingConnection = useCallback((conn, source) => pushIncomingRequest("connection", conn, source), [pushIncomingRequest]);
  const handleIncomingCall = useCallback((call, source) => pushIncomingRequest("call", call, source), [pushIncomingRequest]);

  const respondToIncoming = (accept) => {
    setIncomingRequests((prev) => {
      const [current, ...rest] = prev;
      if (!current) return prev;
      if (pendingTimersRef.current[current.id]) {
        clearTimeout(pendingTimersRef.current[current.id]);
        delete pendingTimersRef.current[current.id];
      }
      if (accept) {
        delete rejectHistoryRef.current[current.peerId];
      } else {
        const h = rejectHistoryRef.current[current.peerId] || { count: 0, blockedUntil: 0 };
        h.count += 1;
        if (h.count >= MAX_REJECTS_BEFORE_BLOCK) h.blockedUntil = Date.now() + REJECT_COOLDOWN_MS;
        rejectHistoryRef.current[current.peerId] = h;
      }

      if (current.kind === "connection") {
        if (accept) {
          bindConnection(current.ref);
          if (current.source === "room") rotateRoomAfterUse(roomCodeRef.current);
        } else {
          try {
            current.ref.close();
          } catch {
            // ignore
          }
        }
      } else {
        if (accept) {
          current.ref.answer();
          current.ref.on("stream", (stream) => {
            setRemoteStream(stream);
            setConnectionStatus("connected");
            setRemotePeerId(current.ref.peer);
          });
          if (current.source === "room") rotateRoomAfterUse(roomCodeRef.current);
        } else {
          try {
            current.ref.close();
          } catch {
            // ignore
          }
        }
      }
      return rest;
    });
  };

  // ---------------------------------------------------------------------
  // permanent identity peer
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!isLoggedIn || !userId) return undefined;
    if (!navigator.onLine) {
      setPeerError("اینترنت وصل نیست — برای اتصال باید آنلاین باشید");
      return undefined;
    }
    if (!iceServersReady) return undefined;

    if (peerRef.current) {
      try {
        peerRef.current.destroy();
      } catch {
        // ignore
      }
    }
    setPeerError("");

    const peerId = `daricha-id-${userId}`;
    let peer;
    try {
      peer = new Peer(peerId, buildPeerOptions(iceServers));
    } catch (error) {
      setPeerError("خطا در ساخت اتصال: " + (error?.message || "ناشناخته"));
      return undefined;
    }
    peerRef.current = peer;

    peer.on("open", () => {
      setIsPeerOnline(true);
      setPeerError("");
    });

    peer.on("error", (error) => {
      setIsPeerOnline(false);
      if (error?.type === "unavailable-id" || String(error).includes("taken")) {
        setIdError("این آیدی قبلاً توسط دستگاه دیگری استفاده شده");
        setIsRegistering(false);
        try {
          peer.destroy();
        } catch {
          // ignore
        }
      } else {
        setPeerError("خطا در اتصال به سرور سیگنالینگ (" + (error?.type || "network") + ")");
      }
    });

    peer.on("connection", (conn) => handleIncomingConnection(conn, "main"));
    peer.on("call", (call) => handleIncomingCall(call, "main"));

    peer.on("disconnected", () => {
      setIsPeerOnline(false);
      try {
        peer.reconnect();
      } catch {
        // ignore
      }
    });

    return () => {
      try {
        peer.destroy();
      } catch {
        // ignore
      }
    };
  }, [isLoggedIn, userId, iceServersReady, iceServers, peerRetryNonce, handleIncomingConnection, handleIncomingCall]);

  // ---------------------------------------------------------------------
  // short-lived room peer — a genuinely separate rendezvous point
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!isLoggedIn || !navigator.onLine || !roomCode || !iceServersReady) return undefined;

    if (roomPeerRef.current) {
      try {
        roomPeerRef.current.destroy();
      } catch {
        // ignore
      }
    }
    setIsRoomOnline(false);

    const roomPeerId = `daricha-room-${roomCode}`;
    let roomPeer;
    try {
      roomPeer = new Peer(roomPeerId, buildPeerOptions(iceServers));
    } catch {
      return undefined;
    }
    roomPeerRef.current = roomPeer;

    roomPeer.on("open", () => setIsRoomOnline(true));
    roomPeer.on("error", (error) => {
      setIsRoomOnline(false);
      if (error?.type === "unavailable-id") requestNewRoom(); // astronomically unlikely collision — self-heal
    });
    roomPeer.on("connection", (conn) => handleIncomingConnection(conn, "room"));
    roomPeer.on("call", (call) => handleIncomingCall(call, "room"));

    return () => {
      try {
        roomPeer.destroy();
      } catch {
        // ignore
      }
    };
  }, [isLoggedIn, roomCode, iceServersReady, iceServers, handleIncomingConnection, handleIncomingCall, requestNewRoom]);

  // attach streams to <video> elements
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream]);
  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  // ---------------------------------------------------------------------
  // registration — only ever finalized after a real `open` from PeerServer
  // ---------------------------------------------------------------------
  const finalizeRegistration = (id) => {
    localStorage.setItem(STORAGE_KEY, id);
    setUserId(id);
    setIsLoggedIn(true);
    setIsRegistering(false);
    setIdError("");
  };

  const handleRegister = () => {
    const candidate = idInput.trim().toLowerCase();
    if (!ID_PATTERN.test(candidate)) {
      setIdError("آیدی باید 3-20 حرف کوچک انگلیسی، عدد یا _ باشد");
      return;
    }
    if (!navigator.onLine) {
      setIdError("برای ثبت‌نام باید به اینترنت متصل باشید");
      return;
    }
    setIsRegistering(true);
    setIdError("");

    let settled = false;
    let probe;
    try {
      probe = new Peer(`daricha-id-${candidate}`, buildPeerOptions());
    } catch (error) {
      setIsRegistering(false);
      setIdError("خطا در اتصال: " + (error?.message || "ناشناخته"));
      return;
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        probe.destroy();
      } catch {
        // ignore
      }
      setIsRegistering(false);
      setIdError("پاسخی از سرور دریافت نشد — دوباره تلاش کن");
    }, 10000);

    probe.on("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        probe.destroy();
      } catch {
        // ignore
      }
      finalizeRegistration(candidate);
    });

    probe.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        probe.destroy();
      } catch {
        // ignore
      }
      setIsRegistering(false);
      if (error?.type === "unavailable-id") {
        setIdError("این آیدی قبلاً توسط دستگاه دیگری استفاده شده");
      } else {
        setIdError("خطا در ثبت‌نام: ارتباط با سرور برقرار نشد");
      }
    });
  };

  // ---------------------------------------------------------------------
  // full teardown — used by both logout and unmount
  // ---------------------------------------------------------------------
  const performFullCleanup = useCallback(() => {
    manualCloseRef.current = true;
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);

    Object.values(pendingTimersRef.current).forEach(clearTimeout);
    pendingTimersRef.current = {};
    setIncomingRequests((prev) => {
      prev.forEach((r) => {
        try {
          r.ref.close();
        } catch {
          // ignore
        }
      });
      return [];
    });

    Object.values(transfersRef.current).forEach((record) => {
      record.discarded = true;
      record.chain?.then((sink) => sink?.abort());
    });
    transfersRef.current = {};
    setActiveTransfers([]);
    cancelFlagsRef.current = {};

    if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);

    try {
      connRef.current?.close();
    } catch {
      // ignore
    }
    try {
      peerRef.current?.destroy();
    } catch {
      // ignore
    }
    try {
      roomPeerRef.current?.destroy();
    } catch {
      // ignore
    }

    objectUrlsRef.current.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    });
    objectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    return () => performFullCleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = () => {
    performFullCleanup();
    localStorage.removeItem(STORAGE_KEY);
    setIsLoggedIn(false);
    setUserId(null);
    setConnectionStatus("idle");
  };

  // ---------------------------------------------------------------------
  // connecting to a remote peer
  // ---------------------------------------------------------------------
  const handleConnectById = () => {
    const target = connectIdInput.trim().toLowerCase().replace("@", "");
    setConnectError("");
    if (!target) {
      setConnectError("آیدی را وارد کن");
      return;
    }
    if (!ID_PATTERN.test(target)) {
      setConnectError("فرمت آیدی اشتباه است");
      return;
    }
    if (target === userId) {
      setConnectError("نمی‌تونی به خودت وصل شوی");
      return;
    }
    if (!peerRef.current) {
      setConnectError("هنوز آماده نیستی، صبر کن");
      return;
    }
    const peerId = `daricha-id-${target}`;
    reconnectAttemptsRef.current = 0;
    manualCloseRef.current = false;
    setConnectionStatus("connecting");
    try {
      const conn = peerRef.current.connect(peerId, { reliable: true });
      bindConnection(conn);
      if (localStream) peerRef.current.call(peerId, localStream);
      setRemotePeerId(peerId);
    } catch (error) {
      setConnectionStatus("failed");
      setConnectError("خطا: " + (error?.message || "اتصال ناموفق"));
    }
  };

  // joining a room connects to that room's own dedicated peer — a single
  // real address, not a guess across several id formats — and, when a
  // backend is available, is pre-validated server-side first (expiry +
  // one-time-use are enforced there, not just by a client-side timer).
  const handleConnectByRoom = async () => {
    const code = manualRoomInput.trim().toUpperCase();
    if (!code) return;
    if (!peerRef.current) {
      setConnectError("هنوز آماده نیستی، صبر کن");
      return;
    }
    setConnectError("");
    reconnectAttemptsRef.current = 0;
    manualCloseRef.current = false;
    setConnectionStatus("connecting");

    const hint = urlRoomHintRef.current;
    const token = hint.code === code ? hint.token : "";

    if (backendStatus === "connected") {
      try {
        const result = await apiValidateRoom(sessionTokenRef.current, code, token);
        if (result.status === "expired") {
          setConnectionStatus("expired");
          setConnectError("این اتاق منقضی شده — کد جدید بخواه");
          return;
        }
        if (result.status === "used") {
          setConnectionStatus("expired");
          setConnectError("این اتاق قبلاً استفاده شده — کد جدید بخواه");
          return;
        }
        if (result.status === "not_found") {
          setConnectionStatus("failed");
          setConnectError("این کد اتاق پیدا نشد");
          return;
        }
        // "ok" (or "invalid_token", which we ignore since manual entry has none) -> proceed
      } catch {
        // backend hiccup — degrade to attempting the P2P connect directly
      }
    }

    const target = `daricha-room-${code}`;
    const conn = peerRef.current.connect(target, { reliable: true });
    const timeout = setTimeout(() => {
      setConnectionStatus("failed");
      setConnectError("این کد اتاق پاسخ نداد — دوباره تلاش کن");
      try {
        conn.close();
      } catch {
        // ignore
      }
    }, 6000);
    conn.on("open", () => {
      clearTimeout(timeout);
      bindConnection(conn);
      if (backendStatus === "connected") {
        apiConsumeRoom(sessionTokenRef.current, code, token).catch(() => {});
      }
    });
    conn.on("error", () => {
      clearTimeout(timeout);
      setConnectionStatus("failed");
      setConnectError("این کد اتاق پیدا نشد یا منقضی شده");
    });
  };

  const handleManualRetry = () => {
    if (!remotePeerId) return;
    reconnectAttemptsRef.current = 0;
    manualCloseRef.current = false;
    attemptReconnect(remotePeerId);
  };

  // ---------------------------------------------------------------------
  // misc actions
  // ---------------------------------------------------------------------
  const copyToClipboard = async (text, field) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(""), 1500);
    } catch {
      // ignore
    }
  };

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") setCanInstall(false);
    setDeferredPrompt(null);
  };

  const sendMessage = () => {
    const text = messageInput.trim();
    const err = validateOutgoingText(text);
    if (err === "empty") return;
    if (err === "too_long") {
      addMessage({ text: `پیام باید کوتاه‌تر از ${MAX_MESSAGE_LENGTH} کاراکتر باشد`, self: true, type: "text" });
      return;
    }
    addMessage({ text, self: true, type: "text" });
    if (connRef.current?.open) connRef.current.send({ type: "text", text });
    setMessageInput("");
  };

  const handleFiles = (fileList) => {
    Array.from(fileList).forEach((file) => sendInChunks(file, file.name, "file"));
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      const chunks = [];
      let recordedBytes = 0;
      let sizeExceeded = false;

      const durationTimer = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, MAX_VOICE_DURATION_MS);

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        recordedBytes += event.data.size;
        if (recordedBytes > MAX_VOICE_SIZE) {
          sizeExceeded = true;
          if (recorder.state !== "inactive") recorder.stop();
          return;
        }
        chunks.push(event.data);
      };

      recorder.onstop = () => {
        clearTimeout(durationTimer);
        stream.getTracks().forEach((track) => track.stop());
        if (sizeExceeded) {
          addMessage({
            text: `پیام صوتی بیشتر از حد مجاز (${formatFileSize(MAX_VOICE_SIZE)}) بود و لغو شد`,
            self: true,
            type: "text",
          });
          return;
        }
        const blob = new Blob(chunks, { type: "audio/webm" });
        sendInChunks(blob, "پیام صوتی", "voice");
      };

      recorder.start(1000); // gather data every second so the size cap is checked responsively
      setIsRecording(true);
    } catch {
      // microphone permission denied or unavailable
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const startScreenShare = async () => {
    if (connectionStatus !== "connected") return; // screen share requires an accepted session
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" },
        audio: true,
      });
      setLocalStream(stream);
      if (peerRef.current && remotePeerId) {
        try {
          peerRef.current.call(remotePeerId, stream);
        } catch {
          // ignore
        }
      }
      stream.getVideoTracks()[0].onended = () => setLocalStream(null);
    } catch (error) {
      console.log(error);
    }
  };

  const stopScreenShare = () => {
    manualCloseRef.current = true;
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach((track) => track.stop());
      setRemoteStream(null);
    }
    try {
      connRef.current?.close();
    } catch {
      // ignore
    }
    setConnectionStatus("idle");
  };

  const captureScreenshot = () => {
    const video = remoteVideoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (rotation) {
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(video, -canvas.width / 2, -canvas.height / 2);
    } else {
      ctx.drawImage(video, 0, 0);
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = trackObjectUrl(URL.createObjectURL(blob));
      const a = document.createElement("a");
      a.href = url;
      a.download = `daricha-${Date.now()}.png`;
      a.click();
    });
  };

  const pendingRequest = incomingRequests[0];

  // =======================================================================
  // ---- render: registration screen ----
  // =======================================================================
  if (!isLoggedIn) {
    return (
      <div
        dir="rtl"
        className={`min-h-screen flex items-center justify-center p-4 transition-colors ${
          darkMode ? "bg-[#0a0a0b] text-white" : "bg-[#f8f7fb] text-zinc-900"
        }`}
      >
        <div
          className={`w-full max-w-[400px] rounded-[28px] p-8 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.15)] border ${
            darkMode ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-100"
          }`}
        >
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center text-white text-2xl font-bold mb-4">
              د
            </div>
            <h1 className="text-[26px] font-bold tracking-tight">به Daricha خوش آمدید</h1>
            <p className="text-[14px] mt-2 opacity-70">اتصال سریع امن و بدون واسطه</p>
          </div>

          <label className="text-[13px] font-semibold opacity-80 mb-2 block">یک آیدی برای خودت انتخاب کن</label>
          <div className="relative">
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">@</span>
            <input
              value={idInput}
              onChange={(e) => setIdInput(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="مثلا yasir123"
              maxLength={20}
              className={`w-full h-[52px] pr-9 pl-4 rounded-xl border text-[15px] outline-none transition-all ${
                darkMode
                  ? "bg-zinc-800 border-zinc-700 focus:border-violet-500"
                  : "bg-zinc-50 border-zinc-200 focus:border-violet-500 focus:bg-white"
              }`}
            />
          </div>
          <p className="text-[11px] mt-2 opacity-60">فقط حروف کوچک انگلیسی، عدد و _ ؛ بین 3 تا 20 کاراکتر</p>

          {idError && (
            <div className="mt-3 text-[13px] text-red-500 bg-red-50 dark:bg-red-950/30 p-2.5 rounded-lg">{idError}</div>
          )}

          <button
            onClick={handleRegister}
            disabled={isRegistering || idInput.length < 3}
            className="w-full mt-6 h-[52px] rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-semibold text-[15px] disabled:opacity-40 hover:opacity-95 transition-opacity flex items-center justify-center gap-2"
          >
            {isRegistering ? "در حال بررسی..." : "شروع کن"}
          </button>

          <div className="mt-6 text-center text-[11px] opacity-50">
            آیدی شما دائمی است و برای اتصال از راه دور استفاده می‌شود
          </div>
        </div>
      </div>
    );
  }

  // =======================================================================
  // ---- render: main app ----
  // =======================================================================
  return (
    <div
      dir="rtl"
      className={`min-h-screen transition-colors ${darkMode ? "bg-[#0a0a0b] text-zinc-100" : "bg-[#fbfafd] text-zinc-900"}`}
    >
      <div className="mx-auto w-full max-w-[520px] px-4 py-4 md:py-6" style={{ width: "clamp(320px, 92vw, 520px)" }}>
        {/* header */}
        <header
          className={`flex flex-wrap items-center justify-between gap-2 p-3 rounded-2xl border ${
            darkMode ? "bg-zinc-900/80 border-zinc-800 backdrop-blur" : "bg-white border-zinc-100 shadow-sm"
          }`}
        >
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center text-white font-bold">
              د
            </div>
            <div>
              <div className="font-bold text-[15px] leading-none">Daricha</div>
              <div
                className={`text-[11px] flex items-center gap-1 mt-0.5 ${
                  isPeerOnline ? "text-emerald-500" : "text-amber-500"
                }`}
              >
                {isPeerOnline ? <Wifi size={12} /> : <WifiOff size={12} />} {isPeerOnline ? "آنلاین" : "در حال اتصال"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {canInstall && (
              <button
                onClick={handleInstallClick}
                className="h-8 px-3 rounded-full text-[12px] font-medium bg-violet-600 text-white flex items-center gap-1.5 hover:bg-violet-700"
              >
                <Smartphone size={14} /> نصب به عنوان اپ
              </button>
            )}
            <button
              onClick={() => setDarkMode((v) => !v)}
              className={`w-8 h-8 rounded-full flex items-center justify-center border ${
                darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"
              }`}
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        {/* backend / peer error banners — honest about reduced guarantees */}
        {backendStatus === "unreachable" && (
          <div className="mt-3 p-2.5 rounded-2xl border bg-red-50 border-red-200 text-red-700 text-[11px] flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            اتصال به سرور بک‌اند برقرار نشد — اعتبارسنجی اتاق و TURN اختصاصی غیرفعال است (حالت محلی)
          </div>
        )}
        {backendStatus === "local-only" && (
          <div
            className={`mt-3 p-2.5 rounded-2xl border text-[11px] flex items-center gap-2 ${
              darkMode ? "bg-zinc-900 border-zinc-800 text-zinc-400" : "bg-zinc-50 border-zinc-200 text-zinc-500"
            }`}
          >
            بدون بک‌اند اجرا می‌شود — اعتبارسنجی اتاق سمت سرور و TURN اختصاصی فعال نیستند
          </div>
        )}
        {peerError && (
          <div className="mt-3 p-2.5 rounded-2xl border bg-red-50 border-red-200 text-red-700 text-[11px] flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <AlertTriangle size={14} className="shrink-0" /> {peerError}
            </span>
            <button
              onClick={() => setPeerRetryNonce((n) => n + 1)}
              className="h-7 px-3 rounded-full text-[11px] font-medium bg-white border border-red-200 shrink-0"
            >
              تلاش دوباره
            </button>
          </div>
        )}

        {/* identity card */}
        <div
          className={`mt-3 flex items-center justify-between p-3 rounded-2xl border ${
            darkMode ? "bg-violet-950/30 border-violet-900/50" : "bg-violet-50 border-violet-100"
          }`}
        >
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                darkMode ? "bg-violet-900 text-violet-200" : "bg-violet-200 text-violet-700"
              }`}
            >
              <User size={16} />
            </div>
            <div>
              <div className="text-[11px] opacity-70">آیدی شما:</div>
              <div className="font-mono font-bold text-[14px]">@{userId}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => copyToClipboard(userId, "id")}
              className={`h-8 px-3 rounded-full text-[12px] flex items-center gap-1 border ${
                darkMode ? "bg-zinc-900 border-zinc-700" : "bg-white border-zinc-200"
              }`}
            >
              {copiedField === "id" ? <Check size={14} /> : <Copy size={14} />} {copiedField === "id" ? "کپی شد" : "کپی"}
            </button>
            <button
              onClick={handleLogout}
              className={`w-8 h-8 rounded-full flex items-center justify-center border ${
                darkMode ? "bg-zinc-900 border-zinc-700" : "bg-white border-zinc-200"
              }`}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>

        {/* incoming connection / call approval */}
        {pendingRequest && (
          <div
            className={`mt-3 p-3 rounded-2xl border flex items-center justify-between gap-2 ${
              darkMode ? "bg-amber-950/30 border-amber-900/50" : "bg-amber-50 border-amber-200"
            }`}
          >
            <div className="text-[12px] min-w-0">
              <div className="font-bold">{pendingRequest.kind === "connection" ? "درخواست اتصال جدید" : "درخواست اشتراک صفحه"}</div>
              <div className="opacity-70 mt-0.5 truncate">
                {labelForPeerId(pendingRequest.peerId)}{" "}
                {pendingRequest.kind === "connection" ? "می‌خواهد به شما وصل شود" : "می‌خواهد با شما تماس تصویری بگیرد"}
              </div>
              {incomingRequests.length > 1 && (
                <div className="opacity-50 mt-0.5">+{incomingRequests.length - 1} درخواست دیگر در صف</div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={() => respondToIncoming(true)} className="h-8 px-3 rounded-full text-[12px] font-medium bg-emerald-600 text-white">
                قبول
              </button>
              <button onClick={() => respondToIncoming(false)} className="h-8 px-3 rounded-full text-[12px] font-medium bg-red-500 text-white">
                رد
              </button>
            </div>
          </div>
        )}

        {/* connection status */}
        {connectionStatus !== "idle" && (
          <div
            className={`mt-3 flex items-center justify-between p-2.5 rounded-2xl border text-[12px] ${
              darkMode ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-100"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  connectionStatus === "connected"
                    ? "bg-emerald-500"
                    : connectionStatus === "connecting" || connectionStatus === "reconnecting"
                    ? "bg-amber-500 animate-pulse"
                    : "bg-red-500"
                }`}
              />
              <span className="font-medium">
                {connectionStatus === "connected" && `متصل به ${labelForPeerId(remotePeerId)}`}
                {connectionStatus === "connecting" && "در حال اتصال..."}
                {connectionStatus === "reconnecting" &&
                  `تلاش مجدد برای اتصال... (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`}
                {connectionStatus === "disconnected" && "اتصال قطع شد"}
                {connectionStatus === "rejected" && "درخواست اتصال رد شد"}
                {connectionStatus === "expired" && "این اتاق منقضی یا قبلاً استفاده شده بود"}
                {connectionStatus === "failed" && "اتصال ناموفق بود"}
              </span>
            </div>
            {connectionStatus === "disconnected" && (
              <button
                onClick={handleManualRetry}
                className={`h-7 px-3 rounded-full text-[11px] font-medium flex items-center gap-1 border ${
                  darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"
                }`}
              >
                <RefreshCw size={12} /> تلاش مجدد
              </button>
            )}
          </div>
        )}

        {/* connect mode switch */}
        <div className={`mt-4 flex p-1 rounded-2xl ${darkMode ? "bg-zinc-900" : "bg-zinc-100"}`}>
          <button
            onClick={() => setConnectMode("qr")}
            className={`flex-1 h-10 rounded-xl text-[13px] font-semibold transition-all flex items-center justify-center gap-1.5 ${
              connectMode === "qr" ? (darkMode ? "bg-zinc-800 text-white shadow" : "bg-white text-zinc-900 shadow") : "opacity-60"
            }`}
          >
            <Link2 size={16} /> اتصال سریع با QR
          </button>
          <button
            onClick={() => setConnectMode("id")}
            className={`flex-1 h-10 rounded-xl text-[13px] font-semibold transition-all flex items-center justify-center gap-1.5 ${
              connectMode === "id" ? (darkMode ? "bg-zinc-800 text-white shadow" : "bg-white text-zinc-900 shadow") : "opacity-60"
            }`}
          >
            <User size={16} /> اتصال از راه دور با آیدی
          </button>
        </div>

        {/* QR panel */}
        {connectMode === "qr" && (
          <div className={`mt-4 rounded-[24px] border p-4 ${darkMode ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-100 shadow-sm"}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-[14px] flex items-center gap-1.5">
                کد سریع اتصال
                <span
                  className={`w-1.5 h-1.5 rounded-full ${isRoomOnline ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`}
                  title={isRoomOnline ? "اتاق فعال است" : "در حال ساخت اتاق..."}
                />
              </h3>
              <button onClick={() => requestNewRoom()} className="text-[11px] text-violet-600 font-medium">
                تولید کد جدید
              </button>
            </div>
            <div className="w-full flex justify-center" style={{ padding: "8px", overflow: "visible" }}>
              <div
                className="relative flex items-center justify-center"
                style={{
                  background: "white",
                  padding: "24px",
                  borderRadius: "24px",
                  minHeight: "300px",
                  width: "100%",
                  maxWidth: "320px",
                  border: "2px solid #e5e7eb",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  overflow: "visible",
                }}
              >
                <div ref={qrContainerRef} style={{ width: 240, height: 240, display: "flex", justifyContent: "center", alignItems: "center" }} />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-white rounded-full shadow-lg border border-zinc-200 flex items-center justify-center">
                  <Monitor size={20} className="text-violet-600" />
                </div>
              </div>
            </div>

            <div className={`mt-4 p-3 rounded-xl flex items-center justify-between ${darkMode ? "bg-zinc-800" : "bg-zinc-50"}`}>
              <div>
                <div className="text-[11px] opacity-60">
                  کد اتاق (تا ۱۰ دقیقه معتبر) — {roomMode === "server" ? "بررسی‌شده توسط سرور" : "فقط محلی"}
                </div>
                <div className="font-mono font-bold text-[18px] tracking-widest">{roomCode}</div>
              </div>
              <button
                onClick={() => copyToClipboard(roomCode, "room")}
                className={`h-9 px-4 rounded-full text-[12px] font-medium flex items-center gap-1 ${darkMode ? "bg-zinc-700" : "bg-white border"}`}
              >
                {copiedField === "room" ? <Check size={14} /> : <Copy size={14} />} {copiedField === "room" ? "کپی شد" : "کپی"}
              </button>
            </div>

            <div className="mt-3">
              <label className="text-[12px] font-medium opacity-70">اتصال دستی با کد اتاق</label>
              <div className="mt-1.5 flex gap-2">
                <input
                  value={manualRoomInput}
                  onChange={(e) => setManualRoomInput(e.target.value.toUpperCase())}
                  placeholder="مثلا A1B2C3D4"
                  className={`flex-1 h-11 px-4 rounded-xl border font-mono text-[14px] outline-none ${
                    darkMode
                      ? "bg-zinc-800 border-zinc-700 focus:border-violet-500"
                      : "bg-zinc-50 border-zinc-200 focus:border-violet-500 focus:bg-white"
                  }`}
                />
                <button onClick={handleConnectByRoom} className="h-11 px-5 rounded-xl bg-zinc-900 dark:bg-white dark:text-zinc-900 text-white text-[13px] font-semibold">
                  وصل
                </button>
              </div>
              {connectError && (
                <div className="mt-2 text-[12px] text-red-500 bg-red-50 dark:bg-red-950/30 p-2 rounded-lg">{connectError}</div>
              )}
            </div>
          </div>
        )}

        {/* connect-by-id panel */}
        {connectMode === "id" && (
          <div className={`mt-4 rounded-[24px] border p-5 ${darkMode ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-100 shadow-sm"}`}>
            <h3 className="font-bold text-[15px] mb-1">اتصال از راه دور با آیدی</h3>
            <p className="text-[12px] opacity-60 mb-4">آیدی دوستت را وارد کن تا بدون QR از هر جای دنیا وصل شوی</p>
            <div className="relative">
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400">@</span>
              <input
                value={connectIdInput}
                onChange={(e) => setConnectIdInput(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="مثلا ahmad123"
                className={`w-full h-[52px] pr-9 pl-4 rounded-xl border text-[15px] outline-none ${
                  darkMode
                    ? "bg-zinc-800 border-zinc-700 focus:border-violet-500"
                    : "bg-zinc-50 border-zinc-200 focus:border-violet-500 focus:bg-white"
                }`}
              />
            </div>
            {connectError && (
              <div className="mt-2 text-[12px] text-red-500 bg-red-50 dark:bg-red-950/30 p-2 rounded-lg">{connectError}</div>
            )}
            <button
              onClick={handleConnectById}
              disabled={!connectIdInput}
              className="w-full mt-4 h-[48px] rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold text-[14px] disabled:opacity-40 flex items-center justify-center gap-2"
            >
              <Wifi size={18} /> وصل شو به @{connectIdInput || "..."}
            </button>

            <div className={`mt-6 p-3 rounded-xl ${darkMode ? "bg-zinc-800/60" : "bg-zinc-50"}`}>
              <div className="text-[11px] font-bold opacity-70 mb-2">چطور کار می‌کند؟</div>
              <ul className="text-[11px] leading-6 opacity-70 list-disc pr-4">
                <li>هر نفر یک آیدی دائمی دارد (مثل نام کاربری)</li>
                <li>QR/کد اتاق برای اتصال سریع و موقت است — آیدی شما را فاش نمی‌کند</li>
                <li>آیدی برای اتصال از راه دور و همیشگی است</li>
                <li>هر درخواست اتصال یا اشتراک صفحه باید توسط شما تأیید شود</li>
                <li>
                  لینک دعوت دائمی شما: <span className="font-mono text-violet-600">{window.location.origin}?host={userId}</span>
                </li>
              </ul>
              <button
                onClick={() => copyToClipboard(`${window.location.origin}${window.location.pathname}?host=${userId}`, "link")}
                className="mt-3 h-8 px-3 rounded-full bg-white dark:bg-zinc-700 border text-[11px] flex items-center gap-1"
              >
                {copiedField === "link" ? <Check size={12} /> : <ExternalLink size={12} />} کپی لینک دعوت
              </button>
            </div>
          </div>
        )}

        {/* screen panel */}
        <div className={`mt-4 rounded-[24px] border overflow-hidden ${darkMode ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-100 shadow-sm"}`}>
          <div className="p-3 flex items-center justify-between">
            <h4 className="font-bold text-[13px]">صفحه نمایش</h4>
            <div className="flex items-center gap-1.5">
              {remoteStream && (
                <>
                  <button
                    onClick={() => setIsMuted((v) => !v)}
                    className={`w-8 h-8 rounded-full flex items-center justify-center border ${darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"}`}
                  >
                    {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  </button>
                  <button
                    onClick={() => setRotation((r) => (r + 90) % 360)}
                    className={`w-8 h-8 rounded-full flex items-center justify-center border ${darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"}`}
                  >
                    <RotateCw size={14} />
                  </button>
                  <button
                    onClick={captureScreenshot}
                    className={`w-8 h-8 rounded-full flex items-center justify-center border ${darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"}`}
                  >
                    <Camera size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (!remoteVideoRef.current) return;
                      if (document.fullscreenElement) document.exitFullscreen();
                      else remoteVideoRef.current.requestFullscreen();
                    }}
                    className={`w-8 h-8 rounded-full flex items-center justify-center border ${darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"}`}
                  >
                    <Maximize size={14} />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="relative bg-black aspect-video flex items-center justify-center overflow-hidden">
            {remoteStream ? (
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                muted={isMuted}
                style={{ transform: `rotate(${rotation}deg)`, width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : (
              <div className="text-center p-6">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-zinc-800 flex items-center justify-center mb-3">
                  <Monitor className="text-zinc-400" />
                </div>
                <p className="text-zinc-400 text-[12px]">هنوز صفحه‌ای به اشتراک گذاشته نشده</p>
                <p className="text-zinc-500 text-[11px] mt-1">پس از اتصال، اشتراک را شروع کنید</p>
              </div>
            )}
            {localStream && (
              <video ref={localVideoRef} autoPlay muted playsInline className="absolute bottom-2 left-2 w-24 h-16 rounded-lg border border-white/20 bg-black object-cover" />
            )}
          </div>

          <div className="p-3 flex flex-wrap gap-2">
            <button
              onClick={startScreenShare}
              disabled={connectionStatus !== "connected"}
              title={connectionStatus !== "connected" ? "ابتدا باید یک اتصال تأییدشده داشته باشید" : undefined}
              className="flex-1 h-11 rounded-xl bg-violet-600 text-white font-semibold text-[13px] flex items-center justify-center gap-2 hover:bg-violet-700 disabled:opacity-40"
            >
              <Monitor size={16} /> اشتراک صفحه
            </button>
            <button
              onClick={stopScreenShare}
              className={`h-11 px-4 rounded-xl border font-medium text-[13px] flex items-center gap-1.5 ${darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"}`}
            >
              <X size={14} /> قطع
            </button>
          </div>
        </div>

        {/* chat panel */}
        <div className={`mt-4 rounded-[24px] border overflow-hidden ${darkMode ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-100 shadow-sm"}`}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
            }}
            className={`m-3 rounded-2xl border-2 border-dashed p-4 text-center transition-colors ${
              isDragging
                ? "border-violet-500 bg-violet-50 dark:bg-violet-950/20"
                : darkMode
                ? "border-zinc-700 bg-zinc-800/50"
                : "border-zinc-200 bg-zinc-50"
            }`}
          >
            <Paperclip size={20} className="mx-auto mb-2 opacity-60" />
            <p className="text-[12px] font-medium">فایل‌ها را اینجا بکش و رها کن</p>
            <p className="text-[11px] opacity-60 mt-1">حداکثر {formatFileSize(MAX_FILE_SIZE)} برای هر فایل</p>
            <input type="file" multiple className="hidden" id="file-input" onChange={(e) => e.target.files && handleFiles(e.target.files)} />
            <label htmlFor="file-input" className="mt-3 inline-flex h-8 px-4 rounded-full bg-zinc-900 dark:bg-white dark:text-zinc-900 text-white text-[12px] items-center justify-center cursor-pointer">
              انتخاب فایل
            </label>
          </div>

          {activeTransfers.length > 0 && (
            <div className="px-3 pb-2 space-y-1.5">
              {activeTransfers.map((t) => (
                <div key={t.id} className={`p-2 rounded-xl border text-[11px] ${darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"}`}>
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="truncate">
                      {t.direction === "up" ? "در حال ارسال" : "در حال دریافت"}: {t.name}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="opacity-60">{t.progress}%</span>
                      <button onClick={() => cancelTransfer(t)} className="opacity-60 hover:opacity-100">
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-300/40 overflow-hidden">
                    <div className="h-full bg-violet-600 transition-all" style={{ width: `${t.progress}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {files.length > 0 && (
            <div className="px-3 pb-2 flex flex-wrap gap-2">
              {files.map((file, index) => (
                <a
                  key={index}
                  href={file.url}
                  download={file.name}
                  className={`text-[11px] px-3 py-1.5 rounded-full border flex items-center gap-1.5 ${darkMode ? "bg-zinc-800 border-zinc-700" : "bg-zinc-50 border-zinc-200"}`}
                >
                  <span className="max-w-[80px] truncate">{file.name}</span> <span className="opacity-60">{formatFileSize(file.size)}</span>
                </a>
              ))}
            </div>
          )}

          <div className="h-[280px] overflow-y-auto p-3 space-y-2">
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.self ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[78%] rounded-[16px] px-3.5 py-2.5 text-[13px] leading-6 ${
                    message.self ? "bg-violet-600 text-white rounded-br-[6px]" : darkMode ? "bg-zinc-800 rounded-bl-[6px]" : "bg-zinc-100 rounded-bl-[6px]"
                  }`}
                >
                  {/* Remote text always goes through React's normal text
                      rendering (never innerHTML), so it can never execute
                      as markup regardless of what a peer sends. */}
                  {message.type === "text" && <span>{message.text}</span>}
                  {message.type === "file" && (
                    <div>
                      <div className="font-medium">{message.fileName}</div>
                      <div className="text-[11px] opacity-70">{message.fileSize ? formatFileSize(message.fileSize) : ""}</div>
                      {message.fileUrl && (
                        <a href={message.fileUrl} download={message.fileName} className="mt-1 inline-flex text-[11px] underline">
                          دانلود
                        </a>
                      )}
                    </div>
                  )}
                  {message.type === "voice" && <audio controls src={message.voiceUrl} className="w-[180px] h-8" />}
                  <div className="text-[10px] opacity-60 mt-1 text-left" dir="ltr">
                    {message.time}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className={`p-2.5 border-t flex items-center gap-2 ${darkMode ? "border-zinc-800 bg-zinc-900" : "border-zinc-100 bg-white"}`}>
            <button
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onTouchStart={startRecording}
              onTouchEnd={stopRecording}
              className={`w-10 h-10 rounded-full flex items-center justify-center ${isRecording ? "bg-red-500 text-white animate-pulse" : "bg-zinc-100 dark:bg-zinc-800"}`}
            >
              <Mic size={18} />
            </button>
            <input
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="پیام بنویس..."
              maxLength={MAX_MESSAGE_LENGTH}
              className={`flex-1 h-10 px-4 rounded-full border outline-none text-[13px] ${
                darkMode ? "bg-zinc-800 border-zinc-700 focus:border-violet-500" : "bg-zinc-50 border-zinc-200 focus:border-violet-500 focus:bg-white"
              }`}
            />
            <button onClick={sendMessage} className="w-10 h-10 rounded-full bg-violet-600 text-white flex items-center justify-center">
              <Send size={16} className="rtl:rotate-180" />
            </button>
          </div>
        </div>

        <footer className="mt-8 text-center pb-6">
          <div
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-[11px] border ${
              darkMode ? "bg-zinc-900 border-zinc-800 text-zinc-400" : "bg-white border-zinc-100 text-zinc-500"
            }`}
          >
            <span>ساخته شده با ♥ توسط</span>
            <a href="https://instagram.com/yasir.arb" target="_blank" rel="noopener noreferrer" className="font-bold text-violet-600 flex items-center gap-1">
              <ExternalLink size={12} /> Yasir.arb
            </a>
            <span>— Instagram: @yasir.arb</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
