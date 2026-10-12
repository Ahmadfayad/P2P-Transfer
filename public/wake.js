import { record } from "./diagnostics.js";

// Notifications carry only a wake hint. Protected state still comes from authenticated HTTPS.
export class Wake {
  constructor(session, changed) {
    this.session = session;
    this.changed = changed;
    this.failures = 0;
    this.connect();
  }
  connect() {
    if (this.stopped || typeof WebSocket === "undefined") return;
    const url = new URL("/api/rooms/" + this.session.room + "/wake", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      // Browser WebSockets cannot send an Authorization header. Keep the private token
      // in the protocol header, never in URLs, logs, storage attachments or responses.
      socket = new WebSocket(url, [this.session.guest ? "uos-guest-v1" : "uos-staff-v1", this.session.token]);
    } catch { this.retry(); return; }
    this.socket = socket;
    this.timeout = setTimeout(() => socket.close(), 10000);
    socket.onopen = () => {
      clearTimeout(this.timeout);
      this.failures = 0;
      record("push-open");
      this.changed();
      // Refresh employee-cookie validation; no server timer keeps the object awake.
      this.renew = setTimeout(() => socket.close(), 480000);
    };
    socket.onmessage = (event) => {
      if (event.data === "changed") this.changed();
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      clearTimeout(this.timeout);
      clearTimeout(this.renew);
      record("push-closed");
      if (!this.stopped) { this.changed(); this.retry(); }
    };
  }
  retry() {
    if (this.stopped || ++this.failures > 5) return;
    const delay = Math.min(60000, 3000 * 2 ** (this.failures - 1));
    this.timer = setTimeout(() => this.connect(), delay);
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.timeout);
    clearTimeout(this.renew);
    this.socket?.close();
  }
}
