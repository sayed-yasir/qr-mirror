// Streams incoming file chunks straight to the Origin Private File System
// instead of buffering the whole transfer in a JS array in RAM. A 200MB
// transfer costs ~200MB of disk in OPFS instead of ~200MB of heap that a
// mobile browser tab may not have.
//
// Falls back to an in-memory chunk array on browsers without OPFS support
// (older Safari, some in-app browsers) — capped by the same MAX_FILE_SIZE,
// so it degrades gracefully rather than crashing, just without the memory
// benefit.

export function isOpfsSupported() {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

async function getIncomingDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("daricha-incoming", { create: true });
}

/**
 * Creates a writer for one incoming transfer. Returns an object with
 * write/finalize/abort — the same shape regardless of whether OPFS is
 * available, so callers don't need to branch.
 */
export async function createTransferSink(transferId) {
  if (isOpfsSupported()) {
    try {
      const dir = await getIncomingDir();
      const fileHandle = await dir.getFileHandle(transferId, { create: true });
      const writable = await fileHandle.createWritable();
      return {
        mode: "opfs",
        async write(chunk) {
          await writable.write(chunk);
        },
        async finalize(mime) {
          await writable.close();
          const file = await fileHandle.getFile();
          const blob = file.type === (mime || "") ? file : new Blob([file], { type: mime || "application/octet-stream" });
          return blob;
        },
        async abort() {
          try {
            await writable.abort();
          } catch {
            // ignore
          }
          try {
            await dir.removeEntry(transferId);
          } catch {
            // ignore
          }
        },
        async cleanup() {
          try {
            await dir.removeEntry(transferId);
          } catch {
            // ignore
          }
        },
      };
    } catch {
      // fall through to the in-memory sink below if OPFS exists but a
      // call still failed (quota, permissions, private browsing, ...)
    }
  }

  const chunks = [];
  return {
    mode: "memory",
    async write(chunk) {
      chunks.push(chunk);
    },
    async finalize(mime) {
      return new Blob(chunks, { type: mime || "application/octet-stream" });
    },
    async abort() {
      chunks.length = 0;
    },
    async cleanup() {
      chunks.length = 0;
    },
  };
}
