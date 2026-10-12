export const MAX_FILE = 150 * 1024 * 1024;
export const CHUNK_SIZE = 512 * 1024;
export const WINDOW_SIZE = 4;
export const LOCAL_LIMIT = 300 * 1024 * 1024;
export const TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
export const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const diagnosticRoutes = [
  "/api/health",
  "/api/rooms",
  "/api/rooms/:room/join",
  "/api/rooms/:room",
  "/api/rooms/:room/state",
  "/api/rooms/:room/diagnostics",
  "/api/rooms/:room/peers/:peer",
  "/api/rooms/:room/events",
  "/api/rooms/:room/transfers",
  ...["accept", "reject", "ack", "complete"].map(
    (action) => "/api/rooms/:room/transfers/:transfer/" + action,
  ),
  "/api/rooms/:room/transfers/:transfer/chunks/:index",
  ...["sign-in/email", "sign-out", "get-session", "change-password"].map(
    (path) => "/api/auth/" + path,
  ),
  ...["users", "role", "status", "password", "diagnostics"].map(
    (path) => "/api/admin/" + path,
  ),
];
export function diagnosticRoute(value) {
  const path = String(value || "").split(/[?#]/)[0];
  if (diagnosticRoutes.includes(path)) return path;
  const parts = path.split("/");
  if (parts[1] !== "api" || parts[2] !== "rooms" || !uuid(parts[3]))
    return "[unknown-route]";
  parts[3] = ":room";
  if (parts[4] === "peers" && uuid(parts[5])) parts[5] = ":peer";
  if (parts[4] === "transfers" && uuid(parts[5])) {
    parts[5] = ":transfer";
    if (parts[6] === "chunks" && /^\d{1,3}$/.test(parts[7]))
      parts[7] = ":index";
  }
  const route = parts.join("/");
  return diagnosticRoutes.includes(route) ? route : "[unknown-route]";
}
export function diagnosticRecord(row) {
  const entry = {
    route: diagnosticRoute(row.route),
    method: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"].includes(
      row.method,
    )
      ? row.method
      : "[unknown-method]",
    request_id: uuid(row.request_id) ? row.request_id : null,
  };
  if (row.room !== undefined) entry.room = uuid(row.room) ? row.room : null;
  for (const name of ["time", "status", "duration"])
    if (
      typeof row[name] === "number" &&
      Number.isFinite(row[name]) &&
      row[name] >= 0
    )
      entry[name] = row[name];
  return entry;
}
export function fileType(name) {
  return TYPES[String(name).split(".").pop().toLowerCase()] || "";
}
export function validFile(file) {
  return (
    file &&
    typeof file.name === "string" &&
    file.name.length <= 180 &&
    !/[\u0000-\u001f\u007f/\\]/.test(file.name) &&
    Boolean(fileType(file.name)) &&
    Number.isSafeInteger(file.size) &&
    file.size > 0 &&
    file.size <= MAX_FILE
  );
}
export function validKey(key) {
  return (
    key &&
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(key.x) &&
    /^[A-Za-z0-9_-]{43}$/.test(key.y) &&
    !key.d
  );
}
export function publicKey(key) {
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y };
}
export function chunkCount(size) {
  return Math.ceil(size / CHUNK_SIZE);
}
export function chunkLength(size, index) {
  return Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE);
}
export function aad(transfer, index) {
  return new TextEncoder().encode(
    JSON.stringify([
      transfer.room,
      transfer.id,
      transfer.from,
      transfer.to,
      transfer.name,
      transfer.size,
      index,
    ]),
  );
}
export function validSignature(bytes, name) {
  const b = new Uint8Array(bytes);
  switch (fileType(name)) {
    case "application/pdf":
      return new TextDecoder().decode(b.subarray(0, 5)) === "%PDF-";
    case "image/png":
      return [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v);
    case "image/jpeg":
      return b[0] === 255 && b[1] === 216 && b[2] === 255;
    // shortcut: DOCX is checked as a ZIP container and is download-only; use a document scanner if content validation is required.
    default:
      return b[0] === 80 && b[1] === 75 && b[2] === 3 && b[3] === 4;
  }
}
export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
