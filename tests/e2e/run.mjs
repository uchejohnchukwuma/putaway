// Loads the built extension in real Chromium and drives every feature.
// Usage: node tests/e2e/run.mjs [path-to-unpacked-extension]
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const extPath = resolve(process.argv[2] ?? 'dist');
const shots = 'tests/e2e/.artifacts';
await mkdir(shots, { recursive: true });

/* ---- Fixture site, also acting as the browser's proxy so all traffic is visible ---- */

const filler = (topic, n) => Array.from({ length: n }, (_, i) => `<p>${topic} background note ${i} covers ordinary context that nobody searches for, and it keeps going so the page is long enough to scroll.</p>`).join('');
const article = (title, body, extra = '') => `<!doctype html><title>${title}</title><body><article><h1>${title}</h1>${filler(title, 30)}${body}${filler(title, 12)}</article>${extra}</body>`;

const site = new Map(Object.entries({
  '/heat': article('Residential HVAC field notes', '<p>Air-source units move warmth from outdoors into a house, and they keep working in deep winter when the coil is sized correctly.</p>'),
  '/bread': article('Weekend kitchen journal', '<p>A long cold rise in the fridge gives sourdough loaves an open crumb and a tangy flavour after two days.</p>'),
  '/visa': article('Moving abroad checklist', '<p>Skilled workers must file their permanent residence application within ninety days of the invitation or it expires.</p>'),
  '/rates': article('Team plan details', '<p>The team plan costs ten dollars per seat each month.</p><p>Support replies within one business day.</p>'),
  '/feed': article('Daily feed', '<p>Story one about the morning.</p><p>Story two about the markets.</p>'),
  '/doomed': article('Warranty terms archive', '<p>Compressors carry a ten year limited warranty when registered within sixty days of install.</p>'),
  '/login': article('Sign in please', '<p>Sensitive account page text that must never be saved.</p>'),
  '/secret-form': article('Profile editor', '<p>A perfectly normal looking page body with plenty of words that has a password box in it, so it must not be saved.</p>', '<input type="password" />'),
  '/xss': article('<img src=x onerror=window.pwned=1>', '<p>Hostile title test page with enough body text to be captured by the extension as usual.</p>').replace('<title><img', '<title>&lt;img').replace('onerror=window.pwned=1></title>', 'onerror=window.pwned=1&gt;</title>'),
  '/stay': article('Dwell timing page', '<p>This page gets saved only because the visitor stayed long enough on it.</p>'),
}));
for (let i = 1; i <= 3; i++) site.set(`/furnace${i}`, article(`Furnace buying guide part ${i}`, '<p>Compare heating efficiency ratings before you buy a gas furnace.</p>'));
for (let i = 1; i <= 2; i++) site.set(`/pasta${i}`, article(`Fresh pasta recipes ${i}`, '<p>Roll the dough thin and cook the noodles for two minutes in salted water.</p>'));

const tunnels = new Set();
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const status = gone.has(path) ? 404 : site.has(path) ? 200 : 404;
  res.writeHead(status, { 'content-type': 'text/html' });
  res.end(status === 200 ? site.get(path) : '<!doctype html><title>Not found</title><body>404 page not found, nothing here at all, sorry about that.</body>');
});
server.on('connect', (req, socket) => {
  tunnels.add(req.url.split(':')[0]);
  socket.destroy();
});
const gone = new Set();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = (path) => `http://articles.test${path}`;

/* ---- Harness ---- */

const profile = await mkdtemp(join(tmpdir(), 'putaway-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: process.env.E2E_CHANNEL ?? 'chromium',
  headless: true,
  viewport: { width: 1320, height: 900 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, `--proxy-server=http://127.0.0.1:${port}`, '--disable-background-networking'],
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extId = new URL(worker.url()).host;
const errors = [];
const results = [];
context.on('weberror', (e) => errors.push(String(e.error())));

async function test(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`PASS ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n').slice(0, 4).join('\n     ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${msg}`);
    await sleep(200);
  }
}

const ext = await context.newPage();
await ext.goto(`chrome-extension://${extId}/newtab.html`);
ext.on('console', (m) => m.type() === 'error' && !/404|ERR_/.test(m.text()) && errors.push(m.text()));

const rpc = (method, args) => ext.evaluate(([m, a]) => chrome.runtime.sendMessage({ to: 'bg', method: m, args: a }), [method, args]).then((r) => {
  if (r?.error) throw new Error(r.error);
  return r?.value;
});
const idb = (store, key) => ext.evaluate(([s, k]) => new Promise((res, rej) => {
  const o = indexedDB.open('putaway');
  o.onsuccess = () => {
    const os = o.result.transaction(s).objectStore(s);
    const r = k === undefined ? os.getAll() : os.get(k);
    r.onsuccess = () => {
      const v = r.result;
      o.result.close();
      res(Array.isArray(v) ? v.map(({ vector, ...x }) => x) : v);
    };
    r.onerror = () => rej(r.error);
  };
}), [store, key]);
const tabIdOf = (u) => ext.evaluate((x) => chrome.tabs.query({}).then((t) => t.find((y) => y.url === x)?.id), u);
const force = (u) => ext.evaluate(async (x) => {
  const id = (await chrome.tabs.query({})).find((t) => t.url === x)?.id;
  return chrome.tabs.sendMessage(id, { kind: 'capture-now' });
}, u);

async function open(path) {
  const p = await context.newPage();
  await p.goto(url(path), { waitUntil: 'load' });
  await until(() => p.evaluate(() => document.readyState === 'complete'), 'load');
  await sleep(150);
  return p;
}
async function save(path) {
  const p = await open(path);
  await until(() => force(url(path)).catch(() => null), `capture ${path}`, 10_000);
  await until(async () => (await idb('pages', url(path)))?.text, `saved ${path}`, 10_000);
  return p;
}
const indexed = (...paths) => until(async () => {
  const rows = await Promise.all(paths.map((p) => idb('pages', url(p))));
  return rows.every((r) => r?.indexed === 1);
}, `indexed ${paths}`, 120_000);
const search = (query) => rpc('search', { query });
const closeWeb = () => context.pages().filter((p) => p !== ext).forEach((p) => p.close().catch(() => {}));

/* ---- Scenarios ---- */

await test('model runs on device and meaning-based search finds paraphrases', async () => {
  const pages = [await save('/heat'), await save('/bread'), await save('/visa')];
  await indexed('/heat', '/bread', '/visa');
  const cases = [
    ['do heat pumps work when it is freezing outside', '/heat'],
    ['heating the house in january', '/heat'],
    ['bread recipe', '/bread'],
    ['visa expiry', '/visa'],
    ['deadline for my immigration paperwork', '/visa'],
    ['slow fermentation in the refrigerator', '/bread'],
  ];
  for (const [q, want] of cases) {
    const hits = await search(q);
    assert(hits[0]?.url === url(want), `"${q}" returned ${hits[0]?.url}`);
  }
  for (const q of ['quantum chromodynamics lattice gauge', 'best running shoes for flat feet']) {
    assert((await search(q)).length === 0, `unrelated query "${q}" returned results`);
  }
  await Promise.all(pages.map((p) => p.close()));
});

await test('keyword search finds exact terms and time words filter results', async () => {
  assert((await search('sourdough'))[0]?.url === url('/bread'), 'keyword');
  assert((await search('sourdough today')).length > 0, 'today keeps results');
  assert((await search('sourdough last month')).length === 0, 'last month excludes');
});

await test('search result jumps to the passage on the real page', async () => {
  const [hit] = await search('do heat pumps work when it is freezing outside');
  assert(hit.sentence, 'no sentence');
  await ext.bringToFront();
  await ext.fill('#q', 'do heat pumps work when it is freezing outside');
  const link = ext.locator('.result a.title').first();
  await link.waitFor();
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await tab.waitForLoadState();
  await until(() => tab.evaluate(() => scrollY > 300), 'page did not scroll to the passage', 5000);
  await tab.close();
  await ext.fill('#q', '');
});

await test('private pages are never saved', async () => {
  const a = await open('/login');
  const b = await open('/secret-form');
  await force(url('/login')).catch(() => {});
  await force(url('/secret-form')).catch(() => {});
  await sleep(500);
  assert(!(await idb('pages', url('/login'))), 'login page saved');
  assert(!(await idb('pages', url('/secret-form'))), 'password page saved');
  await a.close();
  await b.close();
});

await test('a page saves itself after 15 seconds of attention', async () => {
  const p = await open('/stay');
  await p.bringToFront();
  await until(() => idb('pages', url('/stay')), 'not saved by dwell', 30_000);
  await p.close();
  await ext.bringToFront();
});

await test('put away closes tabs, keeps them, and undo-style restore brings them back grouped', async () => {
  const a = await open('/furnace1');
  const b = await open('/furnace2');
  await sleep(300);
  const ids = [await tabIdOf(url('/furnace1')), await tabIdOf(url('/furnace2'))];
  const session = await rpc('putAway', { scope: 'tabs', tabIds: ids });
  assert(session?.tabs.length === 2, 'session not saved');
  assert(/Furnace/i.test(session.name), `bad name ${session.name}`);
  assert(a.isClosed() && b.isClosed(), 'tabs still open');
  assert((await idb('pages', url('/furnace1')))?.text, 'tab text not saved on the way out');
  const opened = Promise.all([context.waitForEvent('page'), context.waitForEvent('page')]);
  await rpc('restore', { id: session.id, deleteAfter: true });
  await opened;
  const tabs = await ext.evaluate((x) => chrome.tabs.query({ url: x }), 'http://articles.test/furnace*');
  assert(tabs.length === 2, `restored ${tabs.length}`);
  assert(tabs.every((t) => t.groupId !== -1), 'not grouped');
  assert(!(await idb('sessions', session.id)), 'box should be gone');
  closeWeb();
});

await test('putting away a whole window leaves the window open', async () => {
  const win = await ext.evaluate(() => chrome.windows.create({ url: 'http://articles.test/pasta1', focused: true }).then((w) => w.id));
  await sleep(600);
  const s = await rpc('putAway', { scope: 'window', windowId: win });
  assert(s?.tabs.length === 1, 'no session');
  const left = await ext.evaluate((id) => chrome.tabs.query({ windowId: id }), win);
  assert(left.length === 1, `window has ${left.length} tabs`);
  await ext.evaluate((id) => chrome.windows.remove(id), win);
  await ext.bringToFront();
});

await test('duplicates, stale tabs and task grouping', async () => {
  closeWeb();
  const open1 = await open('/furnace1');
  await open('/furnace2');
  await open('/pasta1');
  await open('/pasta2');
  await open('/furnace1');
  await sleep(200);
  const o = await rpc('overview');
  assert(o.duplicates.length === 1, `dupes ${o.duplicates.length}`);
  const groups = await rpc('suggestGroups');
  assert(groups.length >= 1, 'no groups');
  await context.pages().length;
  assert((await rpc('closeDuplicates')) === 1, 'dupes not closed');
  assert((await rpc('overview')).total === o.total - 1, 'count wrong');
  await ext.evaluate(() => chrome.storage.local.set({ settings: { staleDays: 0 } }));
  await sleep(50);
  const again = await rpc('overview');
  assert(again.stale.length > 0, 'stale not detected');
  await ext.evaluate(() => chrome.storage.local.remove('settings'));
  void open1;
  closeWeb();
});

await test('search still finds what was inside a put-away tab', async () => {
  await indexed('/furnace1');
  const hits = await search('efficiency ratings for a gas furnace');
  assert(hits.some((h) => h.url.includes('/furnace')), 'not found');
});

await test('workspaces swap tab sets and bring them back', async () => {
  await sleep(300);
  await open('/bread');
  await sleep(300);
  await ext.bringToFront();
  const win = await ext.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
  const ws = await rpc('createWorkspace', { name: 'Trip', windowId: win });
  const urls = () => ext.evaluate(() => chrome.tabs.query({}).then((t) => t.map((x) => x.url)));
  await until(async () => !(await urls()).includes(url('/bread')), 'old tab not closed', 5000);
  await open('/visa');
  await sleep(200);
  const all = await ext.evaluate(() => new Promise((res) => {
    const o = indexedDB.open('putaway');
    o.onsuccess = () => {
      const r = o.result.transaction('workspaces').objectStore('workspaces').getAll();
      r.onsuccess = () => res(r.result);
    };
  }));
  const main = all.find((w) => w.id !== ws.id);
  assert(main.tabs.some((t) => t.url === url('/bread')), 'outgoing tabs not saved');
  await rpc('switchWorkspace', { id: main.id, windowId: win });
  await until(async () => (await urls()).includes(url('/bread')) && !(await urls()).includes(url('/visa')), 'swap back failed', 5000);
  closeWeb();
});

await test('What changed: real edits are flagged, rotating feeds are not', async () => {
  let p = await save('/rates');
  await p.close();
  site.set('/rates', site.get('/rates').replace('ten dollars', 'fifteen dollars'));
  p = await open('/rates');
  await until(() => force(url('/rates')).catch(() => null), 'capture', 10_000);
  const page = await until(async () => {
    const r = await idb('pages', url('/rates'));
    return r?.changedAt ? r : null;
  }, 'change not flagged', 10_000);
  assert(page.previousText.includes('ten dollars'), 'old text lost');
  const tabId = await tabIdOf(url('/rates'));
  assert((await rpc('pageStatus', { tabId, url: url('/rates') })).page?.changedAt, 'status');
  await ext.goto(`chrome-extension://${extId}/newtab.html#read/${encodeURIComponent(url('/rates'))}`);
  await ext.getByRole('button', { name: 'What changed' }).click();
  await ext.locator('.diff-added', { hasText: 'fifteen dollars' }).waitFor();
  await ext.locator('.diff-removed', { hasText: 'ten dollars' }).waitFor();
  await p.close();

  p = await save('/feed');
  await p.close();
  const fresh = Array.from({ length: 60 }, (_, i) => `<p>Completely different headline number ${i} for today.</p>`).join('');
  site.set('/feed', `<!doctype html><title>Daily feed</title><body><article>${fresh}</article></body>`);
  p = await open('/feed');
  await until(() => force(url('/feed')).catch(() => null), 'capture', 10_000);
  await until(async () => (await idb('pages', url('/feed')))?.text.includes('headline number 5'), 'feed saved', 10_000);
  assert(!(await idb('pages', url('/feed'))).changedAt, 'feed flagged as changed');
  await p.close();
});

await test('page rescue: a deleted page keeps its saved copy', async () => {
  let p = await save('/doomed');
  await p.close();
  gone.add('/doomed');
  p = await context.newPage();
  await p.goto(url('/doomed'));
  await sleep(500);
  const tabId = await tabIdOf(url('/doomed'));
  const status = await until(async () => {
    const s = await rpc('pageStatus', { tabId, url: url('/doomed') });
    return s.gone ? s : null;
  }, 'gone not detected', 5000);
  assert(status.page?.text.includes('ten year limited warranty'), 'copy missing');
  await ext.evaluate((id) => chrome.tabs.sendMessage(id, { kind: 'capture-now' }).catch(() => {}), tabId);
  await sleep(500);
  const saved = await idb('pages', url('/doomed'));
  assert(saved.text.includes('ten year limited warranty'), '404 replaced the good copy');
  await until(async () => (await ext.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)) === '!', 'badge not shown', 3000);
  await p.close();
});

await test('hostile page titles render as plain text', async () => {
  const p = await save('/xss');
  await p.close();
  await ext.goto(`chrome-extension://${extId}/newtab.html#library`);
  await ext.reload();
  await ext.locator('.result a.title').first().waitFor();
  assert((await ext.locator('.result a.title img[src="x"]').count()) === 0, 'title injected markup');
  assert(!(await ext.evaluate(() => window.pwned)), 'script ran');
});

await test('recap counts reading time and exports Markdown', async () => {
  const p = await open('/stay');
  await p.bringToFront();
  await until(async () => (await idb('days')).length >= 1, 'no dwell rows', 10_000).catch(async () => {
    await p.close();
    await sleep(500);
    await until(async () => (await idb('days')).length >= 1, 'no dwell rows after close', 5000);
  });
  if (!p.isClosed()) await p.close();
  await ext.goto(`chrome-extension://${extId}/newtab.html#recap`);
  await ext.reload();
  await ext.locator('.bar').first().waitFor();
  const [dl] = await Promise.all([ext.waitForEvent('download'), ext.getByRole('button', { name: 'Export as Markdown' }).click()]);
  const text = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
  assert(text.startsWith('# Putaway recap'), 'bad export');
});

await test('encrypted backup round-trips and rejects the wrong passphrase', async () => {
  await ext.goto(`chrome-extension://${extId}/newtab.html#settings`);
  await ext.reload();
  await ext.getByRole('button', { name: 'Create backup' }).click();
  await ext.fill('#ask', 'correct horse');
  const [dl] = await Promise.all([ext.waitForEvent('download'), ext.locator('#ask-form button[type=submit]').click()]);
  const file = await dl.path();
  const before = (await idb('pages')).length;
  const raw = await (await import('node:fs/promises')).readFile(file);
  assert(!raw.includes('warranty'), 'backup is readable');
  await ext.setInputFiles('#backup-file', { name: 'x.putaway', mimeType: 'application/octet-stream', buffer: raw });
  await ext.fill('#ask', 'wrong');
  await ext.locator('#ask-form button[type=submit]').click();
  await ext.locator('#toast', { hasText: 'Wrong passphrase' }).waitFor();
  await ext.setInputFiles('#backup-file', []);
  await ext.setInputFiles('#backup-file', { name: 'x.putaway', mimeType: 'application/octet-stream', buffer: raw });
  await ext.fill('#ask', 'correct horse');
  await ext.locator('#ask-form button[type=submit]').click();
  await ext.locator('#toast', { hasText: 'Restored' }).waitFor();
  assert((await idb('pages')).length === before, 'page count changed');
});

await test('new tab page: shelf, box dialog and screenshots', async () => {
  await open('/furnace1');
  await open('/furnace2');
  await open('/pasta1');
  await sleep(300);
  await ext.goto(`chrome-extension://${extId}/newtab.html#shelf`);
  await ext.reload();
  await ext.bringToFront();
  await ext.locator('.box').first().waitFor();
  await ext.locator('#groups .sheet, #groups p').first().waitFor();
  await until(() => ext.evaluate(() => !document.getElementById('groups').textContent.includes('Sorting')), 'groups', 15_000);
  await sleep(700);
  await ext.screenshot({ path: `${shots}/shelf.png` });
  await ext.locator('.box').first().click();
  await ext.locator('dialog[open] h2').waitFor();
  await ext.screenshot({ path: `${shots}/box.png` });
  await ext.getByRole('button', { name: 'Close', exact: true }).click();
  await ext.setViewportSize({ width: 390, height: 800 });
  const wide = await ext.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await ext.setViewportSize({ width: 1320, height: 900 });
  assert(!wide, 'horizontal scroll at phone width');
  await ext.emulateMedia({ colorScheme: 'dark' });
  await sleep(150);
  await ext.screenshot({ path: `${shots}/shelf-dark.png` });
  await ext.emulateMedia({ colorScheme: 'light' });
  const pop = await context.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.locator('#window').waitFor();
  await pop.close();
  await ext.fill('#q', 'bread recipe');
  await ext.locator('.result').first().waitFor();
  await ext.screenshot({ path: `${shots}/search.png` });
});

await test('delete everything leaves nothing behind', async () => {
  await ext.goto(`chrome-extension://${extId}/newtab.html#settings`);
  await ext.reload();
  await ext.getByRole('button', { name: 'Delete everything' }).click();
  await ext.fill('#ask', 'DELETE');
  await ext.locator('#ask-form button[type=submit]').click();
  await ext.locator('#toast', { hasText: 'Everything is gone' }).waitFor();
  for (const s of ['pages', 'chunks', 'sessions', 'workspaces', 'days']) {
    assert((await idb(s)).length === 0, `${s} not empty`);
  }
});

await test('nothing leaves the machine except the update check', async () => {
  const bad = [...tunnels].filter((h) => /huggingface|hf\.co|jsdelivr|unpkg|cloudflare|cdnjs/.test(h));
  console.log('     tunnels seen:', [...tunnels].join(', ') || 'none');
  assert(!bad.length, `model or code fetched remotely: ${bad}`);
});

await test('no uncaught page errors', async () => {
  assert(!errors.length, errors.slice(0, 5).join(' | '));
});

await context.close();
server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
