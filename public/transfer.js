import { chunkCount, fileType } from "./protocol.js";
import * as db from "./storage.js";
import { trackedFetch } from "./diagnostics.js";

export async function request(
  path,
  { method = "GET", body, token, headers = {}, signal } = {},
) {
  if (token) headers.Authorization = "Bearer " + token;
  if (body && !(body instanceof Uint8Array) && !(body instanceof Blob)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await trackedFetch("/api" + path, {
    method,
    body,
    headers,
    cache: "no-store",
    signal: signal || AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(
      detail.error || "The service is temporarily unavailable.",
    );
    error.status = response.status;
    throw error;
  }
  return response;
}
export async function finishFile(file) {
  if (file.blob) return;
  const saved = await db.get("files", file.id);
  if (saved?.blob) {
    Object.assign(file, saved);
    return;
  }
  const chunks = (await db.all("chunks"))
    .filter((c) => c.transfer === file.id)
    .sort((a, b) => a.index - b.index);
  if (
    chunks.length !== chunkCount(file.size) ||
    chunks.some((c, i) => c.index !== i)
  ) {
    const finished = await db.get("files", file.id);
    if (finished?.blob) {
      Object.assign(file, finished);
      return;
    }
    throw new Error("Saved chunks are missing. Ask the sender to resend.");
  }
  const blob = new Blob(
    chunks.map((c) => c.data),
    { type: fileType(file.name) },
  );
  if (blob.size !== file.size) throw new Error("File verification failed.");
  file.blob = blob;
  file.completed = Date.now();
  await db.transaction(["files", "chunks"], (s) => {
    s.files.put(file);
    for (const c of chunks) s.chunks.delete(c.id);
  });
}
export { Exchange } from "./stream-transfer.js";
