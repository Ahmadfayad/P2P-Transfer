import * as db from "./storage.js";
import { identity, fingerprint } from "./crypto.js";
import { Exchange, request, finishFile } from "./transfer.js";
import { csvCell, chunkCount, fileType } from "./protocol.js";
import QRCode from "./vendor/qrcode.js";
import { requireLogin } from "./account.js";
import { record, setDiagnosticSnapshot } from "./diagnostics.js";
const $ = (id) => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
let invitation = fragment.has("room")
  ? {
      room: fragment.get("room"),
      invite: fragment.get("invite"),
      fingerprint: fragment.get("key"),
    }
  : null;
if (invitation) {
  sessionStorage.setItem("desk-invitation", JSON.stringify(invitation));
  history.replaceState(null, "", "/student");
} else if (location.pathname === "/student") {
  try {
    invitation = JSON.parse(sessionStorage.getItem("desk-invitation"));
  } catch {}
}
const guest = location.pathname === "/student";
const sessionKey = guest ? "guest-session" : "exchange-session";
let exchange, session, lastState, timer, toastTimer, previewURL;
const urls = new Map();
setDiagnosticSnapshot(async () => ({
  role: session?.self === "desk" ? "staff" : guest ? "guest" : "signed-out",
  room: session?.room,
  expires: session?.expires,
  stopped: exchange?.stopped,
  failures: exchange?.failures || 0,
  lastProgress: exchange?.lastProgress,
  peers: lastState?.peers.map(({ id, state, seen }) => ({ id, state, seen })),
  transfers: lastState?.transfers.map(
    ({ id, size, state, next, received }) => ({
      id,
      size,
      state,
      next,
      received,
    }),
  ),
  server:
    session?.self === "desk" && !exchange?.stopped
      ? await exchange
          .api("/diagnostics", { signal: AbortSignal.timeout(8000) })
          .then((r) => r.json())
          .catch(() => ({ unavailable: true }))
      : {
          available: false,
          reason:
            "Server records are exported by the staff desk; this log includes this browser's requests.",
        },
  direct: exchange
    ? await Promise.all(
        [...exchange.direct.peers.values()].map(
          async ({ pc, channel, attempts }) => {
            const stats = await pc.getStats().catch(() => new Map());
            const pair = [...stats.values()].find(
              (s) =>
                s.type === "candidate-pair" &&
                s.state === "succeeded" &&
                s.nominated,
            );
            const candidate = pair && stats.get(pair.localCandidateId);
            return {
              state: pc.connectionState,
              ice: pc.iceConnectionState,
              channel: channel?.readyState,
              attempts,
              candidateType: candidate?.candidateType,
              protocol: candidate?.protocol,
              roundTripTime: pair?.currentRoundTripTime,
            };
          },
        ),
      )
    : [],
}));
function message(text) {
  record("notice");
  $("message").textContent = text;
  $("message").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("message").hidden = true), 8000);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className = "secondary compact") {
  const node = element("button", text, className);
  node.type = "button";
  node.onclick = () =>
    Promise.resolve()
      .then(action)
      .catch((e) => message(e.message));
  return node;
}
function size(n) {
  return n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : Math.ceil(n / 1024) + " KB";
}
function blobURL(file) {
  if (!urls.has(file.id)) urls.set(file.id, URL.createObjectURL(file.blob));
  return urls.get(file.id);
}
function download(file) {
  const a = element("a");
  a.href = blobURL(file);
  a.download = file.name;
  a.click();
}
function preview(file) {
  const type = fileType(file.name);
  if (
    !file.completed ||
    !["application/pdf", "image/png", "image/jpeg"].includes(type)
  )
    throw new Error("This file cannot be previewed. Save a copy to open it.");
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = URL.createObjectURL(new Blob([file.blob], { type }));
  $("preview-title").textContent = file.name;
  $("preview-content").replaceChildren();
  if (type.startsWith("image/")) {
    const img = element("img");
    img.src = previewURL;
    img.alt = file.name;
    $("preview-content").append(img);
  } else {
    const frame = element("iframe");
    frame.src = previewURL;
    frame.title = "PDF document preview";
    // Chrome's native PDF viewer needs this frame unsandboxed; only a fixed PDF MIME reaches it.
    $("preview-content").append(frame);
  }
  $("preview").showModal();
}
$("close-preview").onclick = () => $("preview").close();
$("preview").onclose = () => {
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;
  $("preview-content").replaceChildren();
};
async function removeFile(file) {
  if (
    !confirm(
      "Remove this file from this browser? Save a copy first. An unfinished transfer will be cancelled.",
    )
  )
    return;
  const transfer = lastState?.transfers.find((t) => t.id === file.id);
  if (transfer && !["received", "rejected"].includes(transfer.state))
    await exchange.api("/transfers/" + file.id + "/reject", {
      method: "POST",
      body: { reason: "The file was removed by its owner." },
    });
  const chunks = (await db.all("chunks")).filter((c) => c.transfer === file.id);
  await db.transaction(["files", "chunks"], (s) => {
    s.files.delete(file.id);
    for (const c of chunks) s.chunks.delete(c.id);
  });
  if (urls.has(file.id)) {
    URL.revokeObjectURL(urls.get(file.id));
    urls.delete(file.id);
  }
  await renderFiles();
}
async function renderFiles() {
  const files = await db.all("files");
  for (const file of files) {
    if (
      !file.blob &&
      file.kind === "incoming" &&
      file.next === chunkCount(file.size) &&
      (file.room !== session?.room || exchange?.stopped)
    )
      await finishFile(file);
  }
  const current = session ? files.filter((f) => f.room === session.room) : [];
  const older = files.filter((f) => !session || f.room !== session.room);
  renderList($("file-list"), current, true);
  renderList($("saved-list"), older, false);
  $("saved-card").hidden = !older.length;
}
function renderList(container, files, current) {
  container.replaceChildren();
  if (!files.length) {
    container.append(element("p", "Your documents will appear here.", "empty"));
    return;
  }
  for (const file of files.sort((a, b) => b.created - a.created)) {
    const t = current
      ? lastState?.transfers.find((t) => t.id === file.id)
      : null;
    const incoming = file.kind === "incoming";
    const received = t?.state === "received" || Boolean(file.received);
    let status = received
      ? "Received ✓"
      : t?.state === "rejected"
        ? "Cancelled"
        : file.completed
          ? "Saved · awaiting receipt"
          : t?.state === "accepted"
            ? "Transferring"
            : t?.state === "offered"
              ? "Waiting for recipient"
              : "Queued";
    if (!current)
      status = received
        ? "Received ✓ · saved"
        : file.completed
          ? "Saved on this device"
          : incoming
            ? "Incomplete · session ended"
            : "Original file saved";
    const row = element("div", undefined, "file");
    const line = element("div", undefined, "file-line");
    line.append(
      element("strong", file.name),
      element("span", status, "status" + (received ? " received" : "")),
    );
    const peer = incoming ? file.from : file.to;
    const name =
      peer === "desk"
        ? "Desk"
        : lastState?.peers.find((p) => p.id === peer)?.name || "Student";
    row.append(
      line,
      element(
        "div",
        (incoming ? "From " : "To ") + name + " · " + size(file.size),
        "meta",
      ),
    );
    if (t && !["received", "rejected"].includes(t.state)) {
      const progress = element("progress");
      progress.max = chunkCount(file.size);
      progress.value = t.next;
      progress.setAttribute("aria-label", "Transfer progress for " + file.name);
      row.append(progress);
    }
    const error = t?.error || exchange?.retries.get(file.id)?.message;
    if (error) row.append(element("p", error, "small"));
    const actions = element("div", undefined, "actions");
    if (file.blob) {
      actions.append(
        button(incoming ? "Save a copy" : "Save original", () =>
          download(file),
        ),
      );
      if (
        incoming &&
        file.completed &&
        fileType(file.name) !==
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
        actions.append(button("Preview", () => preview(file)));
      if (
        exchange &&
        !exchange.stopped &&
        (!current || t?.state === "rejected")
      )
        actions.append(
          button("Send again", () =>
            choose([
              new File([file.blob], file.name, { type: fileType(file.name) }),
            ]),
          ),
        );
    }
    actions.append(button("Remove", () => removeFile(file)));
    row.append(actions);
    container.append(row);
  }
}
function renderState(state) {
  if (!session || exchange?.stopped) return;
  if (state) lastState = state;
  if (!lastState) return;
  const desk = session.self === "desk";
  if (desk) localStorage.setItem("owned-desk-room", session.room);
  $("workspace").classList.toggle("student", !desk);
  const own = lastState.peers.find((p) => p.id === session.self);
  const approved = desk || own?.state === "approved";
  $("send-note").textContent = approved
    ? "Files retry automatically after a temporary interruption. Wait for “Received” before closing."
    : own?.state === "declined"
      ? "The desk declined this connection. Ask staff for help."
      : "Waiting for desk approval. You can choose files now; they will queue safely on this device.";
  $("connections").replaceChildren();
  if (desk) {
    const selected = $("recipient").value;
    $("recipient").replaceChildren(
      element("option", "Choose an approved student"),
    );
    $("recipient").firstChild.value = "";
    for (const peer of lastState.peers) {
      const row = element("div", undefined, "peer");
      row.append(
        element("strong", peer.name),
        element(
          "p",
          peer.state === "pending"
            ? "Wants to connect"
            : peer.state === "approved"
              ? "Approved" +
                (Date.now() - peer.seen > 30000
                  ? " · waiting for their page"
                  : " · page active")
              : "Declined",
          "small",
        ),
      );
      if (peer.state === "pending") {
        const actions = element("div", undefined, "actions");
        for (const [text, status] of [
          ["Approve", "approved"],
          ["Decline", "declined"],
        ])
          actions.append(
            button(text, () =>
              exchange.api("/peers/" + peer.id, {
                method: "POST",
                body: { state: status },
              }),
            ),
          );
        row.append(actions);
      }
      if (peer.state === "approved") {
        const option = element("option", peer.name);
        option.value = peer.id;
        $("recipient").append(option);
        row.append(
          button("End connection", () =>
            exchange.api("/peers/" + peer.id, {
              method: "POST",
              body: { state: "declined" },
            }),
          ),
        );
      }
      $("connections").append(row);
    }
    if ([...$("recipient").options].some((o) => o.value === selected))
      $("recipient").value = selected;
    if (!lastState.peers.length)
      $("connections").append(
        element(
          "p",
          "No students yet. Share your QR code to get started.",
          "small",
        ),
      );
  } else
    $("connections").append(
      element(
        "p",
        own?.state === "approved"
          ? "The desk approved you. You can send and receive documents."
          : own?.state === "declined"
            ? "This connection was declined."
            : "Your request is waiting for the desk.",
        "small",
      ),
    );
  $("route-label").textContent = [...exchange.direct.peers.values()].some(
    (p) => p.channel?.readyState === "open",
  )
    ? "Direct + HTTPS recovery"
    : "Encrypted HTTPS";
  renderFiles().catch((e) => message(e.message));
}
async function poll(instance) {
  if (instance !== exchange || instance.stopped || instance.polling) return;
  instance.polling = true;
  instance.wakeRequested = false;
  let delay = 15000;
  try {
    const active = await instance.tick();
    if (instance !== exchange || instance.stopped) {
      instance.polling = false;
      return;
    }
    $("network").textContent = "Connected";
    $("network").classList.remove("error");
    instance.failures = 0;
    const progress = lastState?.transfers
      .map((t) => t.id + ":" + t.state + ":" + t.next)
      .join("|");
    if (instance.progress !== progress) {
      instance.progress = progress;
      instance.lastProgress = Date.now();
    }
    delay = active
      ? 250
      : lastState?.peers.some((p) => p.state === "pending")
        ? 3000
        : 15000;
    if (active && Date.now() - instance.lastProgress > 10000) delay = 2000;
    if (active && Date.now() - instance.lastProgress > 60000) delay = 15000;
  } catch (error) {
    if (instance !== exchange || instance.stopped) {
      instance.polling = false;
      return;
    }
    $("network").textContent = "Retrying connection";
    $("network").classList.add("error");
    instance.failures = (instance.failures || 0) + 1;
    delay = Math.min(30000, 3000 * 2 ** Math.min(instance.failures - 1, 4));
    record("connection-retry", {
      status: error.status,
      duration: delay,
      attempts: instance.failures,
      message: error.name,
    });
    if ([401, 410].includes(error.status)) {
      instance.stop();
      instance.polling = false;
      $("network").textContent = "Session ended";
      message(error.message + " Saved files remain on this device.");
      renderFiles().catch((e) => message(e.message));
      return;
    }
    if (
      ![429, 500, 502, 503, 504].includes(error.status) &&
      error.name !== "TimeoutError" &&
      error.name !== "TypeError"
    )
      message(error.message);
  }
  instance.polling = false;
  timer = setTimeout(
    () => poll(instance),
    instance.wakeRequested ? 250 : delay,
  );
}
async function begin(saved) {
  exchange?.stop();
  clearTimeout(timer);
  session = saved;
  lastState = null;
  await db.put("sessions", saved);
  sessionStorage.setItem(sessionKey, saved.id);
  localStorage.setItem(sessionKey, saved.id);
  exchange = new Exchange(session, (state) => {
    if (exchange?.session === saved) renderState(state);
  });
  $("welcome").hidden = true;
  $("workspace").hidden = false;
  const desk = session.self === "desk";
  $("role-label").textContent = desk
    ? "Your receiving desk"
    : "Your student connection";
  $("room-name").textContent = session.name;
  $("session-note").textContent =
    "Session ends at " +
    new Date(session.expires).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }) +
    ".";
  $("leave").textContent = desk ? "End desk session" : "Leave session";
  $("invite-card").hidden = !desk;
  $("recipient-label").hidden = !desk;
  if (desk) {
    const link = new URL(location.href);
    link.pathname = "/student";
    link.hash = new URLSearchParams({
      room: session.room,
      invite: session.invite,
      key: await fingerprint(session.publicKey),
    }).toString();
    session.link = link.href;
    await QRCode.toCanvas($("qr"), session.link, {
      width: 220,
      margin: 2,
      color: { dark: "#173e34", light: "#ffffff" },
    });
  }
  await renderFiles();
  poll(exchange);
}
async function submit(form, action) {
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
}
$("desk-form").onsubmit = (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    const keys = await identity();
    const name = $("desk-name").value.trim();
    const room = await (
      await request("/rooms", {
        method: "POST",
        body: { name, publicKey: keys.publicKey },
      })
    ).json();
    await begin({
      id: room.id,
      room: room.id,
      self: "desk",
      name,
      ...keys,
      ...room,
    });
  });
};
$("join-form").onsubmit = (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    if (!invitation?.fingerprint || !invitation.invite)
      throw new Error(
        "This invitation is incomplete. Ask the desk for a new link.",
      );
    if (
      localStorage.getItem("owned-desk-room") === invitation.room ||
      (await db.all("sessions")).some(
        (s) =>
          s.room === invitation.room &&
          s.self === "desk" &&
          s.expires > Date.now(),
      )
    )
      throw new Error(
        "This browser owns this desk. Open its student invitation on a separate device or browser profile.",
      );
    const keys = await identity();
    const result = await (
      await request("/rooms/" + invitation.room + "/join", {
        method: "POST",
        body: {
          name: $("student-name").value.trim(),
          publicKey: keys.publicKey,
        },
        headers: { "X-Invite": invitation.invite, "X-Guest-Access": "1" },
      })
    ).json();
    if ((await fingerprint(result.publicKey)) !== invitation.fingerprint)
      throw new Error(
        "The desk identity does not match this invitation. Ask for a new QR code.",
      );
    await begin({
      id: result.id,
      room: invitation.room,
      guest: true,
      self: result.id,
      name: result.name,
      token: result.token,
      expires: result.expires,
      ...keys,
      deskKey: result.publicKey,
    });
  });
};
$("copy-link").onclick = () =>
  navigator.clipboard
    .writeText(session.link)
    .then(() => message("Invitation link copied."))
    .catch(() => message("Copying is unavailable. Use the QR code."));
$("leave").onclick = async () => {
  if (
    !confirm(
      "End this session? Incomplete transfers will stop. Saved files remain on this device.",
    )
  )
    return;
  try {
    if (session.self === "desk" && !exchange.stopped)
      await exchange.api("", { method: "DELETE" });
    exchange.stop();
    clearTimeout(timer);
    localStorage.removeItem(sessionKey);
    sessionStorage.removeItem(sessionKey);
    session = null;
    lastState = null;
    $("workspace").hidden = true;
    $("welcome").hidden = false;
    $("desk-form").hidden = guest;
    $("join-form").hidden = !guest;
    await renderFiles();
  } catch (e) {
    message(e.message);
  }
};
async function choose(files) {
  if (!session || exchange.stopped) {
    message("Open a new desk session to send files.");
    return;
  }
  const to = session.self === "desk" ? $("recipient").value : "desk";
  if (!to) {
    message("Choose an approved student first.");
    return;
  }
  for (const file of files) {
    try {
      await exchange.queue(file, to);
    } catch (e) {
      message(e.message);
      break;
    }
  }
  exchange.wakeRequested = true;
  exchange.lastProgress = Date.now();
  clearTimeout(timer);
  if (!exchange.polling) poll(exchange);
  await renderFiles();
}
$("files").onchange = async (event) => {
  await choose([...event.target.files]);
  event.target.value = "";
};
for (const name of ["dragover", "dragleave", "drop"])
  $("drop").addEventListener(name, (event) => {
    event.preventDefault();
    $("drop").classList.toggle("drag", name === "dragover");
    if (name === "drop") choose([...event.dataTransfer.files]);
  });
$("export").onclick = async () => {
  const rows = [
    ["File", "Bytes", "From", "To", "Received at"],
    ...(await db.all("files"))
      .filter((f) => f.received)
      .map((f) => [
        f.name,
        f.size,
        f.fromName || f.from,
        f.toName || f.to,
        new Date(f.received).toISOString(),
      ]),
  ];
  const blob = new Blob(
      ["\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n")],
      { type: "text/csv" },
    ),
    url = URL.createObjectURL(blob),
    a = element("a");
  a.href = url;
  a.download = "transfer-receipts.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener("online", () => {
  if (exchange && !exchange.stopped) {
    clearTimeout(timer);
    timer = setTimeout(() => poll(exchange), 300);
  }
});
async function init() {
  try {
    if (guest) {
      document.body.classList.add("student-page");
      $("welcome").firstElementChild.classList.add("student-hero");
      $("welcome").querySelector("h1").innerHTML =
        "Your desk.<br>Your documents.";
      $("welcome").querySelector(".eyebrow").textContent =
        "Student document portal";
      $("welcome").querySelector(".features").innerHTML =
        "<span>01 · Connect</span><span>02 · Get approved</span><span>03 · Exchange files</span>";
      $("login").hidden = true;
      $("welcome").hidden = false;
      $("desk-form").hidden = true;
      $("join-form").hidden = !invitation;
      $("student-start").hidden = Boolean(invitation);
      if (!invitation) return;
      db.useAccount("guest:" + invitation.room);
      const saved = await db.get(
        "sessions",
        sessionStorage.getItem(sessionKey) || "",
      );
      if (
        saved?.guest &&
        saved.room === invitation.room &&
        saved.expires > Date.now()
      )
        await begin(saved);
      await renderFiles();
      await request("/health");
      if (!exchange) $("network").textContent = "Ready to connect";
      return;
    }
    const user = await requireLogin();
    db.useAccount(user.id);
    $("legacy-recovery").hidden = !(await db.legacyAvailable());
    $("recover-legacy").onclick = async () => {
      $("recover-legacy").disabled = true;
      try {
        const count = await db.recoverLegacy(user.id);
        $("legacy-recovery").hidden = true;
        const saved = await db.get(
          "sessions",
          sessionStorage.getItem(sessionKey) ||
            localStorage.getItem(sessionKey) ||
            "",
        );
        if (
          !exchange &&
          saved &&
          saved.expires > Date.now() &&
          (!invitation || saved.room === invitation.room)
        )
          await begin(saved);
        await renderFiles();
        message(`${count} earlier files recovered into your account.`);
      } catch (e) {
        message(e.message);
      } finally {
        $("recover-legacy").disabled = false;
      }
    };
    $("welcome").hidden = false;
    $("desk-form").hidden = user.role === "student";
    $("student-start").hidden = user.role !== "student" || Boolean(invitation);
    $("student-name").value = user.name;
    if (!crypto.subtle)
      throw new Error(
        "Open this service over HTTPS to enable private transfers.",
      );
    const saved = await db.get(
      "sessions",
      sessionStorage.getItem(sessionKey) ||
        localStorage.getItem(sessionKey) ||
        "",
    );
    if (
      saved &&
      saved.expires > Date.now() &&
      (!invitation || (saved.room === invitation.room && saved.self !== "desk"))
    )
      await begin(saved);
    else {
      if (invitation) {
        $("desk-form").hidden = true;
        $("join-form").hidden = false;
      }
      await renderFiles();
    }
    await request("/health");
    if (!exchange) $("network").textContent = "Service ready";
  } catch (e) {
    $("network").textContent = "Service unavailable";
    $("network").classList.add("error");
    message(e.message);
  }
}
init();
