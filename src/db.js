// Tiny IndexedDB wrapper. Stores:
//  - 'songs' : song metadata keyed by id
//  - 'audio' : generated WAV blobs keyed by id
//  - 'playlists' : playlist metadata keyed by id
//  - 'meta' : small key/value store (e.g. the Workspace folder handle)
//
// Family accounts: 'songs' and 'playlists' are per-member. Writes are stamped
// with the active member's id, reads are filtered to it — callers don't need
// to know. The active member lives here so every caller shares one source.

const DB_NAME = 'music-for-studio';
const DB_VERSION = 3;

const MEMBERED_STORES = new Set(['songs', 'playlists']);
let activeMember = localStorage.getItem('mfs.activeMember') || 'me';

export function getActiveMember() {
  return activeMember;
}

export function setActiveMember(id) {
  activeMember = id || 'me';
  localStorage.setItem('mfs.activeMember', activeMember);
}

// One-time migration: songs/playlists created before family accounts have no
// memberId — they belong to the owner ('me').
export async function migrateMembers() {
  const db = await initDB();
  for (const store of MEMBERED_STORES) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = os.getAll();
      req.onsuccess = () => {
        for (const value of req.result || []) {
          if (value && !value.memberId) os.put({ ...value, memberId: 'me' });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

let dbPromise = null;

export function initDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('songs')) {
          db.createObjectStore('songs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('playlists')) {
          db.createObjectStore('playlists', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' }); // small key/value store (e.g. the Workspace folder handle)
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return initDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const idbPut = (store, value) => {
  // Stamp only unclaimed records. Re-puts of songs that already carry another
  // member's id (e.g. a still-playing song ticked after a member switch) must
  // not steal it into the active member's library.
  if (MEMBERED_STORES.has(store) && value && !value.memberId) value.memberId = activeMember;
  return run(store, 'readwrite', (os) => os.put(value));
};
export const idbGet = (store, key) => run(store, 'readonly', (os) => os.get(key));

// Which member owns a record — pre-family-accounts rows belong to the owner.
const memberIdOf = (v) => (v && v.memberId) || 'me';

export async function idbGetAll(store) {
  const all = await run(store, 'readonly', (os) => os.getAll());
  if (!MEMBERED_STORES.has(store) || !Array.isArray(all)) return all;
  return all.filter((v) => memberIdOf(v) === activeMember);
}

// Song totals for EVERY member (not filtered to the active one) — used by the
// Account section's member list. Counts metadata only; audio lives elsewhere.
export async function songCountsByMember() {
  const all = await run('songs', 'readonly', (os) => os.getAll());
  const counts = {};
  for (const v of Array.isArray(all) ? all : []) counts[memberIdOf(v)] = (counts[memberIdOf(v)] || 0) + 1;
  return counts;
}
export const idbDelete = (store, key) => run(store, 'readwrite', (os) => os.delete(key));

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
