import type { Chunk, DayRow, Page, Session, Workspace } from './types';

const DB_NAME = 'putaway';
const DB_VERSION = 1;

let opening: Promise<IDBDatabase> | undefined;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const pages = db.createObjectStore('pages', { keyPath: 'url' });
      pages.createIndex('lastSeen', 'lastSeen');
      pages.createIndex('indexed', 'indexed');
      pages.createIndex('changedAt', 'changedAt');
      const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
      chunks.createIndex('url', 'url');
      db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      db.createObjectStore('workspaces', { keyPath: 'id' });
      db.createObjectStore('days', { keyPath: 'id' }).createIndex('day', 'day');
    };
    req.onsuccess = () => {
      req.result.onclose = () => (opening = undefined);
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
  });
  return opening;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

type StoreName = 'pages' | 'chunks' | 'sessions' | 'workspaces' | 'days';

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).get(key));
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).getAll());
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await committed(tx);
}

export async function remove(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await committed(tx);
}

export async function count(store: StoreName): Promise<number> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).count());
}

export async function putMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await committed(tx);
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  const names: StoreName[] = ['pages', 'chunks', 'sessions', 'workspaces', 'days'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await committed(tx);
}

export async function pagesToIndex(limit: number): Promise<Page[]> {
  const db = await openDb();
  return done(db.transaction('pages').objectStore('pages').index('indexed').getAll(0, limit));
}

/** Replaces a page's chunks and marks it indexed in one transaction. */
export async function saveChunks(page: Page, chunks: Chunk[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['pages', 'chunks'], 'readwrite');
  const cs = tx.objectStore('chunks');
  const pages = tx.objectStore('pages');
  const keys = await done(cs.index('url').getAllKeys(page.url));
  for (const k of keys) cs.delete(k);
  for (const c of chunks) cs.put(c);
  const current = await done(pages.get(page.url));
  // A newer capture may have landed while embedding ran. Leave it queued.
  if (current && current.hash === page.hash) pages.put({ ...current, indexed: 1 });
  await committed(tx);
}

export async function deletePage(url: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['pages', 'chunks'], 'readwrite');
  const cs = tx.objectStore('chunks');
  tx.objectStore('pages').delete(url);
  const keys = await done(cs.index('url').getAllKeys(url));
  for (const k of keys) cs.delete(k);
  await committed(tx);
}

export async function daysSince(day: string): Promise<DayRow[]> {
  const db = await openDb();
  const idx = db.transaction('days').objectStore('days').index('day');
  return done(idx.getAll(IDBKeyRange.lowerBound(day)));
}

export async function sessionsNewestFirst(): Promise<Session[]> {
  const all = await getAll<Session>('sessions');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export const workspaces = () => getAll<Workspace>('workspaces');
