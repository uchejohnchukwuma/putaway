import * as db from './shared/db';
import { isBlocked } from './shared/privacy';
import type { Api, OpenTab, PageStatus, PutAwayScope, TabsOverview } from './shared/rpc';
import { domainOf, hashText, isMeaningfulChange, nameFor, normalizeUrl } from './shared/text';
import { DEFAULT_SETTINGS } from './shared/types';
import type { CapturePayload, DayRow, Page, SavedTab, Session, Settings, TabGroupSuggestion, Workspace } from './shared/types';

const DAY = 86_400_000;
const REPO = 'uchejohnchukwuma/putaway';
const MAX_HISTORY = 5000;

async function settings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings>) };
}

const isWeb = (url?: string): url is string => !!url && /^https?:/.test(url);
const localDay = (t = Date.now()) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/* ---- Offscreen document ---- */

let creating: Promise<void> | undefined;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the on-device search model and indexes saved pages.',
    })
    .finally(() => (creating = undefined));
  await creating;
}

async function toOffscreen<T>(message: Record<string, unknown>): Promise<T> {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ to: 'offscreen', ...message });
      if (res?.error) throw new Error(res.error);
      return res?.value;
    } catch (e) {
      const notReady = String(e).includes('Receiving end does not exist');
      if (!notReady || attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

const kickIndexer = () => toOffscreen({ method: 'drain' }).catch((e) => console.warn('Putaway indexer', e));

/* ---- Capture ---- */

async function goneUrls(): Promise<Record<string, string>> {
  return ((await chrome.storage.session.get('gone')).gone ?? {}) as Record<string, string>;
}

async function markGone(tabId: number, url: string) {
  const gone = await goneUrls();
  gone[tabId] = url;
  await chrome.storage.session.set({ gone });
  if (isWeb(url) && (await db.get<Page>('pages', normalizeUrl(url)))?.text) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93a00' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
  }
}

async function clearGone(tabId: number) {
  const gone = await goneUrls();
  if (!(tabId in gone)) return;
  delete gone[tabId];
  await chrome.storage.session.set({ gone });
}

async function capture(raw: CapturePayload, tabId?: number) {
  const s = await settings();
  if (s.paused || isBlocked(raw.url, s.blockedDomains)) return;
  // A 404 or error page must never replace a good saved copy.
  if (tabId !== undefined && tabId in (await goneUrls())) return;

  const url = normalizeUrl(raw.url);
  const now = Date.now();
  const hash = hashText(raw.text);
  const old = await db.get<Page>('pages', url);

  if (old?.hash === hash) {
    await db.put('pages', { ...old, title: raw.title || old.title, lastSeen: now, visits: old.visits + 1 });
    return;
  }

  const changed = !!old?.text && isMeaningfulChange(old.text, raw.text);
  const page: Page = {
    url,
    title: raw.title || old?.title || url,
    domain: domainOf(url),
    text: raw.text,
    hash,
    firstSeen: old?.firstSeen ?? now,
    lastSeen: now,
    visits: (old?.visits ?? 0) + 1,
    source: 'page',
    indexed: 0,
    previousText: changed ? old!.text : old?.previousText,
    previousAt: changed ? old!.lastSeen : old?.previousAt,
    changedAt: changed ? now : old?.changedAt,
  };
  await db.put('pages', page);
  await kickIndexer();
}

async function recordDwell(rawUrl: string, title: string, ms: number) {
  const s = await settings();
  if (s.paused || isBlocked(rawUrl, s.blockedDomains)) return;
  const url = normalizeUrl(rawUrl);
  const day = localDay();
  const id = `${day}|${url}`;
  const row = await db.get<DayRow>('days', id);
  await db.put<DayRow>('days', { id, day, url, title, domain: domainOf(url), dwellMs: (row?.dwellMs ?? 0) + ms });
}

async function captureOpenTab(tab: chrome.tabs.Tab) {
  if (!tab.id || tab.discarded || !isWeb(tab.url)) return;
  const timeout = new Promise((r) => setTimeout(r, 1200));
  await Promise.race([chrome.tabs.sendMessage(tab.id, { kind: 'capture-now' }).catch(() => {}), timeout]);
}

/* ---- Tabs ---- */

const toSaved = (t: chrome.tabs.Tab): SavedTab => ({ url: t.url!, title: t.title || t.url!, favIconUrl: t.favIconUrl, pinned: t.pinned });

async function targetWindow(windowId?: number) {
  return windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id!;
}

async function overview(): Promise<TabsOverview> {
  const { staleDays } = await settings();
  const all = await chrome.tabs.query({});
  const web = all.filter((t) => isWeb(t.url));
  const toOpen = (t: chrome.tabs.Tab): OpenTab => ({
    id: t.id!, windowId: t.windowId, url: t.url!, title: t.title || t.url!, favIconUrl: t.favIconUrl, lastAccessed: t.lastAccessed ?? 0,
  });
  const cutoff = Date.now() - staleDays * DAY;
  const stale = web.filter((t) => !t.pinned && !t.active && (t.lastAccessed ?? 0) < cutoff).map(toOpen);

  const seen = new Map<string, chrome.tabs.Tab>();
  const duplicates: OpenTab[] = [];
  for (const t of [...web].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))) {
    const key = normalizeUrl(t.url!);
    if (seen.has(key)) duplicates.push(toOpen(t));
    else seen.set(key, t);
  }
  return { total: web.length, tabs: web.map(toOpen), stale, duplicates };
}

async function resolveTabs(args: PutAwayScope & { windowId?: number }): Promise<chrome.tabs.Tab[]> {
  if (args.scope === 'tabs') {
    const tabs = await Promise.all(args.tabIds.map((id) => chrome.tabs.get(id).catch(() => undefined)));
    return tabs.filter((t): t is chrome.tabs.Tab => !!t);
  }
  if (args.scope === 'stale') {
    const { stale } = await overview();
    return resolveTabs({ scope: 'tabs', tabIds: stale.map((t) => t.id) });
  }
  const windowId = await targetWindow(args.windowId);
  return (await chrome.tabs.query({ windowId })).filter((t) => !t.pinned);
}

/** Closes tabs and leaves every affected window with at least one tab open. */
async function closeTabs(tabs: chrome.tabs.Tab[]) {
  for (const windowId of new Set(tabs.map((t) => t.windowId))) {
    const open = await chrome.tabs.query({ windowId });
    if (open.every((t) => tabs.some((x) => x.id === t.id))) await chrome.tabs.create({ windowId, active: true });
  }
  await chrome.tabs.remove(tabs.map((t) => t.id!));
}

async function putAway(args: Parameters<Api['putAway']>[0]): Promise<Session | null> {
  const tabs = (await resolveTabs(args)).filter((t) => isWeb(t.url));
  if (!tabs.length) return null;
  await Promise.all(tabs.map(captureOpenTab));
  const titles = tabs.map((t) => t.title || t.url!);
  const session: Session = {
    id: crypto.randomUUID(),
    name: args.name?.trim() || nameFor(titles, domainOf(tabs[0].url!)),
    createdAt: Date.now(),
    tabs: tabs.map(toSaved),
  };
  await db.put('sessions', session);
  await closeTabs(tabs);
  await refreshBadge();
  return session;
}

async function openTabs(saved: SavedTab[], windowId: number, groupName?: string) {
  const ids: number[] = [];
  for (const t of saved) {
    const tab = await chrome.tabs.create({ windowId, url: t.url, active: false, pinned: t.pinned });
    if (tab.id && !t.pinned) ids.push(tab.id);
  }
  if (groupName && ids.length) await groupInBrowser(ids, groupName, windowId);
}

async function groupInBrowser(tabIds: number[], name: string, windowId?: number) {
  const ids = tabIds as [number, ...number[]];
  const groupId = await chrome.tabs.group({ tabIds: ids, ...(windowId ? { createProperties: { windowId } } : {}) });
  await chrome.tabGroups.update(groupId, { title: name.slice(0, 40), collapsed: false });
}

async function restore(id: string, deleteAfter?: boolean) {
  const session = await db.get<Session>('sessions', id);
  if (!session) throw new Error('That session no longer exists');
  await openTabs(session.tabs, await targetWindow(), session.name);
  if (deleteAfter) await db.remove('sessions', id);
  else await db.put('sessions', { ...session, restoredAt: Date.now() });
}

async function closeDuplicates() {
  const { duplicates } = await overview();
  if (duplicates.length) await chrome.tabs.remove(duplicates.map((t) => t.id));
  await refreshBadge();
  return duplicates.length;
}

async function suggestGroups(): Promise<TabGroupSuggestion[]> {
  const { tabs } = await overview();
  const input = tabs.map((t) => ({ id: t.id, title: t.title, domain: domainOf(t.url) }));
  return toOffscreen({ method: 'group', tabs: input });
}

/* ---- Workspaces ---- */

async function activeWorkspace(): Promise<Workspace> {
  const activeWorkspaceId = (await chrome.storage.local.get('activeWorkspaceId')).activeWorkspaceId as string | undefined;
  const found = activeWorkspaceId ? await db.get<Workspace>('workspaces', activeWorkspaceId) : undefined;
  if (found) return found;
  const main: Workspace = { id: crypto.randomUUID(), name: 'Main', updatedAt: Date.now(), tabs: [] };
  await db.put('workspaces', main);
  await chrome.storage.local.set({ activeWorkspaceId: main.id });
  return main;
}

async function switchWorkspace(id: string, windowId?: number) {
  const current = await activeWorkspace();
  if (current.id === id) return;
  const target = await db.get<Workspace>('workspaces', id);
  if (!target) throw new Error('That workspace no longer exists');

  const win = await targetWindow(windowId);
  const open = (await chrome.tabs.query({ windowId: win })).filter((t) => !t.pinned);
  const web = open.filter((t) => isWeb(t.url));
  await Promise.all(web.map(captureOpenTab));
  await db.put('workspaces', { ...current, tabs: web.map(toSaved), updatedAt: Date.now() });
  await chrome.storage.local.set({ activeWorkspaceId: id });
  await openTabs(target.tabs, win);
  // Saved first and opened second, so a failure cannot lose the outgoing tabs.
  if (web.length) await closeTabs(web);
}

async function createWorkspace(name: string, windowId?: number) {
  await activeWorkspace();
  const ws: Workspace = { id: crypto.randomUUID(), name: name.trim() || 'Untitled', updatedAt: Date.now(), tabs: [] };
  await db.put('workspaces', ws);
  await switchWorkspace(ws.id, windowId);
  return ws;
}

async function deleteWorkspace(id: string) {
  const active = await activeWorkspace();
  if (active.id === id) throw new Error('Switch to another workspace before deleting this one');
  await db.remove('workspaces', id);
}

/* ---- Status, history, updates ---- */

async function pageStatus(tabId: number, url: string): Promise<PageStatus> {
  const s = await settings();
  const gone = (await goneUrls())[tabId];
  const target = gone ?? url;
  const page = isWeb(target) ? await db.get<Page>('pages', normalizeUrl(target)) : undefined;
  return { page, gone, paused: s.paused, blocked: isBlocked(url, s.blockedDomains) };
}

async function importHistory() {
  const s = await settings();
  const items = await chrome.history.search({ text: '', startTime: Date.now() - 90 * DAY, maxResults: MAX_HISTORY });
  const rows: Page[] = [];
  for (const h of items) {
    if (!isWeb(h.url) || isBlocked(h.url, s.blockedDomains)) continue;
    const url = normalizeUrl(h.url);
    if (await db.get('pages', url)) continue;
    const seen = h.lastVisitTime ?? Date.now();
    rows.push({
      url, title: h.title || url, domain: domainOf(url), text: '', hash: hashText(h.title || url),
      firstSeen: seen, lastSeen: seen, visits: h.visitCount ?? 1, source: 'history', indexed: 0,
    });
  }
  await db.putMany('pages', rows);
  await kickIndexer();
  return rows.length;
}

async function reindex() {
  const pages = await db.getAll<Page>('pages');
  await db.putMany('pages', pages.map((p) => ({ ...p, indexed: 0 as const })));
  await kickIndexer();
}

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, '').split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

async function checkForUpdate() {
  if (!(await settings()).checkUpdates) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const { tag_name: tag, html_url: url } = await res.json();
    const available = newer(tag, chrome.runtime.getManifest().version);
    await chrome.storage.local.set({ update: available ? { tag, url } : null });
  } catch {
    // Offline. The next daily check will try again.
  }
}

async function refreshBadge() {
  const { stale } = await overview();
  await chrome.action.setBadgeBackgroundColor({ color: '#1c1a17' });
  await chrome.action.setBadgeText({ text: stale.length ? String(stale.length) : '' });
}

async function firstLook() {
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
    if (!tab.id || tab.discarded) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await captureOpenTab(tab);
    } catch {
      // Store pages and some restricted hosts refuse injection.
    }
  }
}

/* ---- Wiring ---- */

const api: { [M in keyof Api]: (args: never) => Promise<unknown> } = {
  putAway: (a: Parameters<Api['putAway']>[0]) => putAway(a),
  restore: (a: { id: string; deleteAfter?: boolean }) => restore(a.id, a.deleteAfter),
  overview,
  closeDuplicates,
  suggestGroups,
  groupInBrowser: (a: { tabIds: number[]; name: string }) => groupInBrowser(a.tabIds, a.name),
  search: (a: { query: string }) => toOffscreen({ method: 'search', query: a.query }),
  createWorkspace: (a: { name: string; windowId?: number }) => createWorkspace(a.name, a.windowId),
  switchWorkspace: (a: { id: string; windowId?: number }) => switchWorkspace(a.id, a.windowId),
  deleteWorkspace: (a: { id: string }) => deleteWorkspace(a.id),
  pageStatus: (a: { tabId: number; url: string }) => pageStatus(a.tabId, a.url),
  importHistory,
  reindex,
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.kind === 'capture') {
    capture(msg.page, sender.tab?.id).catch((e) => console.warn('Putaway capture', e));
    return;
  }
  if (msg?.kind === 'dwell') {
    recordDwell(msg.url, msg.title, msg.ms).catch((e) => console.warn('Putaway dwell', e));
    return;
  }
  if (msg?.to !== 'bg') return;
  const fn = api[msg.method as keyof Api] as ((a: unknown) => Promise<unknown>) | undefined;
  if (!fn) return;
  fn(msg.args).then((value) => reply({ value }), (e) => reply({ error: String(e?.message ?? e) }));
  return true;
});

chrome.webNavigation.onBeforeNavigate.addListener(({ frameId, tabId }) => {
  if (frameId === 0) clearGone(tabId);
});

chrome.webNavigation.onErrorOccurred.addListener(({ frameId, tabId, url, error }) => {
  if (frameId === 0 && error !== 'net::ERR_ABORTED') markGone(tabId, url);
});

chrome.webRequest.onCompleted.addListener(
  ({ tabId, url, statusCode }) => {
    if (tabId >= 0 && (statusCode === 404 || statusCode === 410 || statusCode >= 500)) markGone(tabId, url);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearGone(tabId);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'put-away-window') putAway({ scope: 'window' });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'hourly') refreshBadge();
  if (alarm.name === 'daily') checkForUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
  refreshBadge();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.alarms.create('hourly', { periodInMinutes: 60 });
  await chrome.alarms.create('daily', { periodInMinutes: 1440, delayInMinutes: 1 });
  await refreshBadge();
  await firstLook();
  if (reason === 'install') {
    await importHistory();
    await chrome.tabs.create({ url: 'newtab.html' });
  } else {
    await kickIndexer();
  }
});
