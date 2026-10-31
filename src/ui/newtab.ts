import * as db from '../shared/db';
import { call, type TabsOverview } from '../shared/rpc';
import { diffText, fragmentLink } from '../shared/text';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { DayRow, Page, SearchHit, Session, Settings, Workspace } from '../shared/types';
import { createBackup, restoreBackup } from './backup';
import { ago, download, duration, esc, favicon, safeHref } from './format';

const app = document.getElementById('app')!;
const dialog = document.getElementById('dialog') as HTMLDialogElement;
const toastEl = document.getElementById('toast')!;

const HINTS = ['that pricing article from tuesday', 'the furnace spec sheet', 'apartments near the lake last week', 'what did that doc say about refunds'];

async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings>) };
}

async function saveSettings(patch: Partial<Settings>) {
  await chrome.storage.local.set({ settings: { ...(await loadSettings()), ...patch } });
}

let windowId: number | undefined;
const win = async () => (windowId ??= (await chrome.windows.getCurrent()).id);

let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string, undo?: () => void) {
  toastEl.innerHTML = `<span>${esc(message)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`;
  toastEl.classList.add('on');
  toastEl.querySelector('#undo')?.addEventListener('click', () => {
    toastEl.classList.remove('on');
    undo?.();
  });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 7000);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---- Shelf ---- */

function deskHtml(o: TabsOverview) {
  return `
    <section class="desk">
      <div>
        <div class="tally">
          <div class="count" id="tab-count">${o.total}</div>
          <div class="count-label">${o.total === 1 ? 'tab' : 'tabs'} on your desk</div>
        </div>
        <button class="btn hot big" data-act="put-window">Put it all away</button>
        <div class="chores">
          ${o.stale.length ? `<button class="btn small" data-act="put-stale">Put away ${plural(o.stale.length, 'stale tab')}</button>` : ''}
          ${o.duplicates.length ? `<button class="btn small" data-act="close-dupes">Close ${plural(o.duplicates.length, 'duplicate')}</button>` : ''}
        </div>
      </div>
      <div>
        <p class="eyebrow">Looks like these belong together</p>
        <div class="sheets" id="groups"><p class="soft">Sorting your tabs…</p></div>
      </div>
    </section>`;
}

function boxHtml(s: Session, i: number) {
  const fresh = Date.now() - s.createdAt < 3_600_000;
  return `
    <button class="box ${fresh ? 'fresh' : ''}" style="--i:${Math.min(i, 12)}" data-act="open-box" data-id="${esc(s.id)}" aria-label="${esc(s.name)}, ${plural(s.tabs.length, 'tab')}">
      <span class="box-lid"></span>
      <span class="box-front">
        <span class="box-label"><strong>${esc(s.name)}</strong></span>
        <span class="box-meta"><span class="box-count">${s.tabs.length}</span><span>${esc(ago(s.createdAt))}</span></span>
      </span>
    </button>`;
}

function shelfHtml(sessions: Session[]) {
  if (!sessions.length) {
    return `<div class="empty"><h3>Nothing on the shelf yet.</h3>
      <p class="soft">Put a group of tabs away and it lands here as a box. Open it whenever you need it, and everything inside can still be found by search.</p></div>`;
  }
  return `<div class="shelf-row">${sessions.map(boxHtml).join('')}</div>`;
}

function workspacesHtml(list: Workspace[], activeId?: string) {
  if (!list.length) return '';
  return `<div class="workspaces" role="group" aria-label="Workspaces">
    ${list.map((w) => `<button data-act="switch-ws" data-id="${esc(w.id)}" aria-pressed="${w.id === activeId}">${esc(w.name)}</button>`).join('')}
    <button class="add" data-act="new-ws">+ Workspace</button>
  </div>`;
}

async function renderShelf() {
  const [o, sessions, spaces, { activeWorkspaceId }] = await Promise.all([
    call('overview'), db.sessionsNewestFirst(), db.workspaces(), chrome.storage.local.get('activeWorkspaceId'),
  ]);
  const hint = HINTS[Math.floor(Math.random() * HINTS.length)];
  app.innerHTML = `
    ${workspacesHtml(spaces, activeWorkspaceId as string | undefined)}
    <form class="search" id="search-form" role="search">
      <input id="q" type="search" autocomplete="off" aria-label="Search everything you've read" placeholder="${esc(hint)}" />
    </form>
    <div id="results" hidden></div>
    <div id="home">
      ${deskHtml(o)}
      <div class="section-head"><h2>The shelf</h2>
        ${spaces.length ? '' : '<button class="linkish" data-act="new-ws">Add a workspace</button>'}</div>
      <div class="planks">${shelfHtml(sessions)}</div>
    </div>`;
  bindSearch();
  loadGroups();
}

async function loadGroups() {
  const box = document.getElementById('groups');
  if (!box) return;
  try {
    const groups = await call('suggestGroups');
    if (!document.body.contains(box)) return;
    box.innerHTML = groups.length
      ? groups.slice(0, 4).map((g, i) => `
        <article class="sheet" data-group="${i}">
          <div><h3>${esc(g.name)}</h3><span class="soft mono">${plural(g.tabIds.length, 'tab')}</span></div>
          <div class="actions">
            <button class="btn small quiet" data-act="group-browser" data-group="${i}">Group</button>
            <button class="btn small hot" data-act="put-group" data-group="${i}">Put away</button>
          </div>
        </article>`).join('')
      : '<p class="soft">Nothing to sort right now.</p>';
    groupCache = groups;
  } catch {
    box.innerHTML = '<p class="soft">Sorting is warming up. It will be ready next time you open this page.</p>';
  }
}

let groupCache: Awaited<ReturnType<typeof call<'suggestGroups'>>> = [];

function hitHtml(h: SearchHit) {
  return `<article class="result">
    <a class="title" href="${safeHref(fragmentLink(h.url, h.sentence))}" target="_blank" rel="noopener">${favicon(h.url)}${esc(h.title)}</a>
    ${h.snippet ? `<p>${esc(h.snippet)}</p>` : ''}
    <div class="meta"><span>${esc(h.domain)}</span><span>${esc(ago(h.lastSeen))}</span>
      ${h.sentence ? '<span class="tag">Jumps to passage</span>' : ''}
      ${h.hasCopy ? `<a href="#read/${encodeURIComponent(h.url)}">Saved copy</a>` : ''}</div>
  </article>`;
}

function bindSearch() {
  const input = document.getElementById('q') as HTMLInputElement;
  const results = document.getElementById('results')!;
  const home = document.getElementById('home')!;
  let timer: ReturnType<typeof setTimeout>;
  let latest = 0;
  const run = async () => {
    const query = input.value.trim();
    const mine = ++latest;
    results.hidden = !query;
    home.hidden = !!query;
    if (!query) return;
    const hits = await call('search', { query }).catch(() => [] as SearchHit[]);
    if (mine !== latest) return;
    results.innerHTML = hits.length
      ? `<div class="results">${hits.map(hitHtml).join('')}</div>`
      : `<div class="empty"><h3>Nothing matched.</h3><p class="soft">Try the idea in other words. Pages are searchable after you've stayed on them for 15 seconds.</p></div>`;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 220);
  });
  document.getElementById('search-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    run();
  });
  input.focus();
}

function showBox(s: Session) {
  dialog.innerHTML = `
    <p class="eyebrow">Put away ${esc(ago(s.createdAt))}</p>
    <h2>${esc(s.name)}</h2>
    <ul>${s.tabs.map((t) => `<li>${favicon(t.url)}<a href="${safeHref(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a></li>`).join('')}</ul>
    <div class="row">
      <button class="btn hot" data-act="unpack" data-id="${esc(s.id)}">Open all ${s.tabs.length}</button>
      <button class="btn" data-act="unpack-remove" data-id="${esc(s.id)}">Open and remove box</button>
      <button class="btn quiet" data-act="rename-box" data-id="${esc(s.id)}">Rename</button>
      <button class="btn quiet" data-act="delete-box" data-id="${esc(s.id)}">Delete</button>
      <button class="btn quiet" data-act="close-dialog">Close</button>
    </div>`;
  dialog.showModal();
}

function ask(title: string, label: string, value = ''): Promise<string | null> {
  return new Promise((resolve) => {
    dialog.innerHTML = `<h2>${esc(title)}</h2>
      <form method="dialog" id="ask-form"><p><label>${esc(label)}<br /><input class="field" id="ask" value="${esc(value)}" required /></label></p>
      <div class="row"><button class="btn hot" type="submit">Save</button><button class="btn quiet" type="button" data-act="close-dialog">Cancel</button></div></form>`;
    if (!dialog.open) dialog.showModal();
    const input = dialog.querySelector<HTMLInputElement>('#ask')!;
    input.select();
    let answer: string | null = null;
    dialog.querySelector('#ask-form')!.addEventListener('submit', () => (answer = input.value.trim()));
    dialog.addEventListener('close', () => resolve(answer), { once: true });
  });
}

async function afterPutAway(session: Session | null) {
  await render();
  if (session) {
    toast(`Put away ${plural(session.tabs.length, 'tab')} as “${session.name}”.`, async () => {
      await call('restore', { id: session.id, deleteAfter: true });
      await render();
    });
  }
}

/* ---- Library ---- */

let libraryFilter: 'all' | 'changed' | 'title' = 'all';

async function renderLibrary() {
  const pages = (await db.getAll<Page>('pages')).sort((a, b) => b.lastSeen - a.lastSeen);
  const copies = pages.filter((p) => p.text);
  const changed = pages.filter((p) => p.changedAt);
  const titles = pages.filter((p) => !p.text);
  const list = { all: copies, changed, title: titles }[libraryFilter];
  const button = (key: typeof libraryFilter, label: string, n: number) =>
    `<button class="btn small ${libraryFilter === key ? 'hot' : ''}" data-act="filter" data-key="${key}">${label} ${n}</button>`;
  app.innerHTML = `
    <h1 class="page-title">Library</h1>
    <p class="soft">Saved copies stay readable here even if the original page disappears.</p>
    <div class="filters">${button('all', 'Saved copies', copies.length)}${button('changed', 'Changed', changed.length)}${button('title', 'Title only', titles.length)}</div>
    <div class="results">${list.slice(0, 200).map((p) => `
      <article class="result">
        <a class="title" href="#read/${encodeURIComponent(p.url)}">${favicon(p.url)}${esc(p.title)}</a>
        <div class="meta"><span>${esc(p.domain)}</span><span>${esc(ago(p.lastSeen))}</span>
          ${p.changedAt ? `<span class="tag">Changed ${esc(ago(p.changedAt))}</span>` : ''}</div>
      </article>`).join('') || '<div class="empty"><h3>Nothing here yet.</h3></div>'}</div>`;
}

async function renderReader(url: string, mode: 'copy' | 'diff' = 'copy') {
  const page = await db.get<Page>('pages', url);
  if (!page) {
    app.innerHTML = '<div class="empty"><h3>That page is no longer saved.</h3></div>';
    return;
  }
  const canDiff = !!page.previousText && !!page.changedAt;
  let body = `<p>${esc(page.text) || 'Only the title of this page was saved.'}</p>`;
  if (mode === 'diff' && canDiff) {
    const { added, removed } = diffText(page.previousText!, page.text);
    body = `<p class="eyebrow">Since ${esc(ago(page.previousAt ?? page.firstSeen))}</p>
      ${added.map((s) => `<div class="diff-added">${esc(s)}</div>`).join('')}
      ${removed.map((s) => `<div class="diff-removed">${esc(s)}</div>`).join('')}`;
  }
  app.innerHTML = `
    <p class="eyebrow">${esc(page.domain)} · saved ${esc(ago(page.lastSeen))}</p>
    <h1 class="page-title" style="font-size:clamp(32px,5vw,54px);overflow-wrap:anywhere">${esc(page.title)}</h1>
    <div class="filters">
      <a class="btn small" href="${safeHref(page.url)}" target="_blank" rel="noopener">Open original</a>
      ${canDiff ? `<button class="btn small ${mode === 'diff' ? '' : 'hot'}" data-act="read-mode" data-mode="${mode === 'diff' ? 'copy' : 'diff'}">${mode === 'diff' ? 'Show saved copy' : 'What changed'}</button>` : ''}
      <button class="btn small quiet" data-act="forget-page">Forget this page</button>
    </div>
    <article class="reader">${body}</article>`;
}

/* ---- Recap ---- */

async function recapData() {
  const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.daysSince(since);
  const sessions = (await db.sessionsNewestFirst()).filter((s) => s.createdAt > Date.now() - 7 * 86_400_000);
  const sum = (key: (r: DayRow) => string) => {
    const m = new Map<string, { label: string; ms: number; url?: string }>();
    for (const r of rows) {
      const k = key(r);
      const e = m.get(k) ?? { label: k, ms: 0, url: r.url };
      e.ms += r.dwellMs;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.ms - a.ms);
  };
  return {
    sessions,
    total: rows.reduce((n, r) => n + r.dwellMs, 0),
    sites: sum((r) => r.domain).slice(0, 8),
    pages: sum((r) => r.title || r.url).slice(0, 10),
    activeDays: new Set(rows.map((r) => r.day)).size,
  };
}

async function renderRecap() {
  const d = await recapData();
  const max = d.sites[0]?.ms ?? 1;
  app.innerHTML = `
    <h1 class="page-title">Your week</h1>
    <div class="stat-row">
      <div class="stat"><b>${duration(d.total)}</b><span class="soft">reading the web</span></div>
      <div class="stat"><b>${d.sessions.length}</b><span class="soft">${d.sessions.length === 1 ? 'box' : 'boxes'} put away</span></div>
      <div class="stat"><b>${d.activeDays}</b><span class="soft">active ${d.activeDays === 1 ? 'day' : 'days'}</span></div>
    </div>
    <div class="section-head"><h2>Where the time went</h2></div>
    <div class="bars">${d.sites.map((s) => `<div class="bar"><span>${esc(s.label)}</span><i style="width:${Math.max(2, (s.ms / max) * 100)}%"></i><span>${duration(s.ms)}</span></div>`).join('') || '<p class="soft">Your first recap will fill in as you browse.</p>'}</div>
    <div class="section-head"><h2>Most read</h2></div>
    <div class="results" style="margin-bottom:24px">${d.pages.map((p) => `<article class="result"><a class="title" href="${safeHref(p.url ?? '')}" target="_blank" rel="noopener">${esc(p.label)}</a><div class="meta">${duration(p.ms)}</div></article>`).join('')}</div>
    <button class="btn hot" data-act="export-md">Export as Markdown</button>`;
}

async function exportMarkdown() {
  const d = await recapData();
  const lines = [
    `# Putaway recap, week ending ${new Date().toISOString().slice(0, 10)}`, '',
    `Total reading time: ${duration(d.total)}`, '', '## Sites',
    ...d.sites.map((s) => `- ${s.label}: ${duration(s.ms)}`), '', '## Most read',
    ...d.pages.map((p) => `- [${p.label.replace(/[[\]]/g, '')}](${p.url}): ${duration(p.ms)}`), '', '## Put away',
    ...d.sessions.flatMap((s) => [`### ${s.name}`, ...s.tabs.map((t) => `- [${t.title.replace(/[[\]]/g, '')}](${t.url})`), '']),
  ];
  download(`putaway-recap-${new Date().toISOString().slice(0, 10)}.md`, lines.join('\n'), 'text/markdown');
}

/* ---- Settings ---- */

async function renderSettings() {
  const s = await loadSettings();
  const [pages, chunks, estimate, pending] = await Promise.all([
    db.count('pages'), db.count('chunks'), navigator.storage.estimate(), db.pagesToIndex(100_000),
  ]);
  const mb = ((estimate.usage ?? 0) / 1_048_576).toFixed(0);
  app.innerHTML = `
    <h1 class="page-title">Settings</h1>
    <section class="panel"><h3>Capture</h3>
      <label><input type="checkbox" id="paused" ${s.paused ? 'checked' : ''} /> Pause saving pages</label>
      <label>Call a tab stale after <input class="field" style="width:80px" id="stale" type="number" min="1" max="60" value="${s.staleDays}" /> days</label>
      <p>Never save these sites, one per line:</p>
      <textarea class="field" id="blocked" rows="4" placeholder="example.com">${esc(s.blockedDomains.join('\n'))}</textarea>
      <div class="row"><button class="btn small" data-act="save-blocked">Save list</button></div>
      <p class="soft">Banking, mail, messaging, health, password managers, sign-in and checkout pages are always skipped. Incognito windows are never touched.</p>
    </section>
    <section class="panel"><h3>Memory on this computer</h3>
      <p><b id="page-count">${pages}</b> pages, ${chunks} searchable passages, about ${mb} MB. ${pending.length ? `${pending.length} still being indexed.` : 'All indexed.'}</p>
      <div class="row">
        <button class="btn small" data-act="import-history">Import browser history</button>
        <button class="btn small quiet" data-act="reindex">Rebuild search index</button>
      </div>
    </section>
    <section class="panel"><h3>Encrypted backup</h3>
      <p class="soft">Saves your library to a file locked with a passphrase. Use it to move to another computer. A lost passphrase cannot be recovered.</p>
      <div class="row">
        <button class="btn small" data-act="backup">Create backup</button>
        <button class="btn small" data-act="restore-backup">Restore backup</button>
        <input type="file" id="backup-file" hidden accept=".putaway" />
      </div>
    </section>
    <section class="panel"><h3>Updates</h3>
      <label><input type="checkbox" id="updates" ${s.checkUpdates ? 'checked' : ''} /> Check GitHub once a day for a new version</label>
      <p class="soft">This is the only request Putaway makes by itself, and it sends none of your data. You are on version ${esc(chrome.runtime.getManifest().version)}.</p>
    </section>
    <section class="panel"><h3>Delete everything</h3>
      <p class="soft">Removes every saved page, box and workspace from this computer.</p>
      <button class="btn small" data-act="wipe">Delete everything</button>
    </section>`;
  document.getElementById('paused')!.addEventListener('change', (e) => saveSettings({ paused: (e.target as HTMLInputElement).checked }));
  document.getElementById('updates')!.addEventListener('change', (e) => saveSettings({ checkUpdates: (e.target as HTMLInputElement).checked }));
  document.getElementById('stale')!.addEventListener('change', (e) => {
    const staleDays = Math.max(1, Number((e.target as HTMLInputElement).value) || 3);
    saveSettings({ staleDays });
  });
  document.getElementById('backup-file')!.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const pass = await ask('Restore backup', 'Passphrase');
    if (!pass) return;
    try {
      const n = await restoreBackup(file, pass);
      await call('reindex');
      toast(`Restored ${plural(n, 'page')}.`);
      render();
    } catch (err) {
      toast((err as Error).message);
    }
  });
}

/* ---- Actions ---- */

const actions: Record<string, (el: HTMLElement) => unknown> = {
  'put-window': async () => afterPutAway(await call('putAway', { scope: 'window', windowId: await win() })),
  'put-stale': async () => afterPutAway(await call('putAway', { scope: 'stale' })),
  'close-dupes': async () => {
    toast(`Closed ${plural(await call('closeDuplicates'), 'duplicate')}.`);
    render();
  },
  'put-group': async (el) => {
    const g = groupCache[Number(el.dataset.group)];
    afterPutAway(await call('putAway', { scope: 'tabs', tabIds: g.tabIds, name: g.name }));
  },
  'group-browser': async (el) => {
    const g = groupCache[Number(el.dataset.group)];
    await call('groupInBrowser', { tabIds: g.tabIds, name: g.name });
    toast(`Grouped ${plural(g.tabIds.length, 'tab')} in your tab bar.`);
  },
  'open-box': async (el) => {
    const s = await db.get<Session>('sessions', el.dataset.id!);
    if (s) showBox(s);
  },
  unpack: async (el) => {
    dialog.close();
    await call('restore', { id: el.dataset.id! });
    render();
  },
  'unpack-remove': async (el) => {
    dialog.close();
    await call('restore', { id: el.dataset.id!, deleteAfter: true });
    render();
  },
  'rename-box': async (el) => {
    const s = await db.get<Session>('sessions', el.dataset.id!);
    if (!s) return;
    const name = await ask('Rename box', 'Name', s.name);
    if (name) await db.put('sessions', { ...s, name });
    render();
  },
  'delete-box': async (el) => {
    const s = await db.get<Session>('sessions', el.dataset.id!);
    if (!s) return;
    dialog.close();
    await db.remove('sessions', s.id);
    await render();
    toast(`Deleted “${s.name}”.`, async () => {
      await db.put('sessions', s);
      render();
    });
  },
  'close-dialog': () => dialog.close(),
  'switch-ws': async (el) => {
    await call('switchWorkspace', { id: el.dataset.id!, windowId: await win() });
    render();
  },
  'new-ws': async () => {
    const name = await ask('New workspace', 'Name');
    if (!name) return;
    await call('createWorkspace', { name, windowId: await win() });
    render();
  },
  filter: (el) => {
    libraryFilter = el.dataset.key as typeof libraryFilter;
    render();
  },
  'read-mode': (el) => renderReader(currentReadUrl(), el.dataset.mode as 'copy' | 'diff'),
  'forget-page': async () => {
    await db.deletePage(currentReadUrl());
    await call('reindex');
    location.hash = '#library';
  },
  'export-md': exportMarkdown,
  'save-blocked': async () => {
    const raw = (document.getElementById('blocked') as HTMLTextAreaElement).value;
    await saveSettings({ blockedDomains: raw.split('\n').map((d) => d.trim().toLowerCase()).filter(Boolean) });
    toast('Saved.');
  },
  'import-history': async () => toast(`Added ${plural(await call('importHistory'), 'page')} from your history.`),
  reindex: async () => {
    await call('reindex');
    toast('Rebuilding your search index.');
  },
  backup: async () => {
    const pass = await ask('Create backup', 'Choose a passphrase');
    if (!pass) return;
    download(`putaway-${new Date().toISOString().slice(0, 10)}.putaway`, await createBackup(pass), 'application/octet-stream');
  },
  'restore-backup': () => document.getElementById('backup-file')!.click(),
  wipe: async () => {
    const typed = await ask('Delete everything?', 'Type DELETE to confirm');
    if (typed !== 'DELETE') return;
    await db.clearAll();
    await chrome.storage.local.remove('activeWorkspaceId');
    await call('reindex');
    toast('Everything is gone.');
    render();
  },
};

const currentReadUrl = () => decodeURIComponent(location.hash.slice('#read/'.length));

document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  e.preventDefault();
  const button = el as HTMLButtonElement;
  button.disabled = true;
  try {
    await actions[el.dataset.act!]?.(el);
  } catch (err) {
    toast((err as Error).message);
  } finally {
    button.disabled = false;
  }
});

/* ---- Router ---- */

async function render() {
  const hash = location.hash.slice(1) || 'shelf';
  const view = hash.split('/')[0];
  document.querySelectorAll('nav a').forEach((a) => {
    const on = (a as HTMLElement).dataset.view === view;
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
  if (view === 'library') await renderLibrary();
  else if (view === 'recap') await renderRecap();
  else if (view === 'settings') await renderSettings();
  else if (view === 'read') await renderReader(currentReadUrl());
  else await renderShelf();

  const update = (await chrome.storage.local.get('update')).update as { tag: string; url: string } | null | undefined;
  document.getElementById('update')!.innerHTML = update
    ? `<div class="banner">Putaway ${esc(update.tag)} is out. <a href="${safeHref(update.url)}" target="_blank" rel="noopener">Get the update</a></div>`
    : '';
}

addEventListener('hashchange', render);
render();
