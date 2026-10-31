import * as db from '../shared/db';
import type { DayRow, Page, Session, Workspace } from '../shared/types';

const ITERATIONS = 600_000;

interface Backup {
  version: 1;
  pages: Page[];
  sessions: Session[];
  workspaces: Workspace[];
  days: DayRow[];
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** File layout: 16 byte salt, 12 byte IV, AES-GCM ciphertext of gzipped JSON. */
export async function createBackup(passphrase: string): Promise<Blob> {
  const backup: Backup = {
    version: 1,
    pages: await db.getAll('pages'),
    sessions: await db.getAll('sessions'),
    workspaces: await db.getAll('workspaces'),
    days: await db.getAll('days'),
  };
  const zipped = new Blob([JSON.stringify(backup)]).stream().pipeThrough(new CompressionStream('gzip'));
  const plain = await new Response(zipped).arrayBuffer();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(passphrase, salt), plain);
  return new Blob([salt, iv, cipher], { type: 'application/octet-stream' });
}

/** Merges a backup into this profile and queues every page for re-indexing. */
export async function restoreBackup(file: Blob, passphrase: string) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await deriveKey(passphrase, salt), bytes.slice(28));
  } catch {
    throw new Error('Wrong passphrase, or this is not a Putaway backup');
  }
  const json = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  const backup: Backup = await new Response(json).json();
  await db.putMany('pages', backup.pages.map((p) => ({ ...p, indexed: 0 as const })));
  await db.putMany('sessions', backup.sessions);
  await db.putMany('workspaces', backup.workspaces);
  await db.putMany('days', backup.days);
  return backup.pages.length;
}
