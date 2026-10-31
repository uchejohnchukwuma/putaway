import { Readability } from '@mozilla/readability';

const DWELL_TO_SAVE_MS = 15_000;
const TICK_MS = 5_000;
const MAX_TEXT = 200_000;

declare global {
  interface Window {
    __putawayLoaded?: string;
  }
}

const hasSensitiveFields = () =>
  !!document.querySelector(
    'input[type=password], input[autocomplete^="cc-"], input[autocomplete="one-time-code"], input[name*="card" i][name*="number" i]',
  );

/** textContent runs paragraphs together, which would merge their sentences. */
function blockText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr, div').forEach((el) => el.append('\n'));
  return doc.body.textContent?.trim() ?? '';
}

function extract(): string {
  let text = '';
  try {
    const article = new Readability(document.cloneNode(true) as Document).parse();
    if (article?.content) text = blockText(article.content);
  } catch {
    // Readability gives up on some pages. The body text below covers them.
  }
  if (text.length < 200) text = document.body?.innerText?.trim() ?? text;
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT);
}

function capture(): boolean {
  if (hasSensitiveFields()) return false;
  const text = extract();
  if (text.length < 40) return false;
  send({ kind: 'capture', page: { url: location.href, title: document.title, text } });
  return true;
}

function send(message: unknown) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // The extension was reloaded and this script is orphaned.
  }
}

function run() {
  // Keyed by version so a script left behind by an update can be replaced.
  const version = chrome.runtime.getManifest().version;
  if (window.top !== window || window.__putawayLoaded === version) return;
  window.__putawayLoaded = version;

  let url = location.href;
  let dwell = 0;
  let unreported = 0;
  let saved = false;

  const flush = () => {
    if (unreported) send({ kind: 'dwell', url, title: document.title, ms: unreported });
    unreported = 0;
  };

  setInterval(() => {
    if (location.href !== url) {
      flush();
      url = location.href;
      dwell = 0;
      saved = false;
    }
    if (document.visibilityState !== 'visible') return;
    dwell += TICK_MS;
    unreported += TICK_MS;
    if (unreported >= 30_000) flush();
    if (!saved && dwell >= DWELL_TO_SAVE_MS) saved = capture();
  }, TICK_MS);

  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.kind === 'capture-now') {
      reply({ saved: capture() });
      saved = true;
    }
  });
}

run();
