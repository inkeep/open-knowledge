import { z } from 'zod';
import { OK_DIR } from '../../constants/ok-dir.ts';
import {
  OPENKNOWLEDGE_SKILLS_REPO,
  PACK_SKILL_PREFIX,
  RENAMED_PACK_SKILLS,
} from '../../constants/skills.ts';

export const SKILLS_LOCK_FILENAME = 'skills-lock.json';

export const SKILLS_LOCK_REL = [OK_DIR, SKILLS_LOCK_FILENAME] as const;

export const SKILLS_LOCK_SCHEMA_VERSION = 1;

export const SkillLockEntrySchema = z.looseObject({
  source: z.string(),
  pluginProvider: z.string().optional(),
  skill: z.string().optional(),
  ref: z.string().optional(),
  contentHash: z.string(),
  files: z.array(z.string()).optional(),
  localHash: z.string().optional(),
  baselineRef: z.string().optional(),
  publisher: z.string().optional(),
  importedAt: z.iso.datetime(),
  autoUpdate: z.boolean().optional(),
});
export type SkillLockEntry = z.infer<typeof SkillLockEntrySchema>;

export const SkillsLockSchema = z.looseObject({
  schema: z.literal(SKILLS_LOCK_SCHEMA_VERSION),
  skills: z.record(z.string(), SkillLockEntrySchema).default({}),
});
export type SkillsLock = z.infer<typeof SkillsLockSchema>;

export function emptySkillsLock(): SkillsLock {
  return { schema: SKILLS_LOCK_SCHEMA_VERSION, skills: {} };
}

export function parseSkillsLock(raw: string): SkillsLock | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = SkillsLockSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function upsertLockEntry(lock: SkillsLock, name: string, entry: SkillLockEntry): SkillsLock {
  return { ...lock, skills: { ...lock.skills, [name]: entry } };
}

const RENAMED_PACK_SKILL_NAMES: ReadonlySet<string> = new Set(Object.values(RENAMED_PACK_SKILLS));

export function packMarkerOf(frontmatter: unknown): string | undefined {
  if (typeof frontmatter !== 'object' || frontmatter === null) return undefined;
  const metadata = (frontmatter as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const pack = (metadata as { pack?: unknown }).pack;
  return typeof pack === 'string' && pack.trim().length > 0 ? pack.trim() : undefined;
}

export function retrofitPackLockEntry(
  name: string,
  installedContentHash: string,
  importedAt: string,
  opts?: {
    selfIdentifiesAsPack?: boolean;
  },
): SkillLockEntry | null {
  if (name.startsWith(PACK_SKILL_PREFIX)) {
    return packEntry(name, installedContentHash, importedAt);
  }
  if (!RENAMED_PACK_SKILL_NAMES.has(name) || opts?.selfIdentifiesAsPack !== true) return null;
  return packEntry(name, installedContentHash, importedAt);
}

function packEntry(name: string, contentHash: string, importedAt: string): SkillLockEntry {
  return {
    source: OPENKNOWLEDGE_SKILLS_REPO,
    skill: name,
    contentHash,
    importedAt,
  };
}

export function findByContentHash(lock: SkillsLock, contentHash: string): string | null {
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (entry.contentHash === contentHash) return name;
  }
  return null;
}
