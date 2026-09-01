import { isRetiredPackListing } from '../constants/skills.ts';
import type { SkillSearchResult } from './schema.ts';
import { ownerOf } from './source-fields.ts';

interface RawCard {
  skillId: string;
  source: string;
  installs: number;
}

function toFlightStream(body: string): string {
  if (!body.includes('self.__next_f')) return body;
  const chunk = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let out = '';
  for (const m of body.matchAll(chunk)) out += JSON.parse(m[1] as string) as string;
  return out;
}

const CARD_KEYS = ['skillId', 'source', 'installs'] as const;

const MAX_CARD_SLICE_BYTES = 8192;

function fieldsAtOwnDepth(slice: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (slice.length > MAX_CARD_SLICE_BYTES) return out;

  const depthAt = new Uint8Array(slice.length);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < slice.length; i++) {
    depthAt[i] = Math.min(depth, 255);
    const ch = slice[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }

  const field = /"(skillId|source|installs)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/g;
  for (const m of slice.matchAll(field)) {
    const key = m[1] as string;
    if (m.index === undefined || depthAt[m.index] !== 1 || key in out) continue;
    const raw = m[2] as string;
    out[key] = raw.startsWith('"') ? (JSON.parse(raw) as string) : Number(raw);
  }
  return out;
}

function* candidateObjects(flight: string): Generator<Record<string, unknown>> {
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < flight.length; i++) {
    const ch = flight[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') starts.push(i);
    else if (ch === '}') {
      const start = starts.pop();
      if (start === undefined) continue;
      const slice = flight.slice(start, i + 1);
      if (!CARD_KEYS.every((k) => slice.includes(`"${k}"`))) continue;
      try {
        const parsed: unknown = JSON.parse(slice);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          yield parsed as Record<string, unknown>;
          continue;
        }
      } catch {}
      yield fieldsAtOwnDepth(slice);
    }
  }
}

export function parseSkillsShLeaderboardCards(body: string): RawCard[] {
  const flight = toFlightStream(body);
  const cards: RawCard[] = [];
  for (const obj of candidateObjects(flight)) {
    const { skillId, source, installs } = obj;
    if (typeof skillId !== 'string' || skillId === '') continue;
    if (typeof source !== 'string' || source === '') continue;
    if (typeof installs !== 'number' || !Number.isFinite(installs)) continue;
    cards.push({ skillId, source, installs });
  }
  return cards;
}

export function parseSkillsShLeaderboard(body: string): SkillSearchResult[] {
  const byId = new Map<string, SkillSearchResult>();
  for (const c of parseSkillsShLeaderboardCards(body)) {
    const id = `${c.source}/${c.skillId}`;
    if (byId.has(id) || isRetiredPackListing(c.skillId, c.source)) continue;
    byId.set(id, {
      id,
      name: c.skillId,
      source: c.source,
      description: '',
      installs: c.installs,
      publisher: ownerOf(c.source),
    });
  }
  return [...byId.values()].sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1));
}
