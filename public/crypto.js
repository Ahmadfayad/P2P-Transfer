import { publicKey, aad } from "./protocol.js";
export async function identity() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
  return {
    privateKey: keys.privateKey,
    publicKey: publicKey(await crypto.subtle.exportKey("jwk", keys.publicKey)),
  };
}
export async function fingerprint(key) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(publicKey(key))),
  );
  return Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function shared(privateKey, key) {
  const peer = await crypto.subtle.importKey(
    "jwk",
    publicKey(key),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: peer },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encrypt(key, transfer, index, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(transfer, index) },
      key,
      data,
    ),
  );
  const result = new Uint8Array(iv.length + cipher.length);
  result.set(iv);
  result.set(cipher, 12);
  return result;
}
export async function decrypt(key, transfer, index, data) {
  const bytes = new Uint8Array(data);
  return crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(0, 12),
      additionalData: aad(transfer, index),
    },
    key,
    bytes.slice(12),
  );
}
