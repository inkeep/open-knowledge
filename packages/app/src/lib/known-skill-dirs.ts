import type { SkillsListEntry } from '@inkeep/open-knowledge-core';

/**
 * The project-scoped bundle dirs OK actually knows to be skills — the data half
 * of the Files/Skills surface decision (`isSkillBundleShapedPath`).
 *
 * Plain module state, not React state, because the predicate that reads it lives
 * in a plain module and answers for tabs that exist before `/api/skills` has
 * landed. It therefore must stay synchronous and total — an empty set means
 * "nothing known yet", never "not a skill", and the shape half answers alone
 * until the list settles.
 *
 * Written by `useSkills` as the list settles; read by `isSkillBundleShapedPath`.
 * One project per renderer (the desktop spawns a BrowserWindow per project and
 * focuses an existing window rather than reusing one — `window-manager.ts`), so
 * module scope cannot leak one project's dirs into another's.
 */
let knownDirs: ReadonlySet<string> = new Set();

/** Bundle dirs of every project-scope skill in a `/api/skills` payload.
 *
 * Three properties of that payload drive the filtering, and all three bite:
 *
 *  - `path` is the SKILL.md FILE, not the bundle dir — so it is `dirname`d.
 *  - GLOBAL rows are home-relative and collide byte-for-byte with project doc
 *    names (`.agents/skills/foo/SKILL.md` is both a real home path and a real
 *    contentDir-relative doc name). `scope` is the ONLY discriminator, so a
 *    global row must never enter this set or it would claim a project document.
 *  - The built-in row is `projectDir`-relative while every other project row is
 *    `contentDir`-relative, so under a configured `content.dir` it is not a
 *    valid doc-name prefix. Built-ins live at dot-roots anyway, where the shape
 *    half already covers them.
 *
 * `canonicalPath` is included alongside `path`: for a symlinked bundle they are
 * the alias and the real contentDir-relative location, and BOTH index as
 * documents.
 */
export function projectSkillBundleDirs(skills: readonly SkillsListEntry[]): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const skill of skills) {
    if (skill.scope !== 'project') continue;
    if (skill.managed === true) continue;
    for (const filePath of [skill.path, skill.canonicalPath]) {
      if (filePath === undefined) continue;
      const slash = filePath.lastIndexOf('/');
      if (slash > 0) dirs.add(filePath.slice(0, slash));
    }
  }
  return dirs;
}

export function getKnownProjectSkillDirs(): ReadonlySet<string> {
  return knownDirs;
}

export function setKnownProjectSkillDirs(next: ReadonlySet<string>): void {
  knownDirs = next;
}

/** Test-only reset — module state outlives a single test file's renders. */
export function __resetKnownProjectSkillDirsForTests(): void {
  knownDirs = new Set();
}
