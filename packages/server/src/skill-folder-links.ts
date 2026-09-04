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
      return { host: editor, root, state: 'absent' as const };
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
  | { ok: false; reason: 'not-permitted'; roots: string[] }
  | { ok: false; reason: 'conflicts'; conflicts: string[] }
  | { ok: false; reason: 'stray-entries'; strays: string[] }
  | { ok: false; reason: 'not-linkable' }
  | { ok: false; reason: 'not-linked' }
  | { ok: false; reason: 'partial-move'; moved: string[]; error?: string };

const BENIGN_DOTFILES = new Set([
  '.DS_Store',
  '.localized',
  'Thumbs.db',
  '.gitignore',
  '.gitkeep',
  '.gitattributes',
]);

function bundleNames(rootAbs: string): { bundles: string[]; strays: string[]; ignored: string[] } {
  const bundles: string[] = [];
  const strays: string[] = [];
  const ignored: string[] = [];
  for (const e of readdirSync(rootAbs, { withFileTypes: true })) {
    if (BENIGN_DOTFILES.has(e.name)) continue;
    if (e.name.startsWith('.')) {
      ignored.push(e.name);
      continue;
    }
    const p = join(rootAbs, e.name);
    if (existsSync(join(p, 'SKILL.md'))) {
      bundles.push(e.name);
      continue;
    }
    if (e.isSymbolicLink() && !existsSync(p)) {
      ignored.push(e.name);
      continue;
    }
    if (e.isDirectory() && isEmptyDir(p)) continue;
    strays.push(e.name);
  }
  return { bundles, strays, ignored };
}

function isEmptyDir(dirAbs: string): boolean {
  try {
    return readdirSync(dirAbs).length === 0;
  } catch {
    return false;
  }
}

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
  | { kind: 'absent' }
  | { kind: 'not-linkable' }
  | { kind: 'stray-entries'; strays: string[] }
  | { kind: 'conflicts'; conflicts: string[] }
  | { kind: 'not-permitted'; roots: string[] };

export function previewEditorFolderLink(opts: {
  base: string;
  folderRel: string;
  targetRootRel: string;
  mayCreate: (rootRel: string) => boolean;
}): FolderLinkPreview {
  const { base, folderRel, targetRootRel, mayCreate } = opts;
  const folderAbs = join(base, folderRel);
  const targetAbs = join(base, targetRootRel);
  const wouldCreate = [targetRootRel, folderRel].filter(
    (rel) => !existsSync(join(base, rel)) && !mayCreate(rel),
  );
  if (wouldCreate.length > 0) return { kind: 'not-permitted', roots: wouldCreate };
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(folderAbs);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isSymbolicLink()) return { kind: 'not-linkable' };
  if (!st.isDirectory()) return { kind: 'not-linkable' };
  try {
    if (realpathSync(folderAbs) === realpathSync(targetAbs)) return { kind: 'not-linkable' };
  } catch {}
  const { bundles, strays, ignored } = bundleNames(folderAbs);
  if (strays.length > 0) return { kind: 'stray-entries', strays };
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
      } catch {}
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
    let destIsLink = false;
    try {
      destIsLink = lstatSync(destDir).isSymbolicLink();
    } catch {}
    if (destIsLink) {
      destLinks.push(name);
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

export function linkEditorSkillFolder(opts: {
  base: string;
  folderRel: string;
  targetRootRel: string;
  mayCreate: (rootRel: string) => boolean;
}): FolderLinkResult {
  const { base, folderRel, targetRootRel, mayCreate } = opts;
  const folderAbs = join(base, folderRel);
  const targetAbs = join(base, targetRootRel);
  const preview = previewEditorFolderLink({ base, folderRel, targetRootRel, mayCreate });
  if (preview.kind === 'not-permitted')
    return { ok: false, reason: 'not-permitted', roots: preview.roots };
  if (preview.kind === 'absent') {
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

export function unlinkEditorSkillFolder(opts: {
  base: string;
  folderRel: string;
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
    tracedRmSync(folderAbs, { force: true });
    tracedMkdirSync(folderAbs, { recursive: true });
    return { ok: true, moved: [], dropped: [], linked: [] };
  }
  const { bundles } = bundleNames(targetAbs);
  tracedRmSync(folderAbs, { force: true });
  tracedMkdirSync(folderAbs, { recursive: true });
  const folderReal = realpathSync(folderAbs);
  const linked: string[] = [];
  for (const name of bundles) {
    if (excluded.has(name)) continue;
    tracedSymlinkSync(relative(folderReal, join(targetAbs, name)), join(folderAbs, name), 'dir');
    linked.push(name);
  }
  return { ok: true, moved: [], dropped: [], linked };
}
