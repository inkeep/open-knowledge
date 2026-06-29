
import { UA_PATTERNS } from '@inkeep/open-knowledge-core';

export type EmbedProbeEntry = {
  ts: number;
  url: string;
  method: string;
  ua?: string;
  origin?: string;
  referer?: string;
  host?: string;
  remote?: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  secFetchSite?: string;
  secFetchDest?: string;
  secFetchMode?: string;
  secFetchUser?: string;
};

export class RingBuffer<T> {
  private readonly capacity: number;
  private readonly store: (T | undefined)[];
  private writeIndex = 0;
  private filled = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.store = new Array<T | undefined>(capacity);
  }

  push(entry: T): void {
    this.store[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.writeIndex === 0) this.filled = true;
  }

  read(): T[] {
    const out: T[] = [];
    const length = this.filled ? this.capacity : this.writeIndex;
    for (let offset = 1; offset <= length; offset++) {
      const index = (this.writeIndex - offset + this.capacity) % this.capacity;
      const value = this.store[index];
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  get size(): number {
    return this.filled ? this.capacity : this.writeIndex;
  }
}

export const EMBED_PROBE_CAPACITY = 256;
export const embedProbeRing = new RingBuffer<EmbedProbeEntry>(EMBED_PROBE_CAPACITY);

export function recordEmbedProbe(entry: EmbedProbeEntry): void {
  embedProbeRing.push(entry);
}


const CURSOR_UA_RE = UA_PATTERNS.cursor;
const CODEX_UA_RE = UA_PATTERNS.codex;
const CLAUDE_UA_RE = UA_PATTERNS['claude-desktop'];

const CURSOR_REFERER_STRATEGY_LITERAL = '?strategy=C_iframe';


type DetectedApp = 'cursor' | 'codex' | 'claude' | null;

type EmbedDetection = {
  app: DetectedApp;
  signals_fired: string[];
};

const EMPTY_DETECTION: EmbedDetection = {
  app: null,
  signals_fired: [],
};

export function deriveDetection(entry: EmbedProbeEntry | undefined): EmbedDetection {
  if (!entry) return { ...EMPTY_DETECTION };

  const fired: string[] = [];
  const ua = entry.ua;
  const referer = entry.referer;

  const cursorUaFires = !!ua && CURSOR_UA_RE.test(ua);
  const cursorRefererFires = !!referer && referer.includes(CURSOR_REFERER_STRATEGY_LITERAL);
  if (cursorUaFires) fired.push('cursor_ua_regex');
  if (cursorRefererFires) fired.push('cursor_referer_strategy_iframe');
  if (cursorUaFires || cursorRefererFires) {
    return { app: 'cursor', signals_fired: fired };
  }

  const codexUaFires = !!ua && CODEX_UA_RE.test(ua);
  if (codexUaFires) fired.push('codex_ua_regex');
  if (codexUaFires) {
    return { app: 'codex', signals_fired: fired };
  }

  const claudeUaFires = !!ua && CLAUDE_UA_RE.test(ua);
  if (claudeUaFires) fired.push('claude_ua_regex');
  if (claudeUaFires) {
    return { app: 'claude', signals_fired: fired };
  }

  return { ...EMPTY_DETECTION };
}
