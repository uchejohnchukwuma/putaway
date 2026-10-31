const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Page titles and text are untrusted. Everything interpolated goes through this. */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** Only web links can reach an href, which rules out javascript: URLs in saved data. */
export const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? esc(url) : '#');

/** Served by the browser from its own cache, so viewing a shelf contacts no site. */
export const favicon = (url: string) =>
  `<img class="favicon" alt="" src="/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32" />`;

export function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  const days = Math.floor(s / 86400);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function duration(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function download(name: string, content: BlobPart, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
