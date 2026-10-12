export function parseUsersCSV(text) {
  if (text.length > 131072) throw new Error("CSV must be smaller than 128 KB.");
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === undefined) throw new Error("CSV contains an unclosed quote.");
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === "," || c === "\n" || c === "\r" || c === undefined) {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"')
        throw new Error("CSV contains an invalid quote.");
      field += c;
    }
  }
  const header = rows.shift()?.map((v) => v.trim().toLowerCase());
  if (
    !header ||
    header.length !== 4 ||
    new Set(header).size !== 4 ||
    !["email", "name", "role", "password"].every((v) => header.includes(v))
  )
    throw new Error(
      "CSV needs exactly these columns: email,name,role,password.",
    );
  if (!rows.length || rows.length > 200)
    throw new Error("Import 1 to 200 users at a time.");
  const emails = new Set();
  return rows.map((values, i) => {
    if (values.length !== 4)
      throw new Error(`Row ${i + 2}: expected four columns.`);
    const user = Object.fromEntries(
      header.map((h, j) => [
        h,
        h === "password" ? values[j] : values[j].trim(),
      ]),
    );
    user.email = user.email.toLowerCase();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) ||
      user.email.length > 254
    )
      throw new Error(`Row ${i + 2}: invalid email.`);
    if (
      !user.name ||
      user.name.length > 64 ||
      /[\x00-\x1f\x7f]/.test(user.name)
    )
      throw new Error(`Row ${i + 2}: invalid name.`);
    if (!["admin", "staff"].includes(user.role))
      throw new Error(
        `Row ${i + 2}: employee role must be admin or staff. Students use QR invitations without accounts.`,
      );
    if (user.password.length < 6 || user.password.length > 128)
      throw new Error(
        `Row ${i + 2}: password must contain 6 to 128 characters.`,
      );
    if (emails.has(user.email))
      throw new Error(`Row ${i + 2}: duplicate email.`);
    emails.add(user.email);
    return user;
  });
}
