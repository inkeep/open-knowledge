/**
 * Folder-level skill-root verbs:
 *
 *  - LINK: an editor's own skills folder merges into a target root, then the
 *    folder becomes a symlink to that root ("follow the root"). Merge is
 *    conflict-safe: same-hash bundles drop (redundant bytes), own-only bundles
 *    MOVE into the target, differing bundles ABORT the whole operation with a
 *    list — nothing is written on abort.
 *  - UNLINK: a linked folder materializes back into a real folder holding a
 *    per-skill SYMLINK for every bundle the target root exposes — lossless and
 *    behavior-preserving (each skill's menu can convert links to copies from
 *    there).
 *
 * Both verbs refuse to touch anything that isn't exactly what they expect
 * (stray files, unexpected link targets) — fail-loud beats a clever guess.
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { tracedMkdirSync, tracedRenameSync, tracedRmSync, tracedSymlinkSync } from './fs-traced.ts';

export interface SkillFolderState {
  host: string;
  root: string;
  state: 'own' | 'linked' | 'linked-parent' | 'absent';
  target?: string;
}

/**
 * Observable folder state per host skills root: `own` (real folder), `linked`
 * (the folder itself is a symlink → `target`), `linked-parent` (a parent dir
 * is the symlink — report-only; the parent is what's linked), `absent`.
 */
export function scanSkillFolderStates(
  base: string,
  roots: ReadonlyArray<{ editor: string; root: string }>,
): SkillFolderState[] {
  let baseReal: string;
  try {
    baseReal = realpathSync(base);
  } catch {
    return roots.map(({ editor, root }) => ({ host: editor, root, state: 'absent' as const }));
  }
  const relTo = (abs: string): string | undefined =>
    abs.startsWith(`${baseReal}/`) ? abs.slice(baseReal.length + 1) : undefined;
  return roots.map(({ editor, root }) => {
    const abs = join(base, root);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      return { host: editor, root, state: 'absent' as const };
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return { host: editor, root, state: 'absent' as const }; // dangling link
    }
    if (st.isSymbolicLink()) {
      const target = relTo(real);
      return { host: editor, root, state: 'linked' as const, ...(target ? { target } : {}) };
    }
    if (real !== join(baseReal, root)) {
      const target = relTo(real);
      return {
        host: editor,
        root,
        state: 'linked-parent' as const,
        ...(target ? { target } : {}),
      };
    }
    return { host: editor, root, state: 'own' as const };
  });
}

export type FolderLinkResult =
  | { ok: true; moved: string[]; dropped: string[]; linked: string[] }
  | {
      ok: false;
      reason: 'conflicts' | 'not-linkable' | 'not-linked' | 'stray-entries' | 'partial-move';
      conflicts?: string[];
      strays?: string[];
      /** partial-move: bundles moved before the failure — each move is a
       *  complete rename, so RE-RUNNING the link resumes and completes. */
      moved?: string[];
      error?: string;
    };

/** OS / VCS noise that must not block a LINK. macOS Finder drops `.DS_Store`
 *  into any browsed directory, so treating every dotfile as a stray would
 *  permanently block LINK for a developer who opened `.claude/skills/` in
 *  Finder. These are ignored (neither bundle nor stray); other dotfiles stay
 *  strays so genuinely unexpected hidden content still trips the guard.
 *
 *  `.git` is deliberately NOT here. A link deletes the folder it consumes, so
 *  a skills folder that is itself a clone loses its history — the one loss in
 *  this set that can't be undone. Leaving it out routes it through the
 *  dot-entry branch below, where it gets disclosed before the write. */
const BENIGN_DOTFILES = new Set([
  '.DS_Store',
  '.localized',
  'Thumbs.db',
  '.gitignore',
  '.gitkeep',
  '.gitattributes',
]);

/** Bundle dir names (entries containing a SKILL.md) directly under `root`.
 *  `ignored` are the entries a LINK neither moves nor treats as strays — they
 *  go away with the folder, so callers can disclose that before writing. */
function bundleNames(rootAbs: string): { bundles: string[]; strays: string[]; ignored: string[] } {
  const bundles: string[] = [];
  const strays: string[] = [];
  const ignored: string[] = [];
  for (const e of readdirSync(rootAbs, { withFileTypes: true })) {
    if (BENIGN_DOTFILES.has(e.name)) continue;
    // A skill dir name can't begin with a dot, so a dot-entry here is the
    // HARNESS's own bookkeeping in its own folder — Codex keeps its bundled
    // skills under `.system`. Treating those as strays meant a harness that
    // writes anything beside your skills could never have its folder linked,
    // which is not a state the user can clean up.
    if (e.name.startsWith('.')) {
      ignored.push(e.name);
      continue;
    }
    const p = join(rootAbs, e.name);
    if (existsSync(join(p, 'SKILL.md'))) {
      bundles.push(e.name);
      continue;
    }
    // An EMPTY directory holds nothing a link could strand (harness leftovers
    // like `codex-primary-runtime`). A directory with contents but no SKILL.md
    // is real content and still blocks.
    if (e.isDirectory() && isEmptyDir(p)) continue;
    strays.push(e.name);
  }
  return { bundles, strays, ignored };
}

/** True when `dirAbs` has no entries. Unreadable counts as non-empty: a folder
 *  we can't inspect is not one we can promise a link won't strand. */
function isEmptyDir(dirAbs: string): boolean {
  try {
    return readdirSync(dirAbs).length === 0;
  } catch {
    return false;
  }
}

/** What a LINK would do. `toDrop` and `removes` are deletions from the folder
 *  being consumed; `removes` are the entries no bundle move covers — they go
 *  away when the folder is replaced by the symlink. `liveDestLinks` is the one
 *  deletion on the OTHER side: a per-skill delivery link in the target that the
 *  merge overwrites, so that skill stops following the root it came from. */
interface FolderLinkPlan {
  toMove: string[];
  toDrop: string[];
  destLinks: string[];
  liveDestLinks: string[];
  linkedBundlesToMove: Array<{ name: string; target: string }>;
  removes: string[];
}

export type FolderLinkPreview =
  | { kind: 'plan'; plan: FolderLinkPlan }
  /** Nothing to merge — the link is a bare symlink creation. */
  | { kind: 'absent' }
  | { kind: 'not-linkable' }
  | { kind: 'stray-entries'; strays: string[] }
  | { kind: 'conflicts'; conflicts: string[] };

/**
 * Classify what `linkEditorSkillFolder` would do, WITHOUT writing anything.
 * The link runs this first and applies the plan, so a caller can disclose the
 * exact moves and deletions before asking for them.
 */
export function previewEditorFolderLink(opts: {
  base: string;
  folderRel: string;
  targetRootRel: string;
}): FolderLinkPreview {
  const { base, folderRel, targetRootRel } = opts;
  const folderAbs = join(base, folderRel);
  const targetAbs = join(base, targetRootRel);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(folderAbs);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isSymbolicLink()) return { kind: 'not-linkable' }; // already a link
  if (!st.isDirectory()) return { kind: 'not-linkable' };
  try {
    if (realpathSync(folderAbs) === realpathSync(targetAbs)) return { kind: 'not-linkable' }; // same physical dir (parent alias)
  } catch {
    // target absent — created by the link
  }
  const { bundles, strays, ignored } = bundleNames(folderAbs);
  if (strays.length > 0) return { kind: 'stray-entries', strays };
  // Classify EVERYTHING before touching anything (abort must be a no-op).
  const conflicts: string[] = [];
  const toMove: string[] = [];
  const toDrop: string[] = [];
  const destLinks: string[] = [];
  const liveDestLinks: string[] = [];
  const linkedBundlesToMove: Array<{ name: string; target: string }> = [];
  for (const name of bundles) {
    const ownDir = join(folderAbs, name);
    const destDir = join(targetAbs, name);
    if (lstatSync(ownDir).isSymbolicLink()) {
      const ownTarget = realpathSync(ownDir);
      let destTarget: string | null = null;
      let destIsLink = false;
      try {
        destIsLink = lstatSync(destDir).isSymbolicLink();
        destTarget = realpathSync(destDir);
      } catch {
        // An absent or dangling destination can be replaced below.
      }
      if (destTarget === ownTarget) {
        toDrop.push(name);
      } else if (destTarget !== null) {
        conflicts.push(name);
      } else {
        if (destIsLink) destLinks.push(name);
        linkedBundlesToMove.push({ name, target: ownTarget });
      }
      continue;
    }
    // lstat the DEST: a symlink there (live OR dangling) is a stale pointer,
    // not content — remove before the move. `existsSync` alone misclassified
    // a DANGLING dest link as absent, and `rename(dir → symlink)` ENOTDIRs.
    let destIsLink = false;
    try {
      destIsLink = lstatSync(destDir).isSymbolicLink();
    } catch {
      /* truly absent */
    }
    if (destIsLink) {
      destLinks.push(name);
      // A link that still RESOLVES is a working delivery this merge overwrites
      // — the one thing a link destroys outside the folder it consumes, so it
      // needs saying. A dangling one points at nothing and is pure cleanup.
      if (existsSync(destDir)) liveDestLinks.push(name);
      toMove.push(name);
      continue;
    }
    if (!existsSync(destDir)) {
      toMove.push(name);
      continue;
    }
    const ownHash = parseSkillDir(ownDir)?.contentHash;
    const destHash = parseSkillDir(destDir)?.contentHash;
    if (ownHash !== undefined && ownHash === destHash) toDrop.push(name);
    else conflicts.push(name);
  }
  if (conflicts.length > 0) return { kind: 'conflicts', conflicts };
  return {
    kind: 'plan',
    plan: { toMove, toDrop, destLinks, liveDestLinks, linkedBundlesToMove, removes: ignored },
  };
}

/**
 * Merge-then-swap: `folderRel` (an editor's own skills folder under `base`)
 * merges into `targetRootRel` and becomes a symlink to it.
 */
export function linkEditorSkillFolder(opts: {
  base: string;
  folderRel: string;
  targetRootRel: string;
}): FolderLinkResult {
  const { base, folderRel, targetRootRel } = opts;
  const folderAbs = join(base, folderRel);
  const targetAbs = join(base, targetRootRel);
  const preview = previewEditorFolderLink({ base, folderRel, targetRootRel });
  if (preview.kind === 'absent') {
    // Absent folder: nothing to merge — create the link directly.
    tracedMkdirSync(dirname(folderAbs), { recursive: true });
    tracedMkdirSync(targetAbs, { recursive: true });
    tracedSymlinkSync(relative(dirname(folderAbs), targetAbs), folderAbs, 'dir');
    return { ok: true, moved: [], dropped: [], linked: [folderRel] };
  }
  if (preview.kind === 'not-linkable') return { ok: false, reason: 'not-linkable' };
  if (preview.kind === 'stray-entries')
    return { ok: false, reason: 'stray-entries', strays: preview.strays };
  if (preview.kind === 'conflicts')
    return { ok: false, reason: 'conflicts', conflicts: preview.conflicts };
  const { toMove, toDrop, destLinks, linkedBundlesToMove } = preview.plan;
  // Apply. Each move is a complete per-bundle rename, so a failure
  // midway leaves a RESUMABLE half-merge (already-moved bundles classify as
  // same-hash/absent on the next run) — report it structurally, never a bare
  // throw: the caller tells the user to re-run the link.
  const movedSoFar: string[] = [];
  try {
    tracedMkdirSync(targetAbs, { recursive: true });
    const targetRootReal = realpathSync(targetAbs);
    for (const name of destLinks) tracedRmSync(join(targetAbs, name), { force: true });
    for (const { name, target } of linkedBundlesToMove) {
      const destDir = join(targetAbs, name);
      tracedSymlinkSync(relative(targetRootReal, target), destDir, 'dir');
      tracedRmSync(join(folderAbs, name), { force: true });
      movedSoFar.push(name);
    }
    for (const name of toMove) {
      tracedRenameSync(join(folderAbs, name), join(targetAbs, name));
      movedSoFar.push(name);
    }
    for (const name of toDrop)
      tracedRmSync(join(folderAbs, name), { recursive: true, force: true });
    tracedRmSync(folderAbs, { recursive: true, force: true });
    tracedSymlinkSync(relative(dirname(folderAbs), targetAbs), folderAbs, 'dir');
  } catch (e) {
    return {
      ok: false,
      reason: 'partial-move',
      moved: movedSoFar,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  return {
    ok: true,
    moved: [...linkedBundlesToMove.map(({ name }) => name), ...toMove],
    dropped: toDrop,
    linked: [folderRel],
  };
}

/**
 * Materialize a linked folder back into a real folder of per-skill symlinks —
 * every bundle the target exposed stays reachable at the same path, each now
 * individually managed (the per-skill menus take over from here).
 */
export function unlinkEditorSkillFolder(opts: {
  base: string;
  folderRel: string;
  /** Skill names to LEAVE OUT of the materialized per-skill links — the
   *  "this agent shouldn't get that skill" remedy: the folder stops following
   *  its target root and keeps everything it sees today except these. */
  exclude?: readonly string[];
}): FolderLinkResult {
  const { base, folderRel } = opts;
  const excluded = new Set(opts.exclude ?? []);
  const folderAbs = join(base, folderRel);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(folderAbs);
  } catch {
    return { ok: false, reason: 'not-linked' };
  }
  if (!st.isSymbolicLink()) return { ok: false, reason: 'not-linked' };
  let targetAbs: string;
  try {
    targetAbs = realpathSync(folderAbs);
  } catch {
    // Dangling link: removing it and leaving an empty real folder is the only
    // lossless materialization.
    tracedRmSync(folderAbs, { force: true });
    tracedMkdirSync(folderAbs, { recursive: true });
    return { ok: true, moved: [], dropped: [], linked: [] };
  }
  const { bundles } = bundleNames(targetAbs);
  tracedRmSync(folderAbs, { force: true });
  tracedMkdirSync(folderAbs, { recursive: true });
  // Both ends realpath'd before computing relative link targets — a symlinked
  // ancestor on either side (e.g. macOS /var → /private/var) would otherwise
  // yield dangling links.
  const folderReal = realpathSync(folderAbs);
  const linked: string[] = [];
  for (const name of bundles) {
    if (excluded.has(name)) continue;
    tracedSymlinkSync(relative(folderReal, join(targetAbs, name)), join(folderAbs, name), 'dir');
    linked.push(name);
  }
  return { ok: true, moved: [], dropped: [], linked };
}
