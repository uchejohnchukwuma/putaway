import { describe, expect, it } from 'vitest';
import { chunkText, diffText, fragmentLink, isMeaningfulChange, nameFor, normalizeUrl, parseTime } from '../../src/shared/text';
import { isBlocked } from '../../src/shared/privacy';

describe('normalizeUrl', () => {
  it('drops tracking and secrets, keeps real params', () => {
    expect(normalizeUrl('https://a.com/p/?utm_source=x&id=7&token=abc#top')).toBe('https://a.com/p?id=7');
  });
  it('keeps hash routes', () => {
    expect(normalizeUrl('https://a.com/#/inbox/1')).toBe('https://a.com/#/inbox/1');
  });
});

describe('isBlocked', () => {
  it.each([
    'https://www.chase.com/x', 'https://mail.google.com/mail/u/0', 'https://login.example.com/', 'https://shop.com/checkout',
    'https://shop.com/account/security', 'http://localhost:3000/', 'http://192.168.1.4/', 'https://myloans.bank.example.org/',
    'chrome://settings', 'not a url',
  ])('blocks %s', (u) => expect(isBlocked(u)).toBe(true));
  it.each(['https://en.wikipedia.org/wiki/Heat_pump', 'https://news.ycombinator.com/', 'https://bankruptcy-law.example.com/guide', 'https://example.com/blog/how-to-login-faster'])(
    'allows %s', (u) => expect(isBlocked(u)).toBe(false));
  it('honours user domains and subdomains', () => {
    expect(isBlocked('https://a.corp-tool.com/', ['corp-tool.com'])).toBe(true);
  });
});

describe('chunkText', () => {
  it('splits long text and caps passages', () => {
    const text = Array.from({ length: 600 }, (_, i) => `Sentence number ${i} has a few plain words in it.`).join(' ');
    const out = chunkText(text);
    expect(out.length).toBe(24);
    expect(out[0].split(' ').length).toBeLessThanOrEqual(110);
  });
  it('breaks up a wall of text with no punctuation', () => {
    expect(chunkText(Array(1000).fill('word').join(' ')).length).toBeGreaterThan(5);
  });
});

describe('change detection', () => {
  const base = 'The plan costs ten dollars. It includes support. Cancel any time. Refunds take five days. Shipping is free.';
  it('flags an edit', () => {
    expect(isMeaningfulChange(base, base.replace('ten dollars', 'twelve dollars'))).toBe(true);
    expect(diffText(base, base.replace('ten dollars', 'twelve dollars')).added).toEqual(['The plan costs twelve dollars.']);
  });
  it('ignores a page that became something else', () => {
    expect(isMeaningfulChange(base, 'Totally new. Feed items only. Nothing shared here. Another story. One more.')).toBe(false);
  });
  it('ignores identical copies', () => expect(isMeaningfulChange(base, base)).toBe(false));
});

describe('parseTime', () => {
  const wed = new Date(2026, 9, 28, 15).getTime();
  it('reads weekdays as the most recent one', () => {
    const r = parseTime('pricing article from tuesday', wed);
    expect(r.query).toBe('pricing article');
    expect(new Date(r.from!).getDate()).toBe(27);
  });
  it('treats the current weekday as a week back', () => {
    expect(new Date(parseTime('wednesday notes', wed).from!).getDate()).toBe(21);
  });
  it('leaves plain queries alone', () => expect(parseTime('heat pumps', wed)).toEqual({ query: 'heat pumps', from: undefined, to: undefined }));
  it('handles yesterday and last week', () => {
    expect(parseTime('yesterday', wed).query).toBe('');
    expect(parseTime('docs last week', wed).to).toBeDefined();
  });
});

describe('labels and links', () => {
  it('names a group from shared words', () => {
    expect(nameFor(['Furnace install guide', 'Best furnace 2026', 'Furnace repair'])).toMatch(/^Furnace/);
  });
  it('encodes hyphens in text fragments', () => {
    expect(fragmentLink('https://a.com/x#old', 'A well-known fact')).toBe('https://a.com/x#:~:text=A%20well%2Dknown%20fact');
  });
  it('uses a range for long sentences', () => {
    expect(fragmentLink('https://a.com', 'one two three four five six seven eight nine ten eleven twelve')).toContain(',');
  });
});
