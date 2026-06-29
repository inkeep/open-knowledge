
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
import { tracedMkdir, tracedRename, tracedWriteFile } from './fs-traced.ts';
import { getLogger } from './logger.ts';

const logger = getLogger('installed-skills-marker');

const TRACED_FS_ADAPTER = {
  writeFile: (path: string, content: string, opts: { encoding: 'utf-8'; mode?: number }) =>
    tracedWriteFile(path, content, opts),
  rename: (from: string, to: string) => tracedRename(from, to),
};

export function installedSkillsPath(projectDir: string): string {
  return join(projectDir, ...INSTALLED_SKILLS_REL);
}

const markerWriteChains = new Map<string, Promise<unknown>>();
function withMarkerLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const key = installedSkillsPath(projectDir);
  const prior = markerWriteChains.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  markerWriteChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
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
  await atomicWriteFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`, {
    fs: TRACED_FS_ADAPTER,
  });
}

export async function recordSkillInstall(
  projectDir: string,
  name: string,
  entry: InstalledSkillEntry,
): Promise<void> {
  return withMarkerLock(projectDir, async () => {
    const state = readInstalledSkills(projectDir);
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
    const state = readInstalledSkills(projectDir);
    const removed = state.skills[name] ?? null;
    if (removed === null) return null;
    const { [name]: _dropped, ...rest } = state.skills;
    await writeInstalledSkills(projectDir, { ...state, skills: rest });
    return removed;
  });
}
