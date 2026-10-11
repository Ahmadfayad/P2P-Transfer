const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("document-exchange-v3", 1);
  request.onupgradeneeded = () => {
    for (const name of ["sessions", "files", "chunks"])
      request.result.createObjectStore(name, { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
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
