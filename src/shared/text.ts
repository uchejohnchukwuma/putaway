const TRACKING = /^(utm_.+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|mc_[ce]id|igshid|ref_src|ref_url|_hsenc|_hsmi|yclid|spm|si)$/i;
const SECRET = /^(token|access_token|id_token|auth|authuser|session|sessionid|sid|code|state|key|apikey|api_key|password|pwd|sig|signature|otp)$/i;

/** Canonical key for a page: drops tracking and secret params and plain anchors. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING.test(k) || SECRET.test(k)) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  // Hash routes are real pages. Anchors and tokens in the fragment are not.
  if (!u.hash.startsWith('#/') && !u.hash.startsWith('#!')) u.hash = '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function hashText(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0xcc9e2d51);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** Groups sentences into passages of about `words` words, capped at `max` passages. */
export function chunkText(text: string, words = 110, max = 24): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let n = 0;
  for (const s of sentences(text)) {
    const w = s.split(' ').length;
    if (n + w > words && cur.length) {
      out.push(cur.join(' '));
      if (out.length >= max) return out;
      cur = [];
      n = 0;
    }
    if (w > words * 2) {
      const parts = s.split(' ');
      for (let i = 0; i < parts.length && out.length < max; i += words) {
        out.push(parts.slice(i, i + words).join(' '));
      }
      if (out.length >= max) return out;
      continue;
    }
    cur.push(s);
    n += w;
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

const STOP = new Set(
  'a an and are as at be by for from has have how i in is it its of on or that the this to was were what when where which who why will with you your my me we our that those these about into over can do does did not no yes vs via new home page official site welcome'.split(' '),
);

export const tokens = (s: string) =>
  (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter((t) => !STOP.has(t));

/** Short human name for a set of titles, from the words they share most. */
export function nameFor(titles: string[], fallback = 'Put away'): string {
  const freq = new Map<string, number>();
  for (const t of titles) {
    for (const w of new Set(tokens(t))) {
      if (w.length > 2 && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const lead = tokens(titles[0] ?? '');
  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 2)
    .map(([w]) => w)
    // Keep the words in the order a title uses them.
    .sort((a, b) => lead.indexOf(a) - lead.indexOf(b))
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return top.length ? top.join(' ') : fallback;
}

/**
 * Sentence-level comparison between two saved copies. Returns what was added and
 * removed, plus how much of the page stayed the same (0 to 1).
 */
export function diffText(before: string, after: string) {
  const a = sentences(before);
  const b = sentences(after);
  const inA = new Set(a);
  const inB = new Set(b);
  const added = b.filter((s) => !inA.has(s));
  const removed = a.filter((s) => !inB.has(s));
  const kept = b.length - added.length;
  const similarity = kept / Math.max(a.length, b.length, 1);
  return { added, removed, similarity };
}

/**
 * True when a new copy is the same page with real edits. A rotating feed shares
 * almost nothing with its last copy, so it does not count.
 */
export function isMeaningfulChange(before: string, after: string): boolean {
  if (!before || !after || before === after) return false;
  const { added, removed, similarity } = diffText(before, after);
  return (added.length > 0 || removed.length > 0) && similarity >= 0.4;
}

/** Builds a `#:~:text=` link that scrolls to and highlights a passage. */
export function fragmentLink(url: string, sentence?: string): string {
  if (!sentence) return url;
  const words = sentence.trim().split(/\s+/);
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D');
  const text =
    words.length <= 10
      ? enc(words.join(' '))
      : `${enc(words.slice(0, 5).join(' '))},${enc(words.slice(-5).join(' '))}`;
  return `${url.split('#')[0]}#:~:text=${text}`;
}

const DAY = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Pulls time words out of a query and returns the rest with a date window. */
export function parseTime(query: string, now = Date.now()) {
  let q = ` ${query.toLowerCase()} `;
  const today = startOfDay(now);
  let from: number | undefined;
  let to: number | undefined;
  const take = (re: RegExp) => {
    if (!re.test(q)) return false;
    q = q.replace(re, ' ');
    return true;
  };
  const prefix = '(?:\\s(?:from|on|in|during|since))?';
  if (take(new RegExp(`${prefix}\\s(today|this morning|this afternoon|tonight)\\s`))) from = today;
  else if (take(new RegExp(`${prefix}\\syesterday\\s`))) [from, to] = [today - DAY, today];
  else if (take(new RegExp(`${prefix}\\slast week\\s`))) [from, to] = [today - 14 * DAY, today - 6 * DAY];
  else if (take(new RegExp(`${prefix}\\sthis week\\s`))) from = today - 7 * DAY;
  else if (take(new RegExp(`${prefix}\\slast month\\s`))) [from, to] = [today - 60 * DAY, today - 28 * DAY];
  else if (take(new RegExp(`${prefix}\\sthis month\\s`))) from = today - 30 * DAY;
  else {
    const m = q.match(new RegExp(`${prefix}\\s(?:last\\s)?(${WEEKDAYS.join('|')})\\s`));
    if (m) {
      q = q.replace(m[0], ' ');
      const back = (new Date(now).getDay() - WEEKDAYS.indexOf(m[1]) + 7) % 7 || 7;
      from = today - back * DAY;
      to = from + DAY;
    }
  }
  return { query: q.replace(/\s+/g, ' ').trim(), from, to };
}
