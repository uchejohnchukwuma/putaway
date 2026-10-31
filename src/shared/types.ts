export interface Page {
  url: string;
  title: string;
  domain: string;
  /** Saved readable text. Empty for pages known only from browser history. */
  text: string;
  hash: string;
  previousText?: string;
  previousAt?: number;
  /** Set when the page differs meaningfully from the last saved copy. */
  changedAt?: number;
  firstSeen: number;
  lastSeen: number;
  visits: number;
  source: 'page' | 'history';
  /** 0 until the offscreen document has embedded this version. */
  indexed: 0 | 1;
}

export interface Chunk {
  id: string;
  url: string;
  n: number;
  text: string;
  vector?: Int8Array;
}

export interface SavedTab {
  url: string;
  title: string;
  favIconUrl?: string;
  pinned?: boolean;
}

export interface Session {
  id: string;
  name: string;
  createdAt: number;
  restoredAt?: number;
  tabs: SavedTab[];
}

export interface Workspace {
  id: string;
  name: string;
  updatedAt: number;
  tabs: SavedTab[];
}

export interface DayRow {
  id: string;
  day: string;
  url: string;
  domain: string;
  title: string;
  dwellMs: number;
}

export interface Settings {
  paused: boolean;
  staleDays: number;
  blockedDomains: string[];
  checkUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  staleDays: 3,
  blockedDomains: [],
  checkUpdates: true,
};

export interface SearchHit {
  url: string;
  title: string;
  domain: string;
  snippet: string;
  /** Best sentence, used to jump straight to the passage. */
  sentence?: string;
  lastSeen: number;
  score: number;
  similarity?: number;
  hasCopy: boolean;
}

export interface TabGroupSuggestion {
  name: string;
  tabIds: number[];
  titles: string[];
}

export interface CapturePayload {
  url: string;
  title: string;
  text: string;
}
