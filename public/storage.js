let accountReady;
let database = new Promise((resolve) => {
  accountReady = resolve;
});
export function useAccount(id) {
  if (typeof id !== "string" || !id || id.length > 128)
    throw new Error("Please sign in before opening saved files.");
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open("document-exchange-v3-" + id, 1);
    request.onupgradeneeded = () => {
      for (const name of ["sessions", "files", "chunks"])
        request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  accountReady(database);
}
export async function transaction(names, action, mode = "readwrite") {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let value;
    const stores = Object.fromEntries(
      names.map((name) => [name, tx.objectStore(name)]),
    );
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error("Could not save this file on this device."));
    try {
      value = action(stores);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
export async function get(store, id) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function all(store) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export const put = (store, value) =>
  transaction([store], (s) => s[store].put(value));
export const remove = (store, id) =>
  transaction([store], (s) => s[store].delete(id));

async function legacyDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("document-exchange-v3");
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}
export async function legacyAvailable() {
  const owner = localStorage.getItem("exchange-legacy-owner");
  if (owner) return false;
  const old = await legacyDatabase();
  if (!old) return false;
  try {
    return await new Promise((resolve, reject) => {
      const request = old.transaction("files").objectStore("files").count();
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => reject(request.error);
    });
  } finally {
    old.close();
  }
}
export async function recoverLegacy(account) {
  const owner = localStorage.getItem("exchange-legacy-owner");
  if (owner && owner !== account)
    throw new Error(
      "Earlier files have already been recovered by another account on this browser.",
    );
  if (owner === account) return 0;
  const old = await legacyDatabase();
  if (!old) return 0;
  try {
    const names = ["sessions", "files", "chunks"];
    const records = await Promise.all(
      names.map(
        (name) =>
          new Promise((resolve, reject) => {
            const request = old.transaction(name).objectStore(name).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    await transaction(names, (stores) => {
      for (let i = 0; i < names.length; i++)
        for (const record of records[i]) stores[names[i]].add(record);
    });
    localStorage.setItem("exchange-legacy-owner", account);
    return records[1].length;
  } finally {
    old.close();
  }
}
