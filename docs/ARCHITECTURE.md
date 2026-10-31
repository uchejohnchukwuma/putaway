# Architecture

Putaway is a Manifest V3 extension with no backend. Every byte of browsing data
stays in the browser profile's IndexedDB.

```
 content script ── page text ──▶ service worker ── writes ──▶ IndexedDB
 (every http/https tab)          (tabs, sessions,              ▲     ▲
                                  capture rules)               │     │
                                       │ ensures               │     │ direct reads
                                       ▼                       │     │
                                 offscreen document ───────────┘     │
                                 (MiniLM embeddings, indexing,       │
                                  hybrid search)                     │
                                       ▲                             │
                 new tab page / popup ─┴── RPC through the worker ───┘
```

## Why these pieces

- **Service worker** owns anything that touches tabs. MV3 kills it when idle, so
  it holds no state. Anything durable goes to IndexedDB or `chrome.storage`.
- **Offscreen document** hosts the model. Service workers cannot run the ONNX
  WASM runtime reliably, and the document stays alive between searches.
- **No network for the model.** The model and runtime ship inside the zip and
  `env.allowRemoteModels` is off.

## Data model (IndexedDB `putaway`)

| Store | Key | Holds |
|---|---|---|
| `pages` | normalized URL | title, saved text, previous text, change marker, index state |
| `chunks` | `url#n` | chunk text and an Int8 quantized 384-dim vector |
| `sessions` | id | a put-away group of tabs |
| `workspaces` | id | a named set of tabs that can be swapped in |
| `days` | `day\|url` | per-day dwell time, used only by the recap |

Pages split into passages of about 45 words. The first 64 passages of a page are
embedded, and the rest stay searchable by keyword. Vectors are quantized to one
byte per dimension, so 75,000 vectors take about 29 MB, small enough to scan by
brute force without an ANN index.

## Search

Each query runs two ways, and results merge by reciprocal rank fusion:

1. Cosine similarity against chunk vectors.
2. Keyword scoring across titles, domains and chunk text.

Time words ("last week", "tuesday") are parsed out and become a date filter.
If the model fails to load, keyword search still works.

## Privacy rules

- `incognito: not_allowed`: the extension cannot run in incognito windows.
- Blocked by default: banking, mail, messaging, health, password managers,
  sign-in and checkout pages, private network addresses.
- A page containing a password or card field is never captured.
- Tracking and token query parameters are removed from stored page URLs.
- The only outbound request the extension itself makes is a daily check of the
  public GitHub releases API for a newer version, which can be turned off.

## Limits

- Browser history only exposes URLs and titles, so older pages are searchable by
  title. Full text starts at install, plus whatever is open at that moment.
- MiniLM is strongest in English.
- Unpacked installs do not auto-update.
