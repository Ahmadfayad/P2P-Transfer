import { requireLogin, accountRequest } from "./account.js";
import { parseUsersCSV } from "./user-csv.js";
const $ = (id) => document.getElementById(id);
let usersToImport = [],
  offset = 0,
  resetting,
  importing = false;
let toastTimer;
function notify(text) {
  $("admin-toast").textContent = text;
  $("admin-toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("admin-toast").hidden = true;
  }, 5000);
}
const roleDescriptions = {
  student: "Students join an invited desk and exchange documents.",
  staff: "Staff open desks, approve students and exchange documents.",
  admin:
    "Administrators manage accounts and roles, and can also open desks. Only assign this role to trusted people.",
};
$("new-user-role").onchange = (event) => {
  $("new-role-description").textContent = roleDescriptions[event.target.value];
};
$("add-user-open").onclick = () => {
  $("add-user-form").reset();
  $("add-user-error").textContent = "";
  $("new-role-description").textContent = roleDescriptions.student;
  $("add-user-form").elements.password.type = "password";
  $("new-password-toggle").textContent = "Show password";
  $("new-password-toggle").setAttribute("aria-pressed", "false");
  $("add-user-dialog").showModal();
};
$("add-user-close").onclick = () => $("add-user-dialog").close();
$("add-user-dialog").addEventListener("close", () =>
  $("add-user-form").reset(),
);
$("new-password-toggle").onclick = (event) => {
  const input = $("add-user-form").elements.password,
    showing = input.type === "password";
  input.type = showing ? "text" : "password";
  event.currentTarget.textContent = showing ? "Hide password" : "Show password";
  event.currentTarget.setAttribute("aria-pressed", String(showing));
};
$("add-user-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector("button[type=submit]");
  button.disabled = true;
  $("add-user-error").textContent = "";
  let created = false;
  try {
    const body = Object.fromEntries(new FormData(form));
    await accountRequest("admin/users", body);
    created = true;
    form.reset();
    $("add-user-dialog").close();
    notify("User created. Share their temporary password privately.");
    offset = 0;
    await listUsers();
  } catch (e) {
    if ($("add-user-dialog").open) $("add-user-error").textContent = e.message;
    else if (created)
      $("admin-error").textContent =
        "User was created, but the account list could not refresh. Select Refresh.";
    else notify(e.message);
  } finally {
    button.disabled = false;
  }
};
for (const button of document.querySelectorAll("[data-scroll-target]"))
  button.onclick = () =>
    $(button.dataset.scrollTarget).scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
const node = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
async function action(button, run) {
  button.disabled = true;
  $("admin-error").textContent = "";
  try {
    await run();
  } catch (e) {
    $("admin-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
async function listUsers() {
  const result = await accountRequest("admin/users?offset=" + offset);
  $("total-users").textContent = result.total;
  $("users").replaceChildren();
  for (const user of result.users) {
    const row = node("tr"),
      identity = node("td");
    identity.append(node("strong", user.name), node("p", user.email));
    row.append(identity);
    const roleCell = node("td"),
      select = node("select");
    select.setAttribute("aria-label", "Role for " + user.email);
    for (const role of ["student", "staff", "admin"]) {
      const option = node("option", role);
      option.value = role;
      option.selected = user.role === role;
      select.append(option);
    }
    select.disabled = user.role === "admin";
    select.onchange = () =>
      action(select, async () => {
        try {
          await accountRequest("admin/role", {
            userId: user.id,
            role: select.value,
          });
        } finally {
          await listUsers();
        }
      });
    roleCell.append(select);
    const stateCell = node("td"),
      badge = node("span", user.banned ? "Disabled" : "Active");
    badge.className = "status-badge " + (user.banned ? "disabled" : "active");
    stateCell.append(badge);
    row.append(roleCell, stateCell);
    const actions = node("td");
    const actionGroup = node("div");
    actionGroup.className = "admin-actions";
    if (user.role !== "admin") {
      const status = node("button", user.banned ? "Enable" : "Disable");
      status.type = "button";
      status.className = "secondary compact";
      status.onclick = () =>
        action(status, async () => {
          await accountRequest("admin/status", {
            userId: user.id,
            disabled: !user.banned,
          });
          await listUsers();
        });
      const reset = node("button", "Reset password");
      reset.type = "button";
      reset.className = "secondary compact";
      reset.onclick = () => {
        resetting = user;
        $("reset-user").textContent = user.email;
        $("reset-error").textContent = "";
        $("reset-form").reset();
        $("reset-dialog").showModal();
      };
      actionGroup.append(status, reset);
    } else actionGroup.append(node("span", "Protected administrator"));
    actions.append(actionGroup);
    row.append(actions);
    $("users").append(row);
  }
  $("user-count").textContent = result.total
    ? `${offset + 1}–${Math.min(offset + 50, result.total)} of ${result.total}`
    : "No users";
  $("previous-page").disabled = offset === 0;
  $("next-page").disabled = offset + 50 >= result.total;
}
$("csv-file").onchange = async (event) => {
  usersToImport = [];
  $("import-users").disabled = true;
  $("csv-preview").hidden = true;
  $("import-result").textContent = "";
  $("import-errors").replaceChildren();
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 131072) throw new Error("CSV must be smaller than 128 KB.");
    usersToImport = parseUsersCSV(await file.text());
    const table = $("csv-preview").querySelector("tbody");
    table.replaceChildren();
    for (const user of usersToImport) {
      const row = node("tr");
      row.append(
        node("td", user.email),
        node("td", user.name),
        node("td", user.role),
      );
      table.append(row);
    }
    $("csv-summary").textContent =
      `${usersToImport.length} valid users. Review them before importing.`;
    $("csv-preview").hidden = false;
    $("import-users").disabled = false;
  } catch (e) {
    $("csv-summary").textContent = e.message;
  }
};
$("import-users").onclick = async () => {
  importing = true;
  $("import-progress").hidden = false;
  $("import-progress").max = usersToImport.length;
  $("import-progress").value = 0;
  $("import-users").disabled = true;
  $("csv-file").disabled = true;
  let created = 0,
    failed = 0;
  for (const user of usersToImport) {
    try {
      await accountRequest("admin/users", user);
      created++;
    } catch (e) {
      failed++;
      $("import-errors").append(node("li", `${user.email}: ${e.message}`));
    }
    $("import-result").textContent =
      `${created} created · ${failed} failed · ${usersToImport.length - created - failed} remaining`;
    $("import-progress").value = created + failed;
  }
  usersToImport = [];
  $("csv-file").value = "";
  $("csv-file").disabled = false;
  importing = false;
  notify(
    `Import finished: ${created} created${failed ? `, ${failed} need attention` : ""}.`,
  );
  $("csv-summary").textContent =
    "Import finished. Failed rows can be corrected and uploaded again.";
  try {
    await listUsers();
  } catch (e) {
    $("admin-error").textContent = e.message;
  }
};
window.addEventListener("beforeunload", (event) => {
  if (importing) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("refresh-users").onclick = (event) => action(event.currentTarget, listUsers);
$("previous-page").onclick = async () => {
  offset = Math.max(0, offset - 50);
  try {
    await listUsers();
  } catch (e) {
    $("admin-error").textContent = e.message;
  }
};
$("next-page").onclick = async () => {
  offset += 50;
  try {
    await listUsers();
  } catch (e) {
    $("admin-error").textContent = e.message;
  }
};
$("reset-close").onclick = () => $("reset-dialog").close();
$("reset-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await accountRequest("admin/password", {
      userId: resetting.id,
      password: event.currentTarget.elements.password.value,
    });
    $("reset-form").reset();
    $("reset-error").textContent =
      "Password reset. Existing sign-ins have ended.";
  } catch (e) {
    $("reset-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
try {
  const user = await requireLogin();
  if (user.role !== "admin") $("denied").hidden = false;
  else {
    $("administration").hidden = false;
    await listUsers();
  }
} catch (e) {
  $("admin-error").textContent = e.message;
}
