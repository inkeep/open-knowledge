import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  emptyInstalledSkills,
  INSTALLED_SKILLS_REL,
  type InstalledSkillEntry,
  type InstalledSkills,
  InstalledSkillsSchema,
  parseInstalledSkills,
} from '@inkeep/open-knowledge-core';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { createKeyedSerializer } from './keyed-serializer.ts';
import { getLogger } from './logger.ts';

const logger = getLogger('installed-skills-marker');

export function installedSkillsPath(projectDir: string): string {
  return join(projectDir, ...INSTALLED_SKILLS_REL);
}

const serializeMarkerWrite = createKeyedSerializer();
function withMarkerLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return serializeMarkerWrite(installedSkillsPath(projectDir), fn);
}

export function readInstalledSkills(projectDir: string): InstalledSkills {
  const path = installedSkillsPath(projectDir);
  if (!existsSync(path)) return emptyInstalledSkills();
  try {
    return parseInstalledSkills(readFileSync(path, 'utf-8')) ?? emptyInstalledSkills();
  } catch (err) {
    logger.warn({ err, path }, 'installed-skills marker unreadable');
    return emptyInstalledSkills();
  }
}

type MarkerRead =
  | { ok: true; state: InstalledSkills }
  | { ok: false; reason: string; cause?: unknown };

function readInstalledSkillsForMutation(projectDir: string): MarkerRead {
  const path = installedSkillsPath(projectDir);
  if (!existsSync(path)) return { ok: true, state: emptyInstalledSkills() };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { ok: true, state: emptyInstalledSkills() };
    return {
      ok: false,
      reason: code ? `it could not be read (${code})` : 'it could not be read',
      cause: err,
    };
  }
  const parsed = parseInstalledSkills(raw);
  if (parsed === null) {
    return {
      ok: false,
      reason: 'its contents are not an installed-skills marker this server understands',
    };
  }
  return { ok: true, state: parsed };
}

function requireMutableInstalledSkills(projectDir: string): InstalledSkills {
  const read = readInstalledSkillsForMutation(projectDir);
  if (read.ok) return read.state;
  const path = installedSkillsPath(projectDir);
  logger.error(
    { path, reason: read.reason, err: read.cause },
    'refusing to rewrite the installed-skills marker because it could not be read — rewriting it would replace every install it records with this one',
  );
  throw new Error(`Refusing to rewrite ${path}: ${read.reason}`);
}

async function writeInstalledSkills(projectDir: string, state: InstalledSkills): Promise<void> {
  const parsed = InstalledSkillsSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(
      `Refusing to write invalid installed-skills marker: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const path = installedSkillsPath(projectDir);
  await tracedMkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`, { fs: tracedAtomicFs });
}

export async function recordSkillInstall(
  projectDir: string,
  name: string,
  entry: InstalledSkillEntry,
): Promise<void> {
  return withMarkerLock(projectDir, async () => {
    const state = requireMutableInstalledSkills(projectDir);
    await writeInstalledSkills(projectDir, {
      ...state,
      skills: { ...state.skills, [name]: entry },
    });
  });
}

export async function removeSkillInstall(
  projectDir: string,
  name: string,
): Promise<InstalledSkillEntry | null> {
  return withMarkerLock(projectDir, async () => {
    const state = requireMutableInstalledSkills(projectDir);
    const removed = state.skills[name] ?? null;
    if (removed === null) return null;
    const { [name]: _dropped, ...rest } = state.skills;
    await writeInstalledSkills(projectDir, { ...state, skills: rest });
    return removed;
  });
}
