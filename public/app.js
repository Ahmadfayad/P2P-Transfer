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
let studentPhase = "checking",
  approval;
const urls = new Map();
const inactivePeers = new Set(), reconnectedPeers = new Set();
const peerLabel = (name) => name.trim().toLowerCase().replace(/\s+/g, " ");
function returnNotice(peer) {
  const matches = lastState?.peers.filter(
    (p) => p.id !== peer.id && peerLabel(p.name) === peerLabel(peer.name),
  ) || [];
  if (matches.some((p) => p.state !== "declined"))
    return "Another connection uses this name/ID — check identity";
  if (matches.length) return "Returning name/ID — check identity";
  return "";
}
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
  if ($("student-gate").open) $("student-error").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("message").hidden = true), 8000);
}
function showStudentPhase(phase) {
  if (!guest) return;
  studentPhase = phase;
  const dialog = $("student-gate");
  const waiting = ["checking", "pending"].includes(phase);
  $("student-waiting-spinner").hidden = !waiting;
  $("student-phase").setAttribute("aria-busy", String(waiting));
  $("files").disabled = phase !== "approved";
  $("workspace").hidden = phase !== "approved";
  if (phase === "approved") {
    dialog.close();
    const diagnostics = dialog.querySelector(".diagnostics");
    if (diagnostics) document.querySelector("main").append(diagnostics);
    return;
  }
  $("saved-card").hidden = true;
  $("join-form").hidden = phase !== "entry";
  $("student-phase").hidden = phase === "entry";
  $("student-cancel").hidden = !["pending", "declined"].includes(phase);
  $("student-saved").hidden = phase !== "ended";
  $("student-gate-title").textContent = {
    entry: "Connect to the desk",
    checking: "Checking your connection",
    pending: "Waiting for staff approval",
    declined: "Request not accepted",
    ended: "This session has ended",
  }[phase];
  $("student-identity").textContent = session?.studentName || "";
  $("student-phase-text").textContent =
    {
      checking: "Please wait while we restore your connection.",
      pending:
        "Your request has been sent. Keep this page open. File exchange will open after staff approve you.",
      declined:
        "Staff did not accept this connection. Please speak to the person at your desk.",
      ended:
        "Ask staff for a new invitation. Your saved documents remain on this device.",
    }[phase] || "";
  const diagnostics = document.querySelector(".diagnostics");
  if (diagnostics) dialog.append(diagnostics);
  if (!dialog.open) dialog.showModal();
  if (phase === "entry") $("student-name").focus();
}
function showApproval(peer) {
  const dialog = $("approval-dialog");
  if (!peer) {
    dialog.close();
    approval = null;
    return;
  }
  if (approval?.id !== peer.id || approval.room !== session.room) {
    approval = { id: peer.id, room: session.room, busy: false };
    $("approval-error").textContent = "";
  }
  $("approval-identity").textContent = peer.name;
  const notice = returnNotice(peer);
  $("approval-returning").textContent = notice;
  $("approval-returning").hidden = !notice;
  const count = lastState.peers.filter((p) => p.state === "pending").length;
  $("approval-count").textContent =
    count > 1 ? `${count} requests waiting. Review them one at a time.` : "";
  $("approval-approve").disabled = $("approval-reject").disabled =
    approval.busy;
  if (!dialog.open) dialog.showModal();
}
async function decideApproval(state) {
  if (!approval || approval.busy) return;
  const decision = approval,
    instance = exchange;
  decision.busy = true;
  showApproval(lastState.peers.find((p) => p.id === decision.id));
  try {
    await instance.api("/peers/" + decision.id, {
      method: "POST",
      body: { state },
    });
    if (exchange !== instance || session?.room !== decision.room) return;
    const peer = lastState.peers.find((p) => p.id === decision.id);
    if (peer) peer.state = state;
    renderState(lastState);
    instance.wakeRequested = true;
    clearTimeout(timer);
    if (!instance.polling) poll(instance);
  } catch (error) {
    if (approval === decision) $("approval-error").textContent = error.message;
  } finally {
    decision.busy = false;
    if (approval === decision)
      $("approval-approve").disabled = $("approval-reject").disabled = false;
  }
}
$("student-gate").oncancel = $("approval-dialog").oncancel = (event) =>
  event.preventDefault();
$("approval-approve").onclick = () => decideApproval("approved");
$("approval-reject").onclick = () => decideApproval("declined");
$("student-cancel").onclick = () => leaveSession(false);
$("student-saved").onclick = () => {
  studentPhase = "ended-view";
  session = null;
  lastState = null;
  $("student-gate").close();
  const diagnostics = $("student-gate").querySelector(".diagnostics");
  if (diagnostics) document.querySelector("main").append(diagnostics);
  renderFiles().catch((error) => message(error.message));
};
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
  $("saved-card").hidden =
    !older.length ||
    (guest && !["approved", "ended-view"].includes(studentPhase));
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
  $("files").disabled = !approved;
  if (!desk) {
    session.studentName ||= own?.name;
    $("student-error").textContent = "";
    showStudentPhase(
      own?.state === "approved"
        ? "approved"
        : own?.state === "declined"
          ? "declined"
          : "pending",
    );
  }
  $("send-note").textContent = approved
    ? "Files retry automatically after a temporary interruption. Wait for “Received” before closing."
    : own?.state === "declined"
      ? "The desk declined this connection. Ask staff for help."
      : "Waiting for staff approval. File exchange will open after your request is accepted.";
  $("connections").replaceChildren();
  if (desk) {
    const selected = $("recipient").value;
    $("recipient").replaceChildren(
      element("option", "Choose an approved student"),
    );
    $("recipient").firstChild.value = "";
    const activePeers = lastState.peers.filter((p) => p.state !== "declined");
    const endedPeers = lastState.peers.filter((p) => p.state === "declined");
    $("ended-connections").hidden = !endedPeers.length;
    $("ended-connections-summary").textContent = `Ended connections (${endedPeers.length})`;
    $("ended-connections-list").replaceChildren();
    const endedNames = new Map();
    for (const peer of endedPeers) {
      const key = peerLabel(peer.name);
      const group = endedNames.get(key) || { name: peer.name, count: 0 };
      group.count++;
      endedNames.set(key, group);
    }
    for (const group of endedNames.values()) {
      const row = element("div", undefined, "peer");
      row.append(element("strong", group.name), element("p",
        `${group.count} ended or declined request${group.count === 1 ? "" : "s"}`,
        "small"));
      $("ended-connections-list").append(row);
    }
    for (const peer of activePeers) {
      const inactive = Date.now() - peer.seen > 30000;
      if (peer.state === "approved") {
        if (inactive) inactivePeers.add(peer.id);
        else if (inactivePeers.delete(peer.id)) reconnectedPeers.add(peer.id);
      }
      const row = element("div", undefined, "peer");
      row.append(
        element("strong", peer.name),
        element(
          "p",
          peer.state === "pending"
            ? "Wants to connect"
            : peer.state === "approved"
              ? "Approved" +
                (inactive
                  ? " · page inactive; waiting to reconnect"
                  : " · page active")
              : "Declined",
          "small",
        ),
      );
      const notice = returnNotice(peer) ||
        (!inactive && reconnectedPeers.has(peer.id) ? "Reconnected — same session" : "");
      if (notice) row.append(element("span", notice, "connection-badge"));
      if (peer.state === "pending") {
        row.append(button("Review request", () => showApproval(peer)));
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
    if (!activePeers.length)
      $("connections").append(
        element(
          "p",
          "No active requests or students. Share your QR code to connect.",
          "small",
        ),
      );
    showApproval(
      lastState.peers.find(
        (p) => p.id === approval?.id && p.state === "pending",
      ) || lastState.peers.find((p) => p.state === "pending"),
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
  $("route-label").textContent = [...exchange.direct.peers.keys()].some(
    (peer) => exchange.direct.available(peer),
  )
    ? exchange.direct.pilot ? "Encrypted relay + HTTPS recovery" : "Direct + HTTPS recovery"
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
      if (guest) showStudentPhase("ended");
      else showApproval(null);
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
  showApproval(null);
  if (guest) showStudentPhase("checking");
  lastState = null;
  inactivePeers.clear();
  reconnectedPeers.clear();
  await db.put("sessions", saved);
  sessionStorage.setItem(sessionKey, saved.id);
  localStorage.setItem(sessionKey, saved.id);
  const instance = new Exchange(session, (state) => {
    if (exchange === instance) renderState(state);
  }, () => {
    if (exchange !== instance || instance.stopped) return;
    instance.wakeRequested = true;
    clearTimeout(timer);
    if (!instance.polling) timer = setTimeout(() => poll(instance), 25);
  });
  exchange = instance;
  instance.watch();
  $("welcome").hidden = true;
  $("workspace").hidden = guest;
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
      studentName: $("student-name").value.trim(),
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
async function leaveSession(confirmEnd = true) {
  if (!session) return;
  if (
    confirmEnd &&
    !confirm(
      "End this session? Incomplete transfers will stop. Saved files remain on this device.",
    )
  )
    return;
  $("student-cancel").disabled = true;
  try {
    if (!exchange.stopped)
      await exchange.api(session.self === "desk" ? "" : "/leave", {
        method: session.self === "desk" ? "DELETE" : "POST",
      });
    exchange.stop();
    clearTimeout(timer);
    localStorage.removeItem(sessionKey);
    sessionStorage.removeItem(sessionKey);
    session = null;
    lastState = null;
    showApproval(null);
    $("workspace").hidden = true;
    $("welcome").hidden = false;
    $("desk-form").hidden = guest;
    $("join-form").hidden = !guest;
    if (guest) showStudentPhase("entry");
    await renderFiles();
  } catch (e) {
    message(e.message);
  } finally {
    $("student-cancel").disabled = false;
  }
}
$("leave").onclick = () => leaveSession();
async function choose(files) {
  if (guest && studentPhase !== "approved") {
    message("Wait for staff to approve your connection before choosing files.");
    return;
  }
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
      showStudentPhase("checking");
      db.useAccount("guest:" + invitation.room);
      const saved = await db.get(
        "sessions",
        sessionStorage.getItem(sessionKey) || "",
      );
      if (saved?.guest && saved.room === invitation.room) {
        if (saved.expires > Date.now()) await begin(saved);
        else {
          session = saved;
          showStudentPhase("ended");
        }
      } else showStudentPhase("entry");
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
