import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { LOCAL_DIR, OK_DIR, SKILL_PLACEMENTS_FILENAME } from '@inkeep/open-knowledge-core';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { createKeyedSerializer } from './keyed-serializer.ts';
import { getLogger } from './logger.ts';

const PLACEMENTS_REL = [OK_DIR, LOCAL_DIR, SKILL_PLACEMENTS_FILENAME] as const;
const SCHEMA_VERSION = 1;

export interface SkillPlacement {
  path: string;
  mode: 'copy' | 'link';
  hash?: string;
}

export type FolderExpectation = { expect: 'link'; target: string } | { expect: 'own' };

export interface SkillPlacementsStore {
  schema: number;
  skills: Record<string, SkillPlacement[]>;
  preferences?: Record<string, 'copy' | 'link'>;
  sources?: Record<string, string>;
  roots?: string[];
  folders?: Record<string, FolderExpectation>;
}

function skillPlacementsPath(base: string): string {
  return join(base, ...PLACEMENTS_REL);
}

function findExistingAncestor(candidate: string): string | null {
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
  return ancestor;
}

function findObservedAncestor(candidate: string): string | null {
  let ancestor = candidate;
  while (true) {
    try {
      statSync(ancestor);
      return ancestor;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }
}

function resolveSkillPlacementPathWithAncestor(
  base: string,
  relPath: string,
  findAncestor: (candidate: string) => string | null,
): string | null {
  if (
    relPath.length === 0 ||
    relPath.includes('\0') ||
    isAbsolute(relPath) ||
    relPath.split(/[/\\]/).some((segment) => segment === '..')
  ) {
    return null;
  }
  const baseAbs = resolve(base);
  const candidate = resolve(baseAbs, relPath);
  if (candidate === baseAbs || !candidate.startsWith(`${baseAbs}${sep}`)) return null;

  const baseReal = realpathSync(baseAbs);
  const ancestor = findAncestor(candidate);
  if (ancestor === null) return null;
  const ancestorReal = realpathSync(ancestor);
  if (ancestorReal !== baseReal && !ancestorReal.startsWith(`${baseReal}${sep}`)) return null;
  return candidate;
}

function resolveSkillPlacementPathChecked(base: string, relPath: string): string | null {
  return resolveSkillPlacementPathWithAncestor(base, relPath, findObservedAncestor);
}

export function resolveSkillPlacementPath(base: string, relPath: string): string | null {
  try {
    return resolveSkillPlacementPathWithAncestor(base, relPath, findExistingAncestor);
  } catch {
    return null;
  }
}

function emptyStore(): SkillPlacementsStore {
  return { schema: SCHEMA_VERSION, skills: {} };
}

type PlacementResolver = (base: string, relPath: string) => string | null;

function isPlacement(
  base: string,
  value: unknown,
  resolvePath: PlacementResolver,
): value is SkillPlacement {
  if (!value || typeof value !== 'object') return false;
  const placement = value as Partial<SkillPlacement>;
  return (
    typeof placement.path === 'string' &&
    resolvePath(base, placement.path) !== null &&
    (placement.mode === 'copy' || placement.mode === 'link') &&
    (placement.hash === undefined || typeof placement.hash === 'string')
  );
}

function parsePreferences(value: unknown): Record<string, 'copy' | 'link'> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, 'copy' | 'link'] => entry[1] === 'copy' || entry[1] === 'link',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseSources(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseFolders(
  base: string,
  value: unknown,
  resolvePath: PlacementResolver,
): Record<string, FolderExpectation> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries: Array<[string, FolderExpectation]> = [];
  for (const [root, expectation] of Object.entries(value)) {
    if (resolvePath(base, root) === null || !expectation || typeof expectation !== 'object') {
      continue;
    }
    const candidate = expectation as Partial<FolderExpectation> & { target?: unknown };
    if (candidate.expect === 'own') {
      entries.push([root, { expect: 'own' }]);
    } else if (
      candidate.expect === 'link' &&
      typeof candidate.target === 'string' &&
      resolvePath(base, candidate.target) !== null
    ) {
      entries.push([root, { expect: 'link', target: candidate.target }]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizePlacements(
  base: string,
  parsed: Record<string, unknown>,
  resolvePath: PlacementResolver = resolveSkillPlacementPath,
): SkillPlacementsStore {
  const skills: Record<string, SkillPlacement[]> = {};
  if (parsed.skills && typeof parsed.skills === 'object') {
    for (const [name, list] of Object.entries(parsed.skills)) {
      if (!Array.isArray(list)) continue;
      const valid = list.filter((placement) => isPlacement(base, placement, resolvePath));
      if (valid.length > 0) skills[name] = valid;
    }
  }
  const roots = Array.isArray(parsed.roots)
    ? parsed.roots.filter(
        (root): root is string => typeof root === 'string' && resolvePath(base, root) !== null,
      )
    : [];
  const preferences = parsePreferences(parsed.preferences);
  const sources = parseSources(parsed.sources);
  const folders = parseFolders(base, parsed.folders, resolvePath);
  return {
    schema: SCHEMA_VERSION,
    skills,
    ...(preferences ? { preferences } : {}),
    ...(sources ? { sources } : {}),
    ...(roots.length > 0 ? { roots } : {}),
    ...(folders ? { folders } : {}),
  };
}

export function readSkillPlacementsStore(base: string): SkillPlacementsStore {
  const path = skillPlacementsPath(base);
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return normalizePlacements(base, parsed);
  } catch (err) {
    getLogger('skill-placements').warn(
      { err, path },
      'skill-placements.json is unreadable; continuing with an empty ledger (recorded placements for this project are lost)',
    );
    return emptyStore();
  }
}

type PlacementsScanRead =
  | { kind: 'read'; store: SkillPlacementsStore }
  | { kind: 'unparsable'; error: unknown };

function readSkillPlacementsForScan(
  base: string,
  resolvePath: PlacementResolver,
): PlacementsScanRead {
  const path = skillPlacementsPath(base);
  try {
    statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'read', store: emptyStore() };
    throw err;
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown> | null;
  } catch (error) {
    getLogger('skill-placements').warn(
      { err: error, path },
      'skill-placements.json is not valid JSON; skill scans read no recorded roots or sources from it, and in-place skill refreshes keep the prior admission of the skills it decides',
    );
    return { kind: 'unparsable', error };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'read', store: emptyStore() };
  return { kind: 'read', store: normalizePlacements(base, parsed, resolvePath) };
}

type PlacementsRead =
  | { ok: true; store: SkillPlacementsStore }
  | { ok: false; reason: string; cause?: unknown };

function readSkillPlacementsForMutation(base: string): PlacementsRead {
  const path = skillPlacementsPath(base);
  if (!existsSync(path)) return { ok: true, store: emptyStore() };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { ok: true, store: emptyStore() };
    return {
      ok: false,
      reason: code ? `it could not be read (${code})` : 'it could not be read',
      cause: err,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'it is not valid JSON', cause: err };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'its contents are not a placements ledger' };
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (schema !== undefined && schema !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        typeof schema === 'number'
          ? `it declares schema ${schema}, which this server does not understand (it writes schema ${SCHEMA_VERSION})`
          : 'it declares an unsupported schema value',
    };
  }
  return { ok: true, store: normalizePlacements(base, parsed as Record<string, unknown>) };
}

const serializeLedgerWrite = createKeyedSerializer();

export function mutateSkillPlacementsStore(
  base: string,
  mutate: (store: SkillPlacementsStore) => void,
): Promise<void> {
  return serializeLedgerWrite(skillPlacementsPath(base), async () => {
    const read = readSkillPlacementsForMutation(base);
    if (!read.ok) {
      const path = skillPlacementsPath(base);
      getLogger('skill-placements').error(
        { path, reason: read.reason, err: read.cause },
        'refusing to rewrite skill-placements.json because it could not be read — rewriting it would replace every placement it records with this one',
      );
      throw new Error(`Refusing to rewrite ${path}: ${read.reason}`);
    }
    const store = read.store;
    mutate(store);
    await writeSkillPlacementsStore(base, store);
  });
}

async function writeSkillPlacementsStore(base: string, store: SkillPlacementsStore): Promise<void> {
  const path = skillPlacementsPath(base);
  await tracedMkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(store, null, 2)}\n`, {
    fs: tracedAtomicFs,
  });
}

function knownSkillPlacementRoots(
  base: string,
  store: SkillPlacementsStore,
  resolvePath: PlacementResolver,
): string[] {
  const roots = new Set(store.roots ?? []);
  for (const list of Object.values(store.skills)) {
    for (const placement of list) {
      const root = placement.path.split('/').slice(0, -1).join('/');
      if (root !== '' && resolvePath(base, root) !== null) roots.add(root);
    }
  }
  return [...roots].sort();
}

export function readKnownSkillPlacementRoots(base: string): string[] {
  return knownSkillPlacementRoots(base, readSkillPlacementsStore(base), resolveSkillPlacementPath);
}

type SkillPlacementScanInputs =
  | { kind: 'complete'; roots: string[]; sources: Record<string, string> }
  | { kind: 'unparsable'; roots: string[]; sources: Record<string, string>; error: unknown }
  | { kind: 'incomplete'; roots: string[]; sources: Record<string, string>; error: unknown };

export function observeSkillPlacementInputsForScan(base: string): SkillPlacementScanInputs {
  const errors: unknown[] = [];
  const resolvePath: PlacementResolver = (pathBase, relPath) => {
    try {
      return resolveSkillPlacementPathChecked(pathBase, relPath);
    } catch (error) {
      errors.push(error);
      return null;
    }
  };
  let read: PlacementsScanRead;
  try {
    read = readSkillPlacementsForScan(base, resolvePath);
  } catch (error) {
    getLogger('skill-placements').warn(
      { err: error, path: skillPlacementsPath(base) },
      'skill-placements.json could not be read; skill scans read no recorded roots or sources from it, and in-place skill refreshes keep their prior admission',
    );
    return { kind: 'incomplete', roots: [], sources: {}, error };
  }
  if (read.kind === 'unparsable') {
    return { kind: 'unparsable', roots: [], sources: {}, error: read.error };
  }
  const { store } = read;
  const roots = knownSkillPlacementRoots(base, store, resolvePath);
  const sources = store.sources ?? {};
  return errors.length === 0
    ? { kind: 'complete', roots, sources }
    : { kind: 'incomplete', roots, sources, error: errors[0] };
}

export function readSkillSourceHostPreferences(base: string): Record<string, string> {
  return readSkillPlacementsStore(base).sources ?? {};
}
