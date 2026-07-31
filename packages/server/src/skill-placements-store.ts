/**
 * Persistence boundary for the machine-local skill placement ledger.
 *
 * Both in-place discovery and copy reconciliation consume this module so the
 * JSON shape, fail-soft parsing, and path containment rules have one owner.
 * It deliberately does not import either consumer.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { tracedMkdir } from './fs-traced.ts';
import { TRACED_FS_ADAPTER } from './installed-skills-marker.ts';
import { createKeyedSerializer } from './keyed-serializer.ts';
import { getLogger } from './logger.ts';

const PLACEMENTS_REL = ['.ok', 'local', 'skill-placements.json'] as const;
const SCHEMA_VERSION = 1;

export interface SkillPlacement {
  /** Base-relative bundle dir, e.g. `.windsurf/skills/my-skill`. */
  path: string;
  mode: 'copy' | 'link';
  /** Bundle hash at record time. Absent placements are never auto-refreshed. */
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

/**
 * Resolve a ledger path only when both its lexical path and deepest existing
 * ancestor stay inside the placement base.
 */
export function resolveSkillPlacementPath(base: string, relPath: string): string | null {
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

  let baseReal: string;
  try {
    baseReal = realpathSync(baseAbs);
  } catch {
    return null;
  }
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
  try {
    const ancestorReal = realpathSync(ancestor);
    if (ancestorReal !== baseReal && !ancestorReal.startsWith(`${baseReal}${sep}`)) return null;
  } catch {
    return null;
  }
  return candidate;
}

function emptyStore(): SkillPlacementsStore {
  return { schema: SCHEMA_VERSION, skills: {} };
}

function isPlacement(base: string, value: unknown): value is SkillPlacement {
  if (!value || typeof value !== 'object') return false;
  const placement = value as Partial<SkillPlacement>;
  return (
    typeof placement.path === 'string' &&
    resolveSkillPlacementPath(base, placement.path) !== null &&
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

function parseFolders(base: string, value: unknown): Record<string, FolderExpectation> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries: Array<[string, FolderExpectation]> = [];
  for (const [root, expectation] of Object.entries(value)) {
    if (
      resolveSkillPlacementPath(base, root) === null ||
      !expectation ||
      typeof expectation !== 'object'
    ) {
      continue;
    }
    const candidate = expectation as Partial<FolderExpectation> & { target?: unknown };
    if (candidate.expect === 'own') {
      entries.push([root, { expect: 'own' }]);
    } else if (
      candidate.expect === 'link' &&
      typeof candidate.target === 'string' &&
      resolveSkillPlacementPath(base, candidate.target) !== null
    ) {
      entries.push([root, { expect: 'link', target: candidate.target }]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Read, shape-validate, and containment-filter the ledger. */
export function readSkillPlacementsStore(base: string): SkillPlacementsStore {
  const path = skillPlacementsPath(base);
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return emptyStore();

    const skills: Record<string, SkillPlacement[]> = {};
    if (parsed.skills && typeof parsed.skills === 'object') {
      for (const [name, list] of Object.entries(parsed.skills)) {
        if (!Array.isArray(list)) continue;
        const valid = list.filter((placement) => isPlacement(base, placement));
        if (valid.length > 0) skills[name] = valid;
      }
    }
    const roots = Array.isArray(parsed.roots)
      ? parsed.roots.filter(
          (root): root is string =>
            typeof root === 'string' && resolveSkillPlacementPath(base, root) !== null,
        )
      : [];
    const preferences = parsePreferences(parsed.preferences);
    const sources = parseSources(parsed.sources);
    const folders = parseFolders(base, parsed.folders);
    return {
      schema: SCHEMA_VERSION,
      skills,
      ...(preferences ? { preferences } : {}),
      ...(sources ? { sources } : {}),
      ...(roots.length > 0 ? { roots } : {}),
      ...(folders ? { folders } : {}),
    };
  } catch (err) {
    // Present but unparseable. Continuing with an empty ledger is the deliberate
    // fail-soft, but it silently forgets every recorded placement at once — the
    // operator gets no other signal, and the next write persists the empty
    // ledger over the corrupt one. Matches `readSkillsLockFile`'s handling.
    getLogger('skill-placements').warn(
      { err, path },
      'skill-placements.json is unreadable; continuing with an empty ledger (recorded placements for this project are lost)',
    );
    return emptyStore();
  }
}

/**
 * Serialized read-modify-write of the placements ledger.
 *
 * The whole ledger is one JSON file, so a mutation is read-all → edit → write-all
 * with an await in the middle. Callers routinely fire several at once — converting
 * every location of a skill sends one request per location — and unserialized they
 * all read the same starting file and then overwrite each other, so only the last
 * writer's edit survives. The folder work still succeeds (separate paths, nothing
 * contends), which makes the loss silent: the ledger then disagrees with the disk
 * and every clobbered location reports itself as "changed outside".
 *
 * Mutations chain per ledger path. A failed mutation does not poison the chain,
 * but it is still raised to its own caller.
 */
const serializeLedgerWrite = createKeyedSerializer();

export function mutateSkillPlacementsStore(
  base: string,
  mutate: (store: SkillPlacementsStore) => void,
): Promise<void> {
  return serializeLedgerWrite(skillPlacementsPath(base), async () => {
    const store = readSkillPlacementsStore(base);
    mutate(store);
    await writeSkillPlacementsStore(base, store);
  });
}

async function writeSkillPlacementsStore(base: string, store: SkillPlacementsStore): Promise<void> {
  const path = skillPlacementsPath(base);
  await tracedMkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(store, null, 2)}\n`, {
    fs: TRACED_FS_ADAPTER,
  });
}

/** Safe custom roots declared directly or derived from recorded placements. */
export function readKnownSkillPlacementRoots(base: string): string[] {
  const store = readSkillPlacementsStore(base);
  const roots = new Set(store.roots ?? []);
  for (const list of Object.values(store.skills)) {
    for (const placement of list) {
      const root = placement.path.split('/').slice(0, -1).join('/');
      if (root !== '' && resolveSkillPlacementPath(base, root) !== null) roots.add(root);
    }
  }
  return [...roots].sort();
}

export function readSkillSourceHostPreferences(base: string): Record<string, string> {
  return readSkillPlacementsStore(base).sources ?? {};
}
