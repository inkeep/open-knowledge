import type { SkillsListEntry } from '@inkeep/open-knowledge-core';

/**
 * The project-scoped bundle dirs OK actually knows to be skills — the data half
 * of the Files/Skills surface decision (`isSkillBundleShapedPath`).
 *
 * Plain module state, not React state, because the predicates that read it run
 * OUTSIDE render: `isSkillTabId` is reached from the `useState` initializer that
 * parses the persisted tab session on first paint, before any fetch has
 * happened. The predicates therefore must stay synchronous and total — an empty
 * set means "nothing known yet", never "not a skill", and the shape half answers
 * alone until `/api/skills` lands.
 *
 * Written by `useSkills` as the list settles; read by the surface predicates.
 * One project per renderer (the desktop spawns a BrowserWindow per project and
 * focuses an existing window rather than reusing one — `window-manager.ts`), so
 * module scope cannot leak one project's dirs into another's.
 */
let knownDirs: ReadonlySet<string> = new Set();

/**
 * Has `/api/skills` answered at least once this session?
 *
 * An empty `knownDirs` is ambiguous on its own: it means "no project skills"
 * AND "the list has not landed yet", and the two demand opposite handling at
 * the one place that writes DURABLE state. The tab-session parse runs on first
 * paint, synchronously off localStorage, while the list is a network round trip
 * away — so a doc whose only evidence is the list classifies as Files there. If
 * the parse acted on that, it would drop the remembered Skills tab and the
 * persist effect would write the guess back out, making a timing artifact
 * permanent. This flag lets that one call site stay lossless until the answer is
 * real, without weakening the guard for projects that legitimately have none.
 */
let settled = false;

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

export function knownSkillDirsSettled(): boolean {
  return settled;
}

export function setKnownProjectSkillDirs(next: ReadonlySet<string>): void {
  knownDirs = next;
  settled = true;
}

/** Test-only reset — module state outlives a single test file's renders. */
export function __resetKnownProjectSkillDirsForTests(): void {
  knownDirs = new Set();
  settled = false;
}
