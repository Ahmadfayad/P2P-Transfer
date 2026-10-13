import { diagnosticRoute, diagnosticRecord, uuid } from "./protocol.js";
const errorNames = new Set([
  "Error",
  "TypeError",
  "TimeoutError",
  "AbortError",
  "NetworkError",
  "QuotaExceededError",
  "InvalidStateError",
  "NotFoundError",
  "SecurityError",
  "DataError",
  "OperationError",
  "UnknownError",
  "ConstraintError",
]);
const eventNames = new Set([
  "request",
  "request-failed",
  "online",
  "offline",
  "pageshow",
  "pagehide",
  "visibility",
  "browser-error",
  "unhandled-error",
  "page-start",
  "notice",
  "connection-retry",
  "transfer-retry",
  "send-chunk",
  "stream-failed",
  "stream-sent",
  "stream-received",
  "stream-fallback",
  "push-open",
  "push-closed",
  "webrtc-connectionstatechange",
  "webrtc-iceconnectionstatechange",
  "webrtc-icegatheringstatechange",
  "webrtc-signalingstatechange",
]);
const states = new Set([
  "new",
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "closed",
  "checking",
  "completed",
  "gathering",
  "complete",
  "stable",
  "have-local-offer",
  "have-remote-offer",
  "have-local-pranswer",
  "have-remote-pranswer",
  "direct",
  "https",
  "received",
  "download-initiated",
  "disk-saved",
  "visible",
  "hidden",
]);
export function safeMessage(value) {
  return errorNames.has(value) ? value : "Error";
}
function safeEntry(event, detail, time = new Date().toISOString()) {
  const entry = {
    time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)
      ? time
      : new Date().toISOString(),
    event: eventNames.has(event) ? event : "notice",
  };
  if (
    ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"].includes(detail.method)
  )
    entry.method = detail.method;
  if (detail.route !== undefined) entry.route = diagnosticRoute(detail.route);
  for (const name of ["status", "duration", "attempts", "index", "size"])
    if (
      typeof detail[name] === "number" &&
      Number.isFinite(detail[name]) &&
      detail[name] >= 0
    )
      entry[name] = detail[name];
  if (uuid(detail.requestId)) entry.requestId = detail.requestId;
  if (
    typeof detail.ray === "string" &&
    /^[a-f0-9]{16}-[A-Z]{3}$/.test(detail.ray)
  )
    entry.ray = detail.ray;
  for (const name of ["state", "ice", "signaling", "visibility"])
    if (states.has(detail[name])) entry[name] = detail[name];
  if (typeof detail.online === "boolean") entry.online = detail.online;
  if (detail.message !== undefined) entry.message = safeMessage(detail.message);
  return entry;
}
let events = [];
try {
  events = JSON.parse(globalThis.sessionStorage?.getItem("system-log") || "[]")
    .slice(-1200)
    .map((entry) => safeEntry(entry.event, entry, entry.time));
} catch {}
export function record(event, detail = {}) {
  const entry = safeEntry(event, detail);
  events.push(entry);
  events = events.slice(-1200);
  try {
    globalThis.sessionStorage?.setItem("system-log", JSON.stringify(events));
  } catch {}
}
export async function trackedFetch(url, options = {}) {
  const started = performance.now(),
    route = diagnosticRoute(url);
  try {
    const response = await fetch(url, options);
    record("request", {
      method: options.method || "GET",
      route,
      status: response.status,
      duration: Math.round(performance.now() - started),
      requestId: response.headers.get("X-Request-ID"),
      ray: response.headers.get("CF-Ray"),
    });
    return response;
  } catch (error) {
    record("request-failed", {
      method: options.method || "GET",
      route,
      duration: Math.round(performance.now() - started),
      online: navigator.onLine,
      message: error.name,
    });
    throw error;
  }
}
let snapshot = () => ({});
export function setDiagnosticSnapshot(callback) {
  snapshot = callback;
}
if (typeof window !== "undefined") {
  for (const event of ["online", "offline", "pageshow", "pagehide"])
    window.addEventListener(event, () =>
      record(event, { online: navigator.onLine }),
    );
  document.addEventListener("visibilitychange", () =>
    record("visibility", { visibility: document.visibilityState }),
  );
  window.addEventListener("error", (e) =>
    record("browser-error", {
      message: e.error?.name,
    }),
  );
  window.addEventListener("unhandledrejection", (e) =>
    record("unhandled-error", {
      message: e.reason?.name || "Unhandled rejection",
    }),
  );
  record("page-start", { online: navigator.onLine });
  const panel = document.createElement("details");
  panel.className = "diagnostics card";
  panel.innerHTML =
    '<summary>Connection help & system log</summary><p>Download and share this log if a connection stalls. Passwords, invitation keys and document contents are excluded.</p><label>Current network<select><option>Unknown</option><option>University Wi-Fi</option><option>University Ethernet</option><option>Mobile data</option><option>Home network</option></select></label><button type="button" class="secondary">Download system log</button><p role="status"></p>';
  document.querySelector("main")?.append(panel);
  panel.querySelector("button").onclick = async () => {
    try {
      const c = navigator.connection;
      const session = await snapshot();
      if (Array.isArray(session.server))
        session.server = session.server.map(diagnosticRecord);
      const report = {
        format: 2,
        appVersion: "auto-receive-v1",
        host: location.host,
        exportedAt: new Date().toISOString(),
        network: panel.querySelector("select").value,
        environment: {
          browser: navigator.userAgent,
          online: navigator.onLine,
          secureContext: isSecureContext,
          effectiveType: c?.effectiveType,
          rtt: c?.rtt,
          downlink: c?.downlink,
          storage: await navigator.storage?.estimate().catch(() => null),
        },
        session,
        events,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "uos-system-log-" + Date.now() + ".json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      panel.querySelector('[role="status"]').textContent =
        "Log downloaded. Share the JSON file for troubleshooting.";
    } catch (error) {
      panel.querySelector('[role="status"]').textContent =
        "Could not export the log (" +
        safeMessage(error.name) +
        "). Please try again.";
    }
  };
}
