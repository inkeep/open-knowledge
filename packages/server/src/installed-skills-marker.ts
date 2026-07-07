/**
 * Read/write the per-project installed-skills marker at
 * `<projectDir>/.ok/local/installed-skills.json`.
 *
 * The install verb records here after a successful projection; reclaim
 * re-materializes from it; `delete({skill})` reverse-projects against it; and
 * the CLI's `getOkArtifactPaths` reads it (via core's `parseInstalledSkills`)
 * to make the sharing-mode exclude skill-aware. Schema + parse live in core so
 * the CLI reader and this server writer validate identically.
 *
 * Per-machine runtime state under `.ok/local/` (gitignored) — atomic write via
 * tmp + rename through the traced fs primitives so disk writes show as `fs.*`
 * spans. Reads are fail-soft (absent / corrupt → empty marker) so a bad file
 * never breaks reclaim or sharing-mode.
 */

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

/** Routes core's atomic write through the server's traced fs primitives. */
const TRACED_FS_ADAPTER = {
  writeFile: (path: string, content: string, opts: { encoding: 'utf-8'; mode?: number }) =>
    tracedWriteFile(path, content, opts),
  rename: (from: string, to: string) => tracedRename(from, to),
};

/** Absolute path to the marker for a project. */
export function installedSkillsPath(projectDir: string): string {
  return join(projectDir, ...INSTALLED_SKILLS_REL);
}

/**
 * Serialize read-modify-write of one project's marker. `recordSkillInstall` /
 * `removeSkillInstall` each read the whole marker, merge one entry, and rewrite
 * — two concurrent calls (e.g. parallel MCP installs of different skills) would
 * otherwise read the same snapshot and the second write would clobber the
 * first's entry. The server is single-per-contentDir (server.lock), so an
 * in-process promise chain keyed by marker path is sufficient.
 */
const markerWriteChains = new Map<string, Promise<unknown>>();
function withMarkerLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const key = installedSkillsPath(projectDir);
  const prior = markerWriteChains.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Tail swallows errors so one failed write doesn't poison the chain for the
  // next caller (the failure still rejects the `run` returned to this caller).
  markerWriteChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Read + validate the marker. Fail-soft: an absent or corrupt file resolves to
 * a fresh empty marker rather than throwing — a bad marker means "nothing
 * recorded as installed", never a hard error in reclaim / sharing-mode.
 */
export function readInstalledSkills(projectDir: string): InstalledSkills {
  const path = installedSkillsPath(projectDir);
  if (!existsSync(path)) return emptyInstalledSkills();
  try {
    return parseInstalledSkills(readFileSync(path, 'utf-8')) ?? emptyInstalledSkills();
  } catch (err) {
    // Fail-soft, but leave a breadcrumb — a silently-empty marker can mask a
    // corrupt file that makes installed skills "disappear" from reclaim.
    logger.warn({ err, path }, 'installed-skills marker unreadable');
    return emptyInstalledSkills();
  }
}

/** Validate then atomically write the marker. Refuses to persist a malformed doc. */
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

/** Record (create or overwrite) one skill's install entry. */
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

/**
 * Remove one skill's install entry. Returns the removed entry (so the caller
 * can reverse-project from exactly the hosts it was installed to), or `null`
 * when the skill was not recorded as installed.
 */
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
