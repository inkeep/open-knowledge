/**
 * Semantic delta between the frontmatter regions of two markdown snapshots.
 *
 * Diff surfaces compare bodies as text, which cannot answer "which property
 * changed": YAML does not round-trip byte-stably through the editor, so a key
 * reorder, a requote, or a block/flow restyle reads as a wall of line changes
 * while every stored value is identical. This compares PARSED values via
 * `frontmatterValuesEqual`, so only a real value change is reported and a
 * reserialization reports nothing.
 *
 * Lives at the package root rather than under `bridge/` or `frontmatter/`: it
 * reads `bridge/frontmatter-region.ts` for region detection and its
 * dup-key-tolerant parse (so a delta agrees with what the property panel
 * renders) plus `frontmatter/` for the value schema, and importing both from
 * either directory would close a cycle. This is feature code, not part of the
 * engine estate whose test apparatus and comments stay off the public mirror.
 */

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

// Hand-written types above, schemas below, rather than `z.infer`: the recursive
// `FrontmatterValueSchema` is a `z.lazy` union whose inferred type collapses to
// `never` under zod@4 (the footgun `FrontmatterMap` is hand-written for too).
// `.loose()` throughout: these travel as the `properties` field of
// `AgentBurstDiffSuccessSchema`, and an outer loose object does not relax its
// nested ones — a strict arm here would reject a response from a newer server
// that added a field, which is the forward-compatibility the sibling wire
// schemas in `schemas/api/metrics.ts` all buy the same way.
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
  /**
   * After-side source order first, then keys that only exist on the before
   * side. Source order — not alphabetical — so a rendered delta reads in the
   * same sequence as the property panel it came from.
   */
  changes: PropertyChange[];
  /**
   * Non-null when either side's YAML failed to parse, carrying both raw fenced
   * regions. A structural delta is not derivable then, and reporting zero
   * changes would be indistinguishable from "nothing happened" on precisely
   * the version a reader most needs to inspect — so callers render these raw
   * instead.
   */
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
  // Prefer YAML source order; fall back to map order when the Document carries
  // no readable pairs (mirrors the property panel's degraded render).
  const docKeys = getDocumentKeys(parsed.doc);
  return {
    fenced,
    map: parsed.map,
    keys: docKeys.length > 0 ? docKeys : Object.keys(parsed.map),
    parseError: undefined,
  };
}

/**
 * Compare the frontmatter regions of two full markdown snapshots (frontmatter
 * region + body, as stored in `Y.Text('source')` or read from disk).
 *
 * A snapshot with no frontmatter region is treated as an empty map, so adding
 * a first property reports every key as added and deleting the block reports
 * every key as removed.
 */
export function diffFrontmatter(beforeRaw: string, afterRaw: string): FrontmatterDelta {
  const before = readSide(beforeRaw);
  const after = readSide(afterRaw);

  if (before.parseError !== undefined || after.parseError !== undefined) {
    return { changes: [], unparseable: { before: before.fenced, after: after.fenced } };
  }

  const changes: PropertyChange[] = [];
  // yaml@2 admits duplicate keys and the parse is configured to tolerate them,
  // so the same name can appear twice in source order while the value map holds
  // one entry. Dedupe to one row per name; the compared value is whatever the
  // map resolved (last occurrence), which is the value the property panel
  // renders for that document — a delta that disagreed with the panel would be
  // worse than one that inherits its ambiguity.
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
