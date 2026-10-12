let events = [];
try {
  events = JSON.parse(
    globalThis.sessionStorage?.getItem("system-log") || "[]",
  ).slice(-1200);
} catch {}
export function safeMessage(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/[\w.+-]+@[\w.-]+/g, "[email]")
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]")
    .slice(0, 300);
}
export function record(event, detail = {}) {
  const entry = { time: new Date().toISOString(), event };
  for (const name of [
    "method",
    "route",
    "status",
    "duration",
    "requestId",
    "ray",
    "state",
    "ice",
    "signaling",
    "attempts",
    "index",
    "size",
    "message",
    "online",
    "visibility",
  ])
    if (detail[name] !== undefined)
      entry[name] =
        typeof detail[name] === "string"
          ? safeMessage(detail[name])
          : detail[name];
  events.push(entry);
  events = events.slice(-1200);
  try {
    globalThis.sessionStorage?.setItem("system-log", JSON.stringify(events));
  } catch {}
}
export async function trackedFetch(url, options = {}) {
  const started = performance.now(),
    route = String(url).split(/[?#]/)[0];
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
      message: error.name + ": " + error.message,
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
      message: e.message || "Resource failed to load",
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
      const report = {
        format: 1,
        appVersion: "guest-diagnostics-v1",
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
        session: await snapshot(),
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
      panel.querySelector('[role="status"]').textContent = safeMessage(
        error.message,
      );
    }
  };
}
