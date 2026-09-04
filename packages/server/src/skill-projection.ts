import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  containsXmlTag,
  EDITOR_PROJECT_CONFIG_PATH,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
  RENAMED_PACK_SKILLS,
} from '@inkeep/open-knowledge-core';
import type { SkillHostId } from '@inkeep/open-knowledge-core/skills-catalog';
import { parse as parseYaml } from 'yaml';
import {
  tracedCpSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmSync,
  tracedSymlinkSync,
} from './fs-traced.ts';
import { isInternalBundleSkillName } from './skill-bundles.ts';
import { inspectSkillPathEntry } from './skill-path-entry.ts';

export function resolvedHosts(hosts: readonly string[]): EditorId[] {
  const valid = PROJECT_SKILL_EDITOR_IDS as readonly string[];
  return hosts.filter((h): h is EditorId => valid.includes(h));
}

const RESERVED_SKILL_PREFIX = 'open-knowledge';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const CONFLICT_MARKER_RES = [/^<{7} /m, /^={7}$/m, /^>{7} /m];

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  try {
    const parsed = parseYaml(m[1] ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface SkillValidity {
  ok: boolean;
  errors: string[];
  warnings: string[];
  hasScripts: boolean;
}

export function validateSkillForInstall(
  skillDir: string,
  name: string,
  opts?: { allowReservedName?: boolean },
): SkillValidity {
  const errors: string[] = [];
  const warnings: string[] = [];
  const skillMd = join(skillDir, 'SKILL.md');
  const hasScripts =
    existsSync(join(skillDir, 'scripts')) && statSync(join(skillDir, 'scripts')).isDirectory();

  const usesReservedName =
    name.startsWith(RESERVED_SKILL_PREFIX) && RENAMED_PACK_SKILLS[name] === undefined;
  if (!opts?.allowReservedName && usesReservedName) {
    errors.push(
      `"${name}" uses the reserved \`${RESERVED_SKILL_PREFIX}*\` prefix (reserved for OK's shipped skills) — choose another name.`,
    );
  }
  if (!existsSync(skillMd)) {
    errors.push(`No SKILL.md found at ${skillDir}.`);
    return { ok: errors.length === 0, errors, warnings, hasScripts };
  }
  let raw: string;
  try {
    raw = readFileSync(skillMd, 'utf-8');
  } catch (e) {
    errors.push(`Cannot read SKILL.md: ${(e as Error).message}.`);
    return { ok: false, errors, warnings, hasScripts };
  }
  if (CONFLICT_MARKER_RES.some((re) => re.test(raw))) {
    errors.push(
      'SKILL.md contains git conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`). Resolve the conflict before installing.',
    );
  }
  const fm = parseFrontmatter(raw);
  if (fm === null) {
    errors.push('SKILL.md has no valid `---` frontmatter block (name + description required).');
  } else {
    const fmName = fm.name;
    const fmDesc = fm.description;
    if (typeof fmName !== 'string' || fmName.length === 0) {
      errors.push('SKILL.md frontmatter.name is missing or empty.');
    } else if (fmName !== name) {
      errors.push(
        `SKILL.md frontmatter.name ("${fmName}") must equal the skill directory ("${name}").`,
      );
    }
    if (typeof fmDesc !== 'string' || fmDesc.length === 0) {
      warnings.push('This skill has no `description`. Add one so agents know when to use it.');
    }
    if (
      (typeof fmName === 'string' && containsXmlTag(fmName)) ||
      (typeof fmDesc === 'string' && containsXmlTag(fmDesc))
    ) {
      errors.push(
        'SKILL.md name/description contains XML tags (`<...>`), which break the skill loader.',
      );
    }
  }
  return { ok: errors.length === 0, errors, warnings, hasScripts };
}

function detectProjectConfiguredTargets(cwd: string): EditorId[] {
  return PROJECT_SKILL_EDITOR_IDS.filter((id) => {
    const rel = EDITOR_PROJECT_CONFIG_PATH[id];
    return rel !== null && existsSync(resolve(cwd, rel));
  });
}

export function resolveSkillTargets(cwd: string, explicit?: readonly string[]): EditorId[] {
  if (explicit && explicit.length > 0) {
    const valid = new Set<string>(PROJECT_SKILL_EDITOR_IDS);
    return explicit.filter((id): id is EditorId => valid.has(id));
  }
  return detectProjectConfiguredTargets(cwd);
}

export type SkillProjectionRoots = Record<EditorId, string | null>;
export function skillProjectionRoots(scope: 'project' | 'global'): SkillProjectionRoots {
  return scope === 'global' ? EDITOR_USER_SKILL_ROOT : EDITOR_PROJECT_SKILL_ROOT;
}

export function skillHostDir(
  cwd: string,
  editor: EditorId,
  name: string,
  roots: SkillProjectionRoots = EDITOR_PROJECT_SKILL_ROOT,
): string | null {
  const root = roots[editor];
  return root === null ? null : resolve(cwd, root, name);
}

function skillTargetDir(
  cwd: string,
  target: SkillHostId,
  name: string,
  roots: SkillProjectionRoots = EDITOR_PROJECT_SKILL_ROOT,
): string | null {
  if (target === 'agents') return resolve(cwd, AGENTS_SKILLS_ROOT, name);
  return skillHostDir(cwd, target, name, roots);
}

export function hostSkillsRootEscapes(cwd: string, hostRoot: string): boolean {
  if (!existsSync(hostRoot)) return false;
  try {
    const rel = relative(realpathSync(cwd), realpathSync(hostRoot));
    return rel.startsWith('..') || isAbsolute(rel);
  } catch {
    return true;
  }
}

function isAliasOfCanonicalRoot(hostRoot: string, canonicalRoot: string): boolean {
  if (!existsSync(hostRoot) || !existsSync(canonicalRoot)) return false;
  try {
    return realpathSync(hostRoot) === realpathSync(canonicalRoot);
  } catch {
    return false;
  }
}

function skillLinkTarget(cwd: string, hostRoot: string, skillDir: string): string {
  const absSkill = resolve(skillDir);
  const fromCwd = relative(resolve(cwd), absSkill);
  const insideProject = fromCwd !== '' && !fromCwd.startsWith('..') && !isAbsolute(fromCwd);
  return insideProject ? relative(hostRoot, absSkill) : absSkill;
}

export function projectSkill(
  skillDir: string,
  name: string,
  cwd: string,
  targets: readonly EditorId[],
  mode: 'symlink' | 'copy' = 'symlink',
  roots: SkillProjectionRoots = EDITOR_PROJECT_SKILL_ROOT,
): EditorId[] {
  const written: EditorId[] = [];
  for (const editor of targets) {
    const dest = skillHostDir(cwd, editor, name, roots);
    if (dest === null) continue;
    const hostRoot = dirname(dest);
    if (hostSkillsRootEscapes(cwd, hostRoot)) continue;
    if (isAliasOfCanonicalRoot(hostRoot, dirname(skillDir))) {
      written.push(editor);
      continue;
    }
    let sameEntry = resolve(dest) === resolve(skillDir);
    if (!sameEntry && existsSync(dest)) {
      try {
        sameEntry = realpathSync(dest) === realpathSync(skillDir);
      } catch {
        sameEntry = false;
      }
    }
    if (sameEntry) {
      written.push(editor);
      continue;
    }
    tracedRmSync(dest, { recursive: true, force: true });
    tracedMkdirSync(hostRoot, { recursive: true });
    if (mode === 'copy') {
      tracedCpSync(skillDir, dest, { recursive: true, dereference: true });
    } else {
      tracedSymlinkSync(skillLinkTarget(cwd, hostRoot, skillDir), dest, 'dir');
    }
    written.push(editor);
  }
  return written;
}

function isStaleBundleProjection(dest: string, name: string): boolean {
  if (!isInternalBundleSkillName(name)) return false;
  try {
    if (lstatSync(dest).isSymbolicLink()) return false;
    return existsSync(join(dest, 'SKILL.md'));
  } catch {
    return false;
  }
}

export function classifyInPlaceDest(
  dest: string,
  canonicalAbs: string,
  canonicalHash: string,
): 'absent' | 'canonical-dir' | 'link-to-canonical' | 'link' | 'same-copy' | 'different' {
  const entry = inspectSkillPathEntry(dest, canonicalAbs, canonicalHash);
  switch (entry.kind) {
    case 'absent':
      return 'absent';
    case 'other':
      return 'different';
    case 'symlink':
      return entry.resolution === 'target' ? 'link-to-canonical' : 'link';
    case 'dir':
      if (entry.identity === 'is-target') return 'canonical-dir';
      return entry.identity === 'same-content' ? 'same-copy' : 'different';
  }
}

export function projectInPlaceSkill(opts: {
  canonicalAbs: string;
  canonicalHash: string;
  canonicalRootRel: string;
  name: string;
  cwd: string;
  targets: readonly SkillHostId[];
  mode?: 'copy' | 'link';
  convertLinks?: boolean;
  convertCopies?: boolean;
  roots?: SkillProjectionRoots;
}): { hosts: SkillHostId[]; conflicted: SkillHostId[] } {
  const { canonicalAbs, canonicalHash, canonicalRootRel, name, cwd, targets } = opts;
  const roots = opts.roots ?? EDITOR_PROJECT_SKILL_ROOT;
  const mode = opts.mode ?? 'copy';
  const hosts: SkillHostId[] = [];
  const conflicted: SkillHostId[] = [];
  const materialize = (dest: string, hostRoot: string): void => {
    tracedRmSync(dest, { recursive: true, force: true });
    tracedMkdirSync(hostRoot, { recursive: true });
    if (mode === 'link') {
      tracedSymlinkSync(skillLinkTarget(cwd, hostRoot, canonicalAbs), dest, 'dir');
    } else {
      tracedCpSync(canonicalAbs, dest, { recursive: true, dereference: true });
    }
  };
  for (const editor of targets) {
    if (
      editor === 'agents'
        ? canonicalRootRel === AGENTS_SKILLS_ROOT
        : roots[editor] === canonicalRootRel
    ) {
      const own = skillTargetDir(cwd, editor, name, roots);
      if (own !== null && !hostSkillsRootEscapes(cwd, dirname(own))) {
        const cls = classifyInPlaceDest(own, canonicalAbs, canonicalHash);
        if (
          (mode === 'link' && opts.convertCopies === true && cls === 'same-copy') ||
          (mode === 'copy' && opts.convertLinks === true && cls === 'link-to-canonical')
        ) {
          materialize(own, dirname(own));
        }
      }
      hosts.push(editor);
      continue;
    }
    const dest = skillTargetDir(cwd, editor, name, roots);
    if (dest === null) continue;
    const hostRoot = dirname(dest);
    if (hostSkillsRootEscapes(cwd, hostRoot)) continue;
    try {
      const rootReal = realpathSync(hostRoot);
      if (rootReal !== join(realpathSync(cwd), relative(cwd, hostRoot))) continue;
    } catch {}
    switch (classifyInPlaceDest(dest, canonicalAbs, canonicalHash)) {
      case 'canonical-dir':
        hosts.push(editor);
        break;
      case 'link-to-canonical':
        if (mode === 'copy' && opts.convertLinks === true) materialize(dest, hostRoot);
        hosts.push(editor);
        break;
      case 'same-copy':
        if (mode === 'link' && opts.convertCopies === true) materialize(dest, hostRoot);
        hosts.push(editor);
        break;
      case 'different':
        if (isStaleBundleProjection(dest, name)) {
          materialize(dest, hostRoot);
          hosts.push(editor);
          break;
        }
        conflicted.push(editor);
        break;
      case 'link':
      case 'absent':
        materialize(dest, hostRoot);
        hosts.push(editor);
        break;
    }
  }
  return { hosts, conflicted };
}

export function relocateInPlaceCanonical(opts: {
  canonicalAbs: string;
  canonicalHash: string;
  name: string;
  cwd: string;
  newTarget: SkillHostId;
  destDirAbs?: string;
  leaveLinkBehind?: boolean;
  roots?: SkillProjectionRoots;
}): { ok: true; newAbs: string } | { ok: false; reason: 'target-unusable' | 'target-missing' } {
  const { canonicalHash, name, cwd, newTarget } = opts;
  const roots = opts.roots ?? EDITOR_PROJECT_SKILL_ROOT;
  let canonicalAbs: string;
  try {
    canonicalAbs = realpathSync(opts.canonicalAbs);
  } catch {
    return { ok: false, reason: 'target-unusable' };
  }
  try {
    if (lstatSync(canonicalAbs).isSymbolicLink() || !lstatSync(canonicalAbs).isDirectory()) {
      return { ok: false, reason: 'target-unusable' };
    }
  } catch {
    return { ok: false, reason: 'target-unusable' };
  }
  const dest = opts.destDirAbs ?? skillTargetDir(cwd, newTarget, name, roots);
  if (dest === null) return { ok: false, reason: 'target-missing' };
  if (resolve(dest) === canonicalAbs) return { ok: true, newAbs: dest };
  const hostRoot = dirname(dest);
  if (hostSkillsRootEscapes(cwd, hostRoot)) return { ok: false, reason: 'target-unusable' };
  switch (classifyInPlaceDest(dest, canonicalAbs, canonicalHash)) {
    case 'canonical-dir':
      return { ok: true, newAbs: dest };
    case 'different':
      return { ok: false, reason: 'target-unusable' };
    case 'same-copy':
      try {
        if (lstatSync(dest).isSymbolicLink() || !existsSync(join(dest, 'SKILL.md'))) {
          return { ok: false, reason: 'target-unusable' };
        }
      } catch {
        return { ok: false, reason: 'target-unusable' };
      }
      tracedRmSync(canonicalAbs, { recursive: true, force: true });
      break;
    case 'link':
    case 'link-to-canonical':
      tracedRmSync(dest, { recursive: true, force: true });
      tracedMkdirSync(hostRoot, { recursive: true });
      tracedRenameSync(canonicalAbs, dest);
      break;
    case 'absent':
      tracedMkdirSync(hostRoot, { recursive: true });
      tracedRenameSync(canonicalAbs, dest);
      break;
  }
  if (!existsSync(join(dest, 'SKILL.md')) || lstatSync(dest).isSymbolicLink()) {
    return { ok: false, reason: 'target-unusable' };
  }
  if (opts.leaveLinkBehind === true && !existsSync(canonicalAbs)) {
    tracedSymlinkSync(skillLinkTarget(cwd, dirname(canonicalAbs), dest), canonicalAbs, 'dir');
  }
  repointSiblingLinks({
    name,
    cwd,
    roots,
    target: dest,
    skip: [dest, canonicalAbs],
    alsoClaim: [canonicalAbs, dest],
  });
  return { ok: true, newAbs: dest };
}

const ALL_TARGET_HOSTS: readonly SkillHostId[] = [
  'agents',
  ...(PROJECT_SKILL_EDITOR_IDS as readonly EditorId[]),
];

export function hostSlotPaths(cwd: string, name: string, roots: SkillProjectionRoots): string[] {
  return ALL_TARGET_HOSTS.map((host) => skillTargetDir(cwd, host, name, roots)).filter(
    (p): p is string => p !== null,
  );
}

export function repointSiblingLinks(opts: {
  name: string;
  cwd: string;
  roots: SkillProjectionRoots;
  target: string;
  slots?: readonly string[];
  skip?: readonly string[];
  alsoClaim?: readonly string[];
}): void {
  const { name, cwd, roots, target } = opts;
  const skip = new Set((opts.skip ?? []).map((p) => resolve(p)));
  const claim = new Set((opts.alsoClaim ?? []).map((p) => resolve(p)));
  const slots = opts.slots ?? hostSlotPaths(cwd, name, roots);
  for (const sib of slots) {
    if (skip.has(resolve(sib))) continue;
    try {
      if (!lstatSync(sib).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let resolved: string | null = null;
    try {
      resolved = realpathSync(sib);
    } catch {
      resolved = null;
    }
    if (resolved !== null && !claim.has(resolved)) continue;
    tracedRmSync(sib, { recursive: true, force: true });
    tracedSymlinkSync(skillLinkTarget(cwd, dirname(sib), target), sib, 'dir');
  }
}

export function removeInPlaceSkillCopies(opts: {
  canonicalAbs: string;
  canonicalHash: string;
  name: string;
  cwd: string;
  targets: readonly SkillHostId[];
  roots?: SkillProjectionRoots;
}): SkillHostId[] {
  const { canonicalHash, name, cwd, targets } = opts;
  const roots = opts.roots ?? EDITOR_PROJECT_SKILL_ROOT;
  let canonicalAbs: string;
  try {
    canonicalAbs = realpathSync(opts.canonicalAbs);
  } catch {
    return [];
  }
  const removed: SkillHostId[] = [];
  for (const editor of targets) {
    const dest = skillTargetDir(cwd, editor, name, roots);
    if (dest === null) continue;
    if (hostSkillsRootEscapes(cwd, dirname(dest))) continue;
    switch (classifyInPlaceDest(dest, canonicalAbs, canonicalHash)) {
      case 'same-copy':
      case 'link':
      case 'link-to-canonical':
        tracedRmSync(dest, { recursive: true, force: true });
        removed.push(editor);
        break;
      case 'different':
        if (isStaleBundleProjection(dest, name)) {
          tracedRmSync(dest, { recursive: true, force: true });
          removed.push(editor);
        }
        break;
      default:
        break;
    }
  }
  if (removed.length > 0) {
    repointSiblingLinks({ name, cwd, roots, target: canonicalAbs });
  }
  return removed;
}

export function reverseProjectSkill(
  name: string,
  cwd: string,
  targets: readonly EditorId[],
  roots: SkillProjectionRoots = EDITOR_PROJECT_SKILL_ROOT,
): EditorId[] {
  const removed: EditorId[] = [];
  for (const editor of targets) {
    const dest = skillHostDir(cwd, editor, name, roots);
    if (dest === null) continue;
    let present = false;
    try {
      lstatSync(dest);
      present = true;
    } catch {
      present = false;
    }
    if (!present) continue;
    tracedRmSync(dest, { recursive: true, force: true });
    removed.push(editor);
  }
  return removed;
}

const MAX_BUNDLED_FILE_BYTES = 256 * 1024;

export function listSkillBundledFilePaths(skillDir: string): string[] {
  try {
    if (!existsSync(skillDir)) return [];
    return listSkillFiles(skillDir).filter((rel) => rel !== 'SKILL.md');
  } catch {
    return [];
  }
}

function listSkillFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listSkillFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function readSkillBundledFiles(
  skillDir: string,
): Array<{ path: string; text: string | null }> {
  if (!existsSync(skillDir)) return [];
  const out: Array<{ path: string; text: string | null }> = [];
  for (const rel of listSkillFiles(skillDir)) {
    if (rel === 'SKILL.md') continue;
    let text: string | null = null;
    try {
      const buf = readFileSync(join(skillDir, rel));
      if (buf.length <= MAX_BUNDLED_FILE_BYTES && !buf.includes(0)) {
        text = buf.toString('utf-8');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      text = null;
    }
    out.push({ path: rel, text });
  }
  return out;
}
