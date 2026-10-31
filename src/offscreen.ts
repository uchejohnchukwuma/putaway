import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import * as db from './shared/db';
import { chunkText, nameFor, parseTime, sentences, tokens } from './shared/text';
import type { Chunk, Page, SearchHit, TabGroupSuggestion } from './shared/types';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const RRF_K = 40;
// Short passages keep one good sentence from being drowned out by its neighbours.
const PASSAGE_WORDS = 45;
// Passages past the embedded limit stay searchable by keyword.
const MAX_EMBEDDED = 64;
const MAX_PASSAGES = 400;
const MIN_SEMANTIC = 0.18;

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = chrome.runtime.getURL('models/');
env.useBrowserCache = false;
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = chrome.runtime.getURL('ort/');
wasm.numThreads = 1;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function model() {
  extractor ??= pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm' }).catch((e) => {
    extractor = undefined;
    throw e;
  }) as Promise<FeatureExtractionPipeline>;
  return extractor;
}

async function embed(text: string): Promise<Float32Array> {
  const run = await model();
  const out = await run(text.slice(0, 1200), { pooling: 'mean', normalize: true });
  return out.data as Float32Array;
}

const quantize = (v: Float32Array) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))));

function dot(a: Int8Array, b: Int8Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / (127 * 127);
}

/* ---- Indexing queue ---- */

let draining = false;
let cache: Chunk[] | undefined;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const batch = await db.pagesToIndex(8);
      if (!batch.length) break;
      for (const page of batch) await indexPage(page);
      cache = undefined;
      // Yield so a search typed during a big import still feels instant.
      await new Promise((r) => setTimeout(r, 10));
    }
  } catch (e) {
    console.warn('Putaway indexing stopped', e);
  } finally {
    draining = false;
  }
}

async function indexPage(page: Page) {
  const heading = `${page.title} ${page.domain}`.trim();
  const parts = page.text ? chunkText(page.text, PASSAGE_WORDS, MAX_PASSAGES) : [];
  const texts = parts.length ? parts : [heading];
  const chunks: Chunk[] = [];
  for (let n = 0; n < texts.length; n++) {
    // The title travels with each passage so "the Rheem page" still finds it.
    const vector = n < MAX_EMBEDDED ? quantize(await embed(`${page.title}. ${texts[n]}`)) : undefined;
    chunks.push({ id: `${page.url}#${n}`, url: page.url, n, text: texts[n], vector });
  }
  await db.saveChunks(page, chunks);
}

/* ---- Search ---- */

async function allChunks() {
  cache ??= await db.getAll<Chunk>('chunks');
  return cache;
}

function rankInto(scores: Map<string, number>, ordered: string[], weight: number) {
  ordered.forEach((url, i) => scores.set(url, (scores.get(url) ?? 0) + weight / (RRF_K + i)));
}

async function bestSentence(chunk: string, query: string, qv: Int8Array | undefined) {
  const list = sentences(chunk).filter((s) => s.split(' ').length >= 4);
  if (!list.length) return undefined;
  if (!qv) {
    const terms = tokens(query);
    return list.map((s) => [s, terms.filter((t) => s.toLowerCase().includes(t)).length] as const)
      .sort((a, b) => b[1] - a[1])[0][0];
  }
  let best = list[0];
  let top = -2;
  for (const s of list.slice(0, 8)) {
    const score = dot(quantize(await embed(s)), qv);
    if (score > top) [best, top] = [s, score];
  }
  return best;
}

async function search(raw: string): Promise<SearchHit[]> {
  const { query, from, to } = parseTime(raw);
  const pages = new Map((await db.getAll<Page>('pages')).map((p) => [p.url, p]));
  const inWindow = (p?: Page) => !!p && (from === undefined || p.lastSeen >= from) && (to === undefined || p.lastSeen < to);

  if (!query) {
    return [...pages.values()].filter(inWindow).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 20)
      .map((p) => ({ url: p.url, title: p.title, domain: p.domain, snippet: p.text.slice(0, 180), lastSeen: p.lastSeen, score: 1, hasCopy: !!p.text }));
  }

  const chunks = (await allChunks()).filter((c) => inWindow(pages.get(c.url)));
  const terms = tokens(query);

  let qv: Int8Array | undefined;
  try {
    qv = quantize(await embed(query));
  } catch (e) {
    console.warn('Putaway is falling back to keyword search', e);
  }

  const bestChunk = new Map<string, { chunk: Chunk; score: number }>();
  if (qv) {
    for (const c of chunks) {
      if (!c.vector) continue;
      const score = dot(c.vector, qv);
      if (score > (bestChunk.get(c.url)?.score ?? -2)) bestChunk.set(c.url, { chunk: c, score });
    }
  }
  const semantic = [...bestChunk.entries()]
    .filter(([, v]) => v.score >= MIN_SEMANTIC)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 50)
    .map(([url]) => url);

  const keywordScore = new Map<string, number>();
  const keywordChunk = new Map<string, { chunk: Chunk; hits: number }>();
  const need = Math.ceil(terms.length / 2);
  for (const c of chunks) {
    const page = pages.get(c.url)!;
    const body = c.text.toLowerCase();
    const head = `${page.title} ${page.domain}`.toLowerCase();
    let hits = 0;
    let score = 0;
    for (const t of terms) {
      const inBody = body.includes(t);
      const inHead = head.includes(t);
      if (inBody || inHead) hits++;
      score += (inHead ? 3 : 0) + (inBody ? 1 : 0);
    }
    if (hits < need || !hits) continue;
    if (score > (keywordScore.get(c.url) ?? 0)) keywordScore.set(c.url, score);
    if (hits > (keywordChunk.get(c.url)?.hits ?? 0)) keywordChunk.set(c.url, { chunk: c, hits });
  }
  const keyword = [...keywordScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([u]) => u);

  const scores = new Map<string, number>();
  rankInto(scores, semantic, 1);
  rankInto(scores, keyword, 1);

  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return Promise.all(
    top.map(async ([url, score], i) => {
      const page = pages.get(url)!;
      const chunk = keywordChunk.get(url)?.chunk ?? bestChunk.get(url)?.chunk;
      const hasCopy = !!page.text;
      const sentence = hasCopy && chunk && i < 5 ? await bestSentence(chunk.text, query, qv) : undefined;
      return {
        url, score, sentence, hasCopy, similarity: bestChunk.get(url)?.score,
        title: page.title, domain: page.domain, lastSeen: page.lastSeen,
        snippet: (sentence ?? chunk?.text ?? '').slice(0, 220),
      };
    }),
  );
}

/* ---- Grouping open tabs by task ---- */

async function groupTabs(tabs: { id: number; title: string; domain: string }[]): Promise<TabGroupSuggestion[]> {
  const THRESHOLD = 0.42;
  const vecs: (Int8Array | undefined)[] = [];
  for (const t of tabs) {
    try {
      vecs.push(quantize(await embed(`${t.title} ${t.domain}`)));
    } catch {
      vecs.push(undefined);
    }
  }
  const groups: { members: number[]; centroid?: Int8Array }[] = [];
  tabs.forEach((t, i) => {
    const v = vecs[i];
    let home = groups.find((g) => g.members.some((m) => tabs[m].domain === t.domain));
    if (!home && v) {
      home = groups.filter((g) => g.members.some((m) => vecs[m]))
        .map((g) => ({ g, s: Math.max(...g.members.map((m) => (vecs[m] ? dot(vecs[m]!, v) : -1))) }))
        .sort((a, b) => b.s - a.s)
        .find((x) => x.s >= THRESHOLD)?.g;
    }
    if (home) home.members.push(i);
    else groups.push({ members: [i] });
  });
  return groups
    .filter((g) => g.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length)
    .map((g) => {
      const titles = g.members.map((m) => tabs[m].title);
      return { name: nameFor(titles, tabs[g.members[0]].domain), tabIds: g.members.map((m) => tabs[m].id), titles };
    });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.to !== 'offscreen') return;
  const respond = (work: Promise<unknown>) => {
    work.then((value) => reply({ value }), (e) => reply({ error: String(e?.message ?? e) }));
    return true;
  };
  if (msg.method === 'search') return respond(search(msg.query));
  if (msg.method === 'group') return respond(groupTabs(msg.tabs));
  if (msg.method === 'status') return respond(model().then(() => ({ ready: true })));
  if (msg.method === 'drain') {
    cache = undefined;
    drain();
    reply({ value: true });
  }
});

drain();
