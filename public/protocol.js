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
