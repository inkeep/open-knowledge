import { z } from 'zod';
import { detectFmRegion, parseFencedFmRegion } from './bridge/frontmatter-region.ts';
import {
  type FrontmatterMap,
  type FrontmatterValue,
  FrontmatterValueSchema,
  frontmatterValuesEqual,
} from './frontmatter/schema.ts';
import { getDocumentKeys } from './frontmatter/yaml-codec.ts';

export type PropertyChange =
  | { key: string; kind: 'added'; after: FrontmatterValue }
  | { key: string; kind: 'removed'; before: FrontmatterValue }
  | { key: string; kind: 'changed'; before: FrontmatterValue; after: FrontmatterValue };

const PropertyChangeSchema = z.discriminatedUnion('kind', [
  z.object({ key: z.string(), kind: z.literal('added'), after: FrontmatterValueSchema }).loose(),
  z.object({ key: z.string(), kind: z.literal('removed'), before: FrontmatterValueSchema }).loose(),
  z
    .object({
      key: z.string(),
      kind: z.literal('changed'),
      before: FrontmatterValueSchema,
      after: FrontmatterValueSchema,
    })
    .loose(),
]);

export const FrontmatterDeltaSchema = z
  .object({
    changes: z.array(PropertyChangeSchema),
    unparseable: z.object({ before: z.string(), after: z.string() }).loose().nullable(),
  })
  .loose();

export interface FrontmatterDelta {
  changes: PropertyChange[];
  unparseable: { before: string; after: string } | null;
}

interface Side {
  fenced: string;
  map: FrontmatterMap;
  keys: string[];
  parseError: string | undefined;
}

function readSide(raw: string): Side {
  const { fenced } = detectFmRegion(raw);
  const parsed = parseFencedFmRegion(fenced);
  if (parsed.map === null) {
    return { fenced, map: {}, keys: [], parseError: parsed.parseError };
  }
  const docKeys = getDocumentKeys(parsed.doc);
  return {
    fenced,
    map: parsed.map,
    keys: docKeys.length > 0 ? docKeys : Object.keys(parsed.map),
    parseError: undefined,
  };
}

export function diffFrontmatter(beforeRaw: string, afterRaw: string): FrontmatterDelta {
  const before = readSide(beforeRaw);
  const after = readSide(afterRaw);

  if (before.parseError !== undefined || after.parseError !== undefined) {
    return { changes: [], unparseable: { before: before.fenced, after: after.fenced } };
  }

  const changes: PropertyChange[] = [];
  const seen = new Set<string>();

  for (const key of after.keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const afterValue = after.map[key];
    if (afterValue === undefined) continue;
    const beforeValue = before.map[key];
    if (beforeValue === undefined) {
      changes.push({ key, kind: 'added', after: afterValue });
      continue;
    }
    if (!frontmatterValuesEqual(beforeValue, afterValue)) {
      changes.push({ key, kind: 'changed', before: beforeValue, after: afterValue });
    }
  }

  for (const key of before.keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const beforeValue = before.map[key];
    if (beforeValue === undefined) continue;
    changes.push({ key, kind: 'removed', before: beforeValue });
  }

  return { changes, unparseable: null };
}
