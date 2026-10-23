import {
  Document,
  isMap,
  isSeq,
  type Pair,
  parseDocument,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { FRONTMATTER_RE, unwrapFrontmatterFences } from '../extensions/frontmatter.ts';
import {
  type FrontmatterMap,
  FrontmatterMapSchema,
  FrontmatterPatchSchema,
  type FrontmatterValue,
  FrontmatterValueSchema,
  RESERVED_FRONTMATTER_KEY,
} from '../frontmatter/schema.ts';
import { buildValueNode, STRINGIFY_OPTIONS, withFences } from '../frontmatter/yaml-codec.ts';

export const MAX_FM_REGION_BYTES = 65536;

interface FmRegion {
  fenced: string;
  body: string;
}

export function detectFmRegion(ytextSnapshot: string): FmRegion {
  const match = ytextSnapshot.match(FRONTMATTER_RE);
  if (!match) return { fenced: '', body: ytextSnapshot };
  return { fenced: match[0], body: ytextSnapshot.slice(match[0].length) };
}

export type ParsedFmRegion =
  | { doc: Document; map: FrontmatterMap; parseError?: never }
  | { doc: Document; map: null; parseError: string };

export function parseFmRegion(yamlBody: string): ParsedFmRegion {
  if (yamlBody.trim() === '') {
    return { doc: new Document({}), map: {} };
  }
  let doc: Document;
  try {
    doc = parseDocument(yamlBody, { uniqueKeys: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { doc: new Document({}), map: null, parseError: `parse threw: ${msg}` };
  }
  if (doc.errors.length > 0) {
    return { doc, map: null, parseError: doc.errors[0]?.message ?? 'yaml parse errors' };
  }
  let json: unknown;
  try {
    json = doc.toJS();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { doc, map: null, parseError: `toJS threw: ${msg}` };
  }
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    return { doc, map: null, parseError: 'top-level value is not a mapping' };
  }
  const result = FrontmatterMapSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && Array.isArray(issue.path) ? issue.path.join('.') : '';
    const reason = issue?.message ?? 'unknown';
    return {
      doc,
      map: null,
      parseError: path
        ? `value at "${path}" failed schema: ${reason}`
        : `schema validation failed: ${reason}`,
    };
  }
  return { doc, map: result.data };
}

export function parseFencedFmRegion(fenced: string): ParsedFmRegion {
  if (fenced === '') return { doc: new Document({}), map: {} };
  return parseFmRegion(unwrapFrontmatterFences(fenced));
}

export function readFmMap(ytextSnapshot: string): FrontmatterMap {
  const { fenced } = detectFmRegion(ytextSnapshot);
  const { map } = parseFencedFmRegion(fenced);
  return map ?? {};
}

interface ReadFmResult {
  map: FrontmatterMap;
  parseError: string | undefined;
}

export function readFmRegionWithError(ytextSnapshot: string): ReadFmResult {
  const { fenced } = detectFmRegion(ytextSnapshot);
  const { map, parseError } = parseFencedFmRegion(fenced);
  return { map: map ?? {}, parseError };
}

export function readFmKeys(ytextSnapshot: string): string[] {
  const { fenced } = detectFmRegion(ytextSnapshot);
  if (fenced === '') return [];
  const { doc, map } = parseFencedFmRegion(fenced);
  if (map === null) return [];
  return getDocKeys(doc);
}

function isPair(item: unknown): item is Pair {
  return item !== null && typeof item === 'object' && 'key' in (item as Record<string, unknown>);
}

function pairKey(pair: Pair): string | null {
  const key = pair.key as { value?: unknown } | string | undefined;
  if (typeof key === 'string') return key;
  if (key && typeof key === 'object' && 'value' in key && typeof key.value === 'string') {
    return key.value;
  }
  return null;
}

function setPairKey(pair: Pair, newKey: string): void {
  const key = pair.key as Scalar<unknown> | { value?: unknown } | string | undefined;
  if (typeof key === 'string') {
    pair.key = newKey;
    return;
  }
  if (key && typeof key === 'object') {
    (key as { value: string }).value = newKey;
    return;
  }
  pair.key = newKey;
}

function getDocKeys(doc: Document): string[] {
  const contents = doc.contents as YAMLMap | null | undefined;
  if (!contents || !('items' in contents) || !Array.isArray(contents.items)) return [];
  const out: string[] = [];
  for (const item of contents.items) {
    if (!isPair(item)) continue;
    const k = pairKey(item);
    if (k !== null) out.push(k);
  }
  return out;
}

export type FmEditError =
  | { kind: 'unknown_key'; key: string }
  | { kind: 'duplicate_target'; key: string }
  | { kind: 'invalid_value'; key: string; reason: string }
  | { kind: 'reserved_key'; key: string }
  | { kind: 'reorder_mismatch'; expected: string[]; got: string[] }
  | { kind: 'region_too_large'; bytes: number; limit: number }
  | { kind: 'parse_failed'; reason: string }
  | { kind: 'invalid_path'; path: ReadonlyArray<string | number>; reason: string };

export type FmEditResult = { ok: true; nextFenced: string } | { ok: false; error: FmEditError };

function ensureContents(doc: Document): YAMLMap {
  if (doc.contents == null || !('items' in (doc.contents as object))) {
    const empty = doc.createNode({}) as YAMLMap;
    doc.contents = empty;
    return empty;
  }
  return doc.contents as YAMLMap;
}

function stringify(doc: Document): string {
  const contents = doc.contents as YAMLMap | null | undefined;
  if (!contents || !('items' in contents) || (contents.items?.length ?? 0) === 0) {
    return '';
  }
  return withFences(doc.toString(STRINGIFY_OPTIONS));
}

function checkRegionSize(fenced: string): FmEditError | null {
  const bytes = new TextEncoder().encode(fenced).byteLength;
  if (bytes > MAX_FM_REGION_BYTES) {
    return { kind: 'region_too_large', bytes, limit: MAX_FM_REGION_BYTES };
  }
  return null;
}

function finalizeFenced(doc: Document): FmEditResult {
  const next = stringify(doc);
  const sizeErr = checkRegionSize(next);
  if (sizeErr) return { ok: false, error: sizeErr };
  return { ok: true, nextFenced: next };
}

export function applyPatchToFm(
  currentFenced: string,
  patch: Record<string, FrontmatterValue | null>,
): FmEditResult {
  if (Object.hasOwn(patch, RESERVED_FRONTMATTER_KEY)) {
    return { ok: false, error: { kind: 'reserved_key', key: RESERVED_FRONTMATTER_KEY } };
  }

  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  const parsed = FrontmatterPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'invalid_value',
        key: String(parsed.error.issues[0]?.path[0] ?? ''),
        reason: parsed.error.issues[0]?.message ?? 'invalid value',
      },
    };
  }

  try {
    ensureContents(doc);

    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === null) {
        doc.delete(key);
        continue;
      }
      doc.set(key, buildValueNode(doc, doc.get(key, true), value));
    }

    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

export function applyRenameToFm(
  currentFenced: string,
  oldKey: string,
  newKey: string,
  options: { allowDuplicate?: boolean } = {},
): FmEditResult {
  if (oldKey === RESERVED_FRONTMATTER_KEY || newKey === RESERVED_FRONTMATTER_KEY) {
    return { ok: false, error: { kind: 'reserved_key', key: RESERVED_FRONTMATTER_KEY } };
  }

  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  if (oldKey === newKey) {
    return { ok: true, nextFenced: currentFenced };
  }

  const contents = doc.contents as YAMLMap | null | undefined;
  if (!contents || !('items' in contents) || !Array.isArray(contents.items)) {
    return { ok: false, error: { kind: 'unknown_key', key: oldKey } };
  }

  const sourcePair = contents.items.find(
    (item): item is Pair => isPair(item) && pairKey(item) === oldKey,
  );
  if (!sourcePair) {
    return { ok: false, error: { kind: 'unknown_key', key: oldKey } };
  }

  if (!options.allowDuplicate) {
    const collides = contents.items.some(
      (item) => isPair(item) && item !== sourcePair && pairKey(item) === newKey,
    );
    if (collides) {
      return { ok: false, error: { kind: 'duplicate_target', key: newKey } };
    }
  }

  try {
    setPairKey(sourcePair, newKey);

    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

export function applyReorderToFm(
  currentFenced: string,
  orderedKeys: readonly string[],
): FmEditResult {
  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  const contents = doc.contents as YAMLMap | null | undefined;
  if (!contents || !('items' in contents) || !Array.isArray(contents.items)) {
    return { ok: true, nextFenced: currentFenced };
  }

  const currentKeys = getDocKeys(doc);
  if (currentKeys.length !== orderedKeys.length || !permutationOf(currentKeys, orderedKeys)) {
    return {
      ok: false,
      error: {
        kind: 'reorder_mismatch',
        expected: currentKeys,
        got: [...orderedKeys],
      },
    };
  }

  try {
    const remaining: Pair[] = contents.items.filter(isPair);
    const next: Pair[] = [];
    for (const key of orderedKeys) {
      const idx = remaining.findIndex((p) => pairKey(p) === key);
      if (idx === -1) {
        return {
          ok: false,
          error: {
            kind: 'reorder_mismatch',
            expected: currentKeys,
            got: [...orderedKeys],
          },
        };
      }
      const [picked] = remaining.splice(idx, 1);
      if (picked) next.push(picked);
    }
    contents.items = next;

    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

function permutationOf(a: readonly string[], b: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const k of a) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const k of b) {
    const next = (counts.get(k) ?? 0) - 1;
    if (next < 0) return false;
    counts.set(k, next);
  }
  for (const v of counts.values()) if (v !== 0) return false;
  return true;
}

function validatePath(path: ReadonlyArray<string | number>): FmEditError | null {
  if (path.length === 0) {
    return { kind: 'invalid_path', path: [...path], reason: 'path must have at least one segment' };
  }
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (typeof seg !== 'string' && typeof seg !== 'number') {
      return {
        kind: 'invalid_path',
        path: [...path],
        reason: `path segment at index ${i} must be string or number`,
      };
    }
    if (typeof seg === 'number' && (!Number.isInteger(seg) || seg < 0)) {
      return {
        kind: 'invalid_path',
        path: [...path],
        reason: `numeric path segment at index ${i} must be a non-negative integer`,
      };
    }
  }
  if (path[0] === RESERVED_FRONTMATTER_KEY) {
    return { kind: 'reserved_key', key: RESERVED_FRONTMATTER_KEY };
  }
  return null;
}

export function applyPathSetToFm(
  currentFenced: string,
  path: ReadonlyArray<string | number>,
  value: FrontmatterValue,
): FmEditResult {
  const pathErr = validatePath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  const parsed = FrontmatterValueSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'invalid_value',
        key: String(path[path.length - 1]),
        reason: parsed.error.issues[0]?.message ?? 'invalid value',
      },
    };
  }

  try {
    ensureContents(doc);
    doc.setIn(path as unknown[], buildValueNode(doc, doc.getIn(path, true), parsed.data));
    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

export function applyPathDeleteToFm(
  currentFenced: string,
  path: ReadonlyArray<string | number>,
): FmEditResult {
  const pathErr = validatePath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  try {
    if (doc.getIn(path as unknown[], true) === undefined) {
      return { ok: true, nextFenced: currentFenced };
    }
    doc.deleteIn(path as unknown[]);

    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

function resolveParentMap(
  doc: Document,
  parentPath: ReadonlyArray<string | number>,
): YAMLMap | null {
  if (parentPath.length === 0) {
    const contents = doc.contents as YAMLMap | null | undefined;
    return isMap(contents) ? contents : null;
  }
  const node = doc.getIn(parentPath, true);
  return isMap(node) ? node : null;
}

export function applyPathRenameToFm(
  currentFenced: string,
  path: ReadonlyArray<string | number>,
  newKey: string,
  options: { allowDuplicate?: boolean } = {},
): FmEditResult {
  const pathErr = validatePath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const lastSeg = path[path.length - 1];
  if (typeof lastSeg !== 'string') {
    return {
      ok: false,
      error: {
        kind: 'invalid_path',
        path: [...path],
        reason: 'cannot rename: last path segment must be a string (map key)',
      },
    };
  }
  if (path.length === 1 && newKey === RESERVED_FRONTMATTER_KEY) {
    return { ok: false, error: { kind: 'reserved_key', key: RESERVED_FRONTMATTER_KEY } };
  }

  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  if (lastSeg === newKey) {
    return { ok: true, nextFenced: currentFenced };
  }

  const parent = resolveParentMap(doc, path.slice(0, -1));
  if (!parent) {
    return { ok: false, error: { kind: 'unknown_key', key: lastSeg } };
  }

  const sourcePair = parent.items.find(
    (item): item is Pair => isPair(item) && pairKey(item) === lastSeg,
  );
  if (!sourcePair) {
    return { ok: false, error: { kind: 'unknown_key', key: lastSeg } };
  }

  if (!options.allowDuplicate) {
    const collides = parent.items.some(
      (item) => isPair(item) && item !== sourcePair && pairKey(item) === newKey,
    );
    if (collides) {
      return { ok: false, error: { kind: 'duplicate_target', key: newKey } };
    }
  }

  try {
    setPairKey(sourcePair, newKey);
    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

export function applyPathReorderToFm(
  currentFenced: string,
  path: ReadonlyArray<string | number>,
  orderedKeys: readonly string[],
): FmEditResult {
  if (path.length === 0) return applyReorderToFm(currentFenced, orderedKeys);

  const pathErr = validatePath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  const target = doc.getIn(path, true);
  if (!isMap(target)) {
    return {
      ok: false,
      error: {
        kind: 'invalid_path',
        path: [...path],
        reason: 'cannot reorder: target is not a map',
      },
    };
  }

  const currentKeys: string[] = [];
  for (const item of target.items) {
    if (!isPair(item)) continue;
    const k = pairKey(item);
    if (k !== null) currentKeys.push(k);
  }

  if (currentKeys.length !== orderedKeys.length || !permutationOf(currentKeys, orderedKeys)) {
    return {
      ok: false,
      error: {
        kind: 'reorder_mismatch',
        expected: currentKeys,
        got: [...orderedKeys],
      },
    };
  }

  try {
    const remaining: Pair[] = target.items.filter(isPair);
    const next: Pair[] = [];
    for (const key of orderedKeys) {
      const idx = remaining.findIndex((p) => pairKey(p) === key);
      if (idx === -1) {
        return {
          ok: false,
          error: {
            kind: 'reorder_mismatch',
            expected: currentKeys,
            got: [...orderedKeys],
          },
        };
      }
      const [picked] = remaining.splice(idx, 1);
      if (picked) next.push(picked);
    }
    target.items = next;

    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

export function applyPathReorderSeqToFm(
  currentFenced: string,
  path: ReadonlyArray<string | number>,
  oldIndicesInNewOrder: readonly number[],
): FmEditResult {
  const pathErr = validatePath(path);
  if (pathErr) return { ok: false, error: pathErr };

  const { doc, map } = parseFencedFmRegion(currentFenced);
  if (map === null) {
    return { ok: false, error: { kind: 'parse_failed', reason: 'fm region unparseable' } };
  }

  const target = doc.getIn(path, true);
  if (!isSeq(target)) {
    return {
      ok: false,
      error: {
        kind: 'invalid_path',
        path: [...path],
        reason: 'cannot reorder: target is not a sequence',
      },
    };
  }

  const seq = target as YAMLSeq;
  const n = seq.items.length;
  const currentIndices = Array.from({ length: n }, (_, i) => i);
  const want = [...oldIndicesInNewOrder];
  if (!isIndexPermutation(want, n)) {
    return {
      ok: false,
      error: {
        kind: 'reorder_mismatch',
        expected: currentIndices.map(String),
        got: want.map(String),
      },
    };
  }

  try {
    const original = seq.items.slice();
    const next = want.map((idx) => original[idx]);
    seq.items = next;

    return finalizeFenced(doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse_failed', reason: `yaml@2 threw: ${reason}` } };
  }
}

function isIndexPermutation(want: readonly number[], n: number): boolean {
  if (want.length !== n) return false;
  const seen = new Array<boolean>(n).fill(false);
  for (const idx of want) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) return false;
    if (seen[idx]) return false;
    seen[idx] = true;
  }
  return true;
}
