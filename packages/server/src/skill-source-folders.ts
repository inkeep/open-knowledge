import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  discoverSkillDirs,
  type FetchedListing,
  fetchSource,
  fetchSourceListing,
  parseSkillDir,
  type SkillLockEntry,
  SkillSubpathNotFoundError,
  type SourceSpec,
} from '@inkeep/open-knowledge-core/skills-catalog';
import {
  pickReimportDir,
  type RecordedFolderUpdate,
  reimportCandidates,
} from './services/skill-reimport.ts';

type SkillDir = { name: string; dir: string };

export function recordsSkillFolder(spec: SourceSpec): boolean {
  return spec.kind === 'git' && !spec.subpath;
}

export function skillFolderWithin(root: string, dir: string): string {
  return relative(root, dir).split(sep).join('/');
}

function usableRecordedSubpath(subpath: string | undefined): string | undefined {
  if (subpath === undefined || /^[A-Za-z]:/.test(subpath)) return undefined;
  const segments = subpath.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && !/[\\\0\r\n]/.test(s))
    ? subpath
    : undefined;
}

export async function fetchPickedFolders(
  listing: FetchedListing,
  pickedDirs: readonly string[],
): Promise<{ dirs: string[]; ref: string | undefined; cleanup: () => void }> {
  if (!listing.fetchFolders || pickedDirs.length === 0) {
    return { dirs: [...pickedDirs], ref: listing.ref, cleanup: () => {} };
  }
  const folders = pickedDirs.map((dir) => skillFolderWithin(listing.dir, dir));
  const content = await listing.fetchFolders([...new Set(folders)]);
  return {
    dirs: folders.map((folder) => join(content.dir, folder)),
    ref: content.ref,
    cleanup: content.cleanup,
  };
}

export interface ReimportWanted {
  readonly name: string;
  readonly entry: SkillLockEntry;
  readonly recordedSkill?: string;
}

export interface ReimportAcquisition {
  readonly dirs: readonly SkillDir[];
  readonly picks: ReadonlyMap<string, { dir: string; folder?: RecordedFolderUpdate }>;
  readonly ref: string | undefined;
  readonly cleanup: () => void;
}

function pickOptions(wanted: ReimportWanted) {
  return {
    ...(wanted.recordedSkill !== undefined ? { recordedSkill: wanted.recordedSkill } : {}),
    localName: wanted.name,
    frontmatterNameOf: (dir: string) => parseSkillDir(dir)?.name,
  };
}

async function fromRecordedFolder(
  spec: SourceSpec & { kind: 'git' },
  wanted: ReimportWanted,
): Promise<ReimportAcquisition | undefined> {
  const subpath = usableRecordedSubpath(wanted.entry.subpath);
  if (subpath === undefined) return undefined;
  let fetched: Awaited<ReturnType<typeof fetchSource>>;
  try {
    fetched = await fetchSource({ ...spec, subpath });
  } catch (e) {
    if (e instanceof SkillSubpathNotFoundError) return undefined;
    throw e;
  }
  try {
    const dirs = discoverSkillDirs(fetched.dir);
    const pick = pickReimportDir(dirs, pickOptions(wanted));
    if (!pick) {
      fetched.cleanup();
      return undefined;
    }
    return {
      dirs,
      picks: new Map([[wanted.name, { dir: pick.dir }]]),
      ref: fetched.ref,
      cleanup: fetched.cleanup,
    };
  } catch (e) {
    fetched.cleanup();
    throw e;
  }
}

export async function acquireReimportSources(
  spec: SourceSpec,
  wanted: readonly ReimportWanted[],
): Promise<ReimportAcquisition> {
  if (spec.kind !== 'git' || spec.subpath) {
    const fetched = await fetchSource(spec);
    try {
      const dirs = discoverSkillDirs(fetched.dir);
      const picks = new Map<string, { dir: string }>();
      for (const want of wanted) {
        const pick = pickReimportDir(dirs, pickOptions(want));
        if (pick) picks.set(want.name, { dir: pick.dir });
      }
      return { dirs, picks, ref: fetched.ref, cleanup: fetched.cleanup };
    } catch (e) {
      fetched.cleanup();
      throw e;
    }
  }
  const single = wanted.length === 1 ? (wanted[0] as ReimportWanted) : undefined;
  const recorded = single ? await fromRecordedFolder(spec, single) : undefined;
  if (recorded) return recorded;

  const listing = await fetchSourceListing(spec);
  try {
    const dirs = discoverSkillDirs(listing.dir);
    const chosen: Array<{ name: string; dir: string; folder?: RecordedFolderUpdate }> = [];
    for (const want of wanted) {
      const recordedFolder = usableRecordedSubpath(want.entry.subpath);
      if (
        recordedFolder !== undefined &&
        existsSync(join(listing.dir, recordedFolder, 'SKILL.md'))
      ) {
        chosen.push({ name: want.name, dir: join(listing.dir, recordedFolder) });
        continue;
      }
      const candidates = reimportCandidates(dirs, pickOptions(want));
      const pick = candidates[0];
      if (!pick) continue;
      const folder = skillFolderWithin(listing.dir, pick.dir);
      const found: RecordedFolderUpdate | undefined =
        candidates.length === 1 && folder !== ''
          ? { kind: 'set', subpath: folder }
          : want.entry.subpath !== undefined
            ? { kind: 'clear' }
            : undefined;
      chosen.push({ name: want.name, dir: pick.dir, ...(found ? { folder: found } : {}) });
    }
    const content = await fetchPickedFolders(
      listing,
      chosen.map((c) => c.dir),
    );
    const picks = new Map(
      chosen.map((c, i) => [
        c.name,
        {
          dir: content.dirs[i] as string,
          ...(c.folder ? { folder: c.folder } : {}),
        },
      ]),
    );
    return {
      dirs,
      picks,
      ref: content.ref,
      cleanup: () => {
        content.cleanup();
        listing.cleanup();
      },
    };
  } catch (e) {
    listing.cleanup();
    throw e;
  }
}
