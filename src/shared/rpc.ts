import type { Page, SearchHit, Session, TabGroupSuggestion, Workspace } from './types';

export interface OpenTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  favIconUrl?: string;
  lastAccessed: number;
}

export interface TabsOverview {
  total: number;
  tabs: OpenTab[];
  stale: OpenTab[];
  duplicates: OpenTab[];
}

export interface PageStatus {
  page?: Page;
  gone?: string;
  blocked: boolean;
  paused: boolean;
}

export type PutAwayScope =
  | { scope: 'window' }
  | { scope: 'tabs'; tabIds: number[] }
  | { scope: 'stale' };

export interface Api {
  putAway(args: PutAwayScope & { name?: string; windowId?: number }): Session | null;
  restore(args: { id: string; deleteAfter?: boolean }): void;
  overview(): TabsOverview;
  closeDuplicates(): number;
  suggestGroups(): TabGroupSuggestion[];
  groupInBrowser(args: { tabIds: number[]; name: string }): void;
  search(args: { query: string }): SearchHit[];
  createWorkspace(args: { name: string; windowId?: number }): Workspace;
  switchWorkspace(args: { id: string; windowId?: number }): void;
  deleteWorkspace(args: { id: string }): void;
  pageStatus(args: { tabId: number; url: string }): PageStatus;
  importHistory(): number;
  reindex(): void;
}

export async function call<M extends keyof Api>(method: M, args?: Parameters<Api[M]>[0]): Promise<ReturnType<Api[M]>> {
  const res = await chrome.runtime.sendMessage({ to: 'bg', method, args });
  if (res?.error) throw new Error(res.error);
  return res?.value;
}
