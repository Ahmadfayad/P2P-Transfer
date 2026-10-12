import "./analytics.js";
import { trackedFetch } from "./diagnostics.js";
export let currentUser;
const accountChannel = new BroadcastChannel("document-exchange-account");
accountChannel.onmessage = () => {
  if (location.pathname !== "/student" && !location.hash.includes("room="))
    location.reload();
};
export async function accountRequest(path, body) {
  const response = await trackedFetch("/api/" + path, {
    signal: AbortSignal.timeout(20000),
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || result.message || "Please try again.");
  return result;
}
export async function requireLogin() {
  const form = document.getElementById("login-form"),
    error = document.getElementById("login-error");
  form.onsubmit = (event) => event.preventDefault();
  const passwordInput = form.elements.password;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "text-button login-password-toggle";
  toggle.textContent = "Show password";
  toggle.setAttribute("aria-pressed", "false");
  toggle.onclick = () => {
    const showing = passwordInput.type === "password";
    passwordInput.type = showing ? "text" : "password";
    toggle.textContent = showing ? "Hide password" : "Show password";
    toggle.setAttribute("aria-pressed", String(showing));
  };
  passwordInput.closest("label").after(toggle);
  const login = document.getElementById("login");
  try {
    currentUser = (await accountRequest("auth/get-session"))?.user;
    if (currentUser && !["staff", "admin"].includes(currentUser.role))
      currentUser = undefined;
  } catch {
    error.textContent =
      "Account service unavailable. Please try signing in again.";
  }
  if (!currentUser) {
    currentUser = await new Promise((resolve) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        const button = form.querySelector("button[type=submit]");
        button.disabled = true;
        error.textContent = "";
        try {
          const result = await accountRequest("auth/sign-in/email", {
            email: form.elements.email.value.trim(),
            password: form.elements.password.value,
          });
          if (!["staff", "admin"].includes(result.user?.role))
            throw new Error(
              "Students must use the desk QR code without an account.",
            );
          form.elements.password.value = "";
          accountChannel.postMessage("signed-in");
          resolve(result.user);
        } catch (e) {
          error.textContent = e.message;
        } finally {
          button.disabled = false;
        }
      };
      form.querySelector("button[type=submit]").disabled = false;
    });
  }
  login.hidden = true;
  document.getElementById("account-tools").hidden = false;
  document.getElementById("account-name").textContent =
    `${currentUser.name} · ${currentUser.role}`;
  document.getElementById("admin-link").hidden = currentUser.role !== "admin";
  document.getElementById("sign-out").onclick = async () => {
    try {
      await accountRequest("auth/sign-out", {});
      accountChannel.postMessage("signed-out");
      location.reload();
    } catch (e) {
      document.getElementById("account-error").textContent = e.message;
    }
  };
  document.getElementById("password-open").onclick = () =>
    document.getElementById("password-dialog").showModal();
  document.getElementById("password-close").onclick = () =>
    document.getElementById("password-dialog").close();
  const passwordForm = document.getElementById("password-form");
  passwordForm.onsubmit = async (event) => {
    event.preventDefault();
    const button = passwordForm.querySelector("button[type=submit]");
    button.disabled = true;
    const message = document.getElementById("password-error");
    message.textContent = "";
    try {
      await accountRequest("auth/change-password", {
        currentPassword: passwordForm.elements.currentPassword.value,
        newPassword: passwordForm.elements.newPassword.value,
        revokeOtherSessions: true,
      });
      passwordForm.reset();
      message.textContent = "Password changed. Other sign-ins have ended.";
    } catch (e) {
      message.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  return currentUser;
}
