import { call } from '../shared/rpc';

const root = document.getElementById('popup')!;

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  const [status, overview] = await Promise.all([call('pageStatus', { tabId: tab.id!, url }), call('overview')]);
  const inWindow = overview.tabs.filter((t) => t.windowId === tab.windowId).length;
  const home = (hash: string) => `${chrome.runtime.getURL('newtab.html')}${hash}`;
  const read = (hash = '') => home(`#read/${encodeURIComponent(status.page?.url ?? '')}${hash}`);

  const notes: string[] = [];
  if (status.gone && status.page?.text) {
    notes.push(`<div class="note alert" id="gone">This page is gone, but you have a copy. <a href="${read()}" target="_blank">Read saved copy</a></div>`);
  }
  if (status.page?.changedAt) {
    notes.push(`<div class="note" id="changed">This page changed since your last visit. <a href="${read()}" target="_blank">See what changed</a></div>`);
  }
  if (status.blocked) notes.push('<div class="note">Putaway never saves this page.</div>');
  else if (status.paused) notes.push('<div class="note">Saving is paused.</div>');

  root.innerHTML = `
    <h1>Putaway</h1>
    ${notes.join('')}
    <button class="btn hot" id="window">Put away this window (${inWindow})</button>
    <button class="btn" id="tab">Put away this tab</button>
    <div class="popup-foot"><a href="${home('#shelf')}" target="_blank">Open the shelf</a><span class="soft">${overview.total} open</span></div>`;

  const finish = () => window.close();
  document.getElementById('window')!.addEventListener('click', async () => {
    await call('putAway', { scope: 'window', windowId: tab.windowId });
    finish();
  });
  document.getElementById('tab')!.addEventListener('click', async () => {
    await call('putAway', { scope: 'tabs', tabIds: [tab.id!], name: tab.title });
    finish();
  });
}

main().catch((e) => (root.textContent = String(e)));
