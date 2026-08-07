/**
 * Parser for the skills.sh leaderboard (the "popular skills" list).
 *
 * skills.sh has no keyless JSON leaderboard endpoint — the ranked list is behind
 * a token-gated API we don't want to require — but the front page ships the full
 * list in its Next.js RSC (React Flight) payload. This module extracts the cards
 * from that payload so the server can populate "Discover" with popular skills
 * without a search query.
 *
 * Pure (no fetch) so it's unit-testable against a saved fixture; the server does
 * the fetch + caching. Defensive like the sibling `parseSkillsShSearch`: shape
 * drift skips a card rather than throwing. We also SORT by installs ourselves
 * rather than trusting the payload's order — their internal ordering is not a
 * contract, and imposing the sort makes a reorder a non-event instead of a break.
 */

import { isRetiredPackListing } from '../constants/skills.ts';
import type { SkillSearchResult } from './schema.ts';
import { ownerOf } from './source-fields.ts';

interface RawCard {
  skillId: string;
  source: string;
  installs: number;
}

/**
 * Normalize either the raw RSC Flight stream (from a `RSC: 1` fetch) or a full
 * HTML page (Flight data wrapped in `self.__next_f.push([1,"…"])` chunks) into a
 * single un-escaped Flight string.
 */
function toFlightStream(body: string): string {
  if (!body.includes('self.__next_f')) return body; // already a raw Flight stream
  const chunk = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let out = '';
  for (const m of body.matchAll(chunk)) out += JSON.parse(m[1] as string) as string;
  return out;
}

const CARD_KEYS = ['skillId', 'source', 'installs'] as const;

/** A card is small; anything larger is an ancestor, not a card. Bounds the
 *  depth-map allocation below so a megabyte-scale wrapper is never scanned. */
const MAX_CARD_SLICE_BYTES = 8192;

/**
 * Read the three card fields off ONE object's source slice, considering only
 * properties at the object's own depth.
 *
 * The fallback for when `JSON.parse` refuses the slice — which real Flight
 * payloads cause routinely, because a card can carry a Flight reference
 * (`"icon":$L12`) that is not valid JSON. Parsing strictly and skipping the
 * rest would empty the shelf on exactly the payload this parser exists to read.
 *
 * Still object-scoped, which is the property that matters: a stray key
 * elsewhere on the page cannot reach this slice, so it cannot mispair a card.
 * Depth-tracking keeps a nested `{"author":{"source":…}}` from shadowing the
 * card's own field.
 */
function fieldsAtOwnDepth(slice: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (slice.length > MAX_CARD_SLICE_BYTES) return out;

  // Depth of every index, so a match can be tested for "direct property of this
  // object" (depth 1 — the opening brace took it to 1).
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

/**
 * Yield every brace-balanced object in the stream that mentions all of
 * `CARD_KEYS`, innermost first. Single forward pass tracking string state, so
 * braces and quotes inside string values can't desynchronize it; slices are
 * taken only for candidate objects.
 */
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
      } catch {
        // Falls through to the slice reader below.
      }
      yield fieldsAtOwnDepth(slice);
    }
  }
}

/**
 * Extract skill cards, in payload order, from a Flight stream or HTML page. A
 * card needs all of `skillId` / `source` / `installs` ON ONE OBJECT; anything
 * else is DROPPED (never fabricated), so a partial object can't yield a bogus
 * id or dead URL.
 *
 * Object-scoped rather than positional on purpose. Scanning loose `"key":value`
 * matches and cutting a card at the first repeat meant one stray `source` /
 * `skillId` / `installs` key ANYWHERE in the page permanently desynchronized the
 * window: every later card paired one skill's name with the previous card's
 * repository. That is worse than dropping a card — it is a complete-looking card
 * pointing at a repo the skill does not live in, and nothing downstream can tell.
 */
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

/**
 * Parse the skills.sh front-page payload into `SkillSearchResult`s ordered by
 * install count (most first). De-duplicated by id; the same shape the search
 * proxy returns, so the client renders both identically. Empty when the payload
 * can't be parsed — the caller degrades to topic chips.
 */
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
