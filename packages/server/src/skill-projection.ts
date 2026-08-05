/**
 * Skill install-projection: install a `.ok/skills/<name>/` source dir into
 * editor host dirs (`.claude/skills/<name>/` etc.) by SYMLINK, plus the
 * pre-install validity gate and reverse-projection (uninstall).
 *
 * Install = symlink, not copy: the host entry is a link back to the single
 * source of truth at `.ok/skills/<name>/`, so editing the source is instantly
 * visible to every installed editor and there is nothing to re-project on edit.
 * The link target is relative when the source lives inside the project (the
 * committed `.ok/skills` travels with the repo) and absolute when it lives
 * elsewhere (a global-scope `~/.ok/skills/<name>` linked into a project
 * editor dir crosses the home dir). Install is authoritative: any prior entry
 * (stale link, broken link, or a legacy real-dir copy) is removed before the
 * link is made. OK's own shipped bundle is the one copy exception
 * — it ships inside the app asar with no `.ok/skills` source to link to.
 *
 * Host writes go through the traced fs primitives (`fs.*` spans). Host dirs
 * live OUTSIDE the content/CRDT plane and outside `.ok/` — this is a
 * derived-artifact projection, not a content mutation, so it carries no
 * shadow-repo attribution (the SOURCE edit, via `write`/`edit({skill})`, is
 * what gets attributed).
 *
 * The editor → host-skills-root map is core's `EDITOR_PROJECT_SKILL_ROOT`,
 * shared with `getOkArtifactPaths` so projection + sharing-mode exclude stay
 * in lock-step.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
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
import { inspectSkillPathEntry } from './skill-path-entry.ts';

/**
 * Narrow a persisted `string[]` host list (from the marker, whose JSON is
 * untyped at the read boundary) to the valid editor ids, dropping anything no
 * longer recognized. Single filtering point so callers stop using unchecked
 * `as EditorId[]` casts that would smuggle stale/unknown ids downstream.
 */
export function resolvedHosts(hosts: readonly string[]): EditorId[] {
  const valid = PROJECT_SKILL_EDITOR_IDS as readonly string[];
  return hosts.filter((h): h is EditorId => valid.includes(h));
}

/** Reserved skill-name prefix — OK's own shipped skills. */
const RESERVED_SKILL_PREFIX = 'open-knowledge';

// Intentionally NOT core's `stripFrontmatter` (used by skill-reconcile): this is
// a validity GATE, not a comparison parse. It requires a leading `---` block and
// rejects fenced frontmatter — core's fence-tolerant strip would widen what
// passes the install gate. Different contract, so a separate parser is correct.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// Git conflict markers at line start — a half-merged SKILL.md must never land
// verbatim in an agent's live context.
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
  /**
   * Non-blocking advisories — the skill still installs. An empty `description`
   * lands here (not `errors`): a missing description makes the skill less useful
   * to agents, but hard-blocking install on it meant an already-installed skill
   * red-errored on every install click with no way forward. Surfaced
   * as a `no-description` warning instead.
   */
  warnings: string[];
  /** True when the skill ships a `scripts/` dir (projected but flagged). */
  hasScripts: boolean;
}

/**
 * Pre-install validity gate. A source that fails MUST NOT be projected —
 * a conflicted or malformed SKILL.md landing verbatim in an agent's live
 * context is the failure mode this guards. `allowReservedName` is set only for
 * OK's own shipped `open-knowledge` bundle. Pack skills carry unreserved short
 * names since the marketplace rename; the exact LEGACY old names (keys of
 * `RENAMED_PACK_SKILLS`) stay installable because existing installs are never
 * renamed — EVERY pre-rename install keeps its old reserved-prefix name
 * indefinitely, not just forks, and must remain add-to-host/repairable.
 */
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
      // Non-blocking: a description-less skill still installs. Hard-
      // blocking here made an already-installed skill red-error on every install
      // click. The nudge to add one is surfaced as a `no-description` warning.
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

/**
 * Editors detected as project-configured: those whose project MCP-config file
 * exists under `cwd` AND that have a skill surface. The default
 * install-projection target set when no explicit `skill_targets` is set.
 */
function detectProjectConfiguredTargets(cwd: string): EditorId[] {
  return PROJECT_SKILL_EDITOR_IDS.filter((id) => {
    const rel = EDITOR_PROJECT_CONFIG_PATH[id];
    return rel !== null && existsSync(resolve(cwd, rel));
  });
}

/**
 * Resolve the install-projection target editors. An explicit list (e.g. the
 * project's `skill_targets`, or a tool arg) is filtered to valid
 * skill-surface editors; an empty/absent list falls back to the detected
 * project-configured editors.
 */
export function resolveSkillTargets(cwd: string, explicit?: readonly string[]): EditorId[] {
  if (explicit && explicit.length > 0) {
    const valid = new Set<string>(PROJECT_SKILL_EDITOR_IDS);
    return explicit.filter((id): id is EditorId => valid.has(id));
  }
  return detectProjectConfiguredTargets(cwd);
}

/**
 * The editor → skills-root map for a projection SCOPE. Project scope uses each
 * editor's project root (`.github/skills` for Copilot); global scope uses the
 * USER root (`.copilot/skills`). The two diverge ONLY for Copilot and pi — every
 * other editor's project and user roots are the same relative path — so a global
 * projection MUST pass the user map or Copilot/pi land in the wrong home dir and
 * silently drop. Inert for all other editors.
 */
export type SkillProjectionRoots = Record<EditorId, string | null>;
export function skillProjectionRoots(scope: 'project' | 'global'): SkillProjectionRoots {
  return scope === 'global' ? EDITOR_USER_SKILL_ROOT : EDITOR_PROJECT_SKILL_ROOT;
}

/**
 * Absolute host skills dir for a skill name + editor, or `null` when the
 * editor has no skill surface (e.g. Claude Desktop). `roots` selects the
 * project-vs-user root map (defaults to project; pass the user map for global).
 */
export function skillHostDir(
  cwd: string,
  editor: EditorId,
  name: string,
  roots: SkillProjectionRoots = EDITOR_PROJECT_SKILL_ROOT,
): string | null {
  const root = roots[editor];
  return root === null ? null : resolve(cwd, root, name);
}

/** Host-dir resolution for install targets INCLUDING the `.agents` hub. */
function skillTargetDir(
  cwd: string,
  target: SkillHostId,
  name: string,
  roots: SkillProjectionRoots = EDITOR_PROJECT_SKILL_ROOT,
): string | null {
  if (target === 'agents') return resolve(cwd, '.agents/skills', name);
  return skillHostDir(cwd, target, name, roots);
}

/**
 * True when an editor's host skills root (`<cwd>/.claude/skills` etc.) EXISTS and
 * is a symlink resolving OUTSIDE the project — a write through it would escape the
 * project tree. A not-yet-created root is fine (it's created inside `cwd`). Shared
 * by `projectSkill` and the seed (`installPackSkill`) so every
 * projection write applies the same symlink-escape refusal.
 */
export function hostSkillsRootEscapes(cwd: string, hostRoot: string): boolean {
  if (!existsSync(hostRoot)) return false;
  try {
    const rel = relative(realpathSync(cwd), realpathSync(hostRoot));
    // Contained when rel is '' (root IS cwd) or a forward relative path; escaping
    // when it climbs out (`..`) or resolves to a different absolute root.
    return rel.startsWith('..') || isAbsolute(rel);
  } catch {
    return true;
  }
}

/**
 * Whether a host skills root is the SAME directory as the canonical's own root,
 * reached through a folder-level alias (`.claude/skills -> ../.agents/skills`).
 *
 * Sibling of `hostSkillsRootEscapes`: that one refuses roots pointing OUT of the
 * project, this one refuses roots pointing back IN at the canonical. Both compare
 * roots only — never the per-skill destination — so a bundle already broken by a
 * previous bad write cannot hide the collision by making `realpathSync` throw.
 *
 * A root that does not resolve is not an alias; the caller's own guards handle it.
 *
 * Module-private: `projectSkill` is the only write path that needs it, and the
 * behaviour is covered through that entry point rather than directly.
 */
function isAliasOfCanonicalRoot(hostRoot: string, canonicalRoot: string): boolean {
  if (!existsSync(hostRoot) || !existsSync(canonicalRoot)) return false;
  try {
    return realpathSync(hostRoot) === realpathSync(canonicalRoot);
  } catch {
    return false;
  }
}

/**
 * The link target stored at an editor host dir for a skill source. Relative
 * (portable — travels with a committed `.ok/skills`) when the source is inside
 * the project; absolute when it lives outside (global-scope `~/.ok/skills`).
 */
function skillLinkTarget(cwd: string, hostRoot: string, skillDir: string): string {
  const absSkill = resolve(skillDir);
  const fromCwd = relative(resolve(cwd), absSkill);
  const insideProject = fromCwd !== '' && !fromCwd.startsWith('..') && !isAbsolute(fromCwd);
  return insideProject ? relative(hostRoot, absSkill) : absSkill;
}

/**
 * Install a skill source dir into each target editor's host dir.
 *
 * `mode` selects how: `symlink` (default) links back to the skill's single
 * source folder — right for locally-authored skills, whose source lives in the
 * project alongside the link. `copy` writes a verbatim recursive copy — right
 * for anything a whole team will clone: seeded starter packs and
 * acquired/imported skills, which must survive Windows (where a committed
 * symlink needs `core.symlinks`) and CI, and — for a global-scope source —
 * a machine that has no such source at all. The rm-first authoritative-replace + the symlink-escape guard apply
 * identically to both. Returns the editor ids actually written.
 */
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
    // Refuse to write through a host root that symlink-escapes the project.
    if (hostSkillsRootEscapes(cwd, hostRoot)) continue;
    // Refuse to write through a host root that ALIASES the canonical's own root
    // (`.claude/skills -> ../.agents/skills`). Writing there resolves onto the
    // canonical itself: the rm below deletes the real bundle and the symlink
    // that replaces it points at its own path, so the skill is destroyed and
    // every later host then re-destroys it (once the canonical is a self-link,
    // `realpathSync` throws and the `sameEntry` check below can no longer see
    // the collision). Compared on the ROOTS, never on `dest`, so it still holds
    // after such a cycle exists on disk.
    if (isAliasOfCanonicalRoot(hostRoot, dirname(skillDir))) {
      // Present by construction — the host reads the canonical directly. Report
      // it as projected (same as the `sameEntry` case below); dropping it would
      // understate the host set and strand the marker.
      written.push(editor);
      continue;
    }
    // An in-place skill may already live at the requested host destination.
    // Treat that host as projected without replacing the canonical directory
    // with a copy/symlink to itself.
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
      // A copy must stand alone — that is the whole difference from `link` mode.
      // Without `dereference` a canonical that is itself a symlink (the `source`
      // verb points it elsewhere) would be projected as a link, so the host
      // silently tracks the source instead of holding its own bytes.
      tracedCpSync(skillDir, dest, { recursive: true, dereference: true });
    } else {
      tracedSymlinkSync(skillLinkTarget(cwd, hostRoot, skillDir), dest, 'dir');
    }
    written.push(editor);
  }
  return written;
}

/** What occupies a host dest for an in-place fan-out decision. `canonical-dir`
 *  is the canonical bundle ITSELF (never touched); `link-to-canonical` is a live
 *  symlink resolving to it (kept on install, removable on uninstall). */
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
      return 'different'; // stray file — never touch
    case 'symlink':
      // Every non-canonical link is a plain removable one here, dangling
      // included: projection replaces a stale store projection with a copy.
      // The migration path maps these two rows differently on purpose.
      return entry.resolution === 'target' ? 'link-to-canonical' : 'link';
    case 'dir':
      if (entry.identity === 'is-target') return 'canonical-dir';
      return entry.identity === 'same-content' ? 'same-copy' : 'different';
  }
}

/**
 * Fan-out for an IN-PLACE skill: copy the
 * canonical native bundle into each target editor's host dir. Safety rules:
 *  - NEVER clobbers a DIFFERENT real dir (a fork / user content) — reported in
 *    `conflicted`, untouched.
 *  - The canonical itself and same-hash copies count as already-installed.
 *  - A symlink dest (an old store projection, possibly dangling) is replaced
 *    with a copy.
 *  - An editor whose own root IS the canonical's root is already covered —
 *    nothing is written for it. Aliased roots (folder symlinks) are never
 *    write targets: writes never go through an alias.
 */
export function projectInPlaceSkill(opts: {
  canonicalAbs: string;
  canonicalHash: string;
  /** cwd-relative skills ROOT holding the canonical (e.g. `.agents/skills`). */
  canonicalRootRel: string;
  name: string;
  cwd: string;
  targets: readonly SkillHostId[];
  /** `link` = create symlinks to the canonical instead of copies (per-skill
   *  preference); a lossless same-hash COPY is converted to a link, and vice
   *  versa in copy mode. Default `copy`. */
  mode?: 'copy' | 'link';
  /** With copy mode: ALSO convert existing links-to-canonical into copies —
   *  only for an EXPLICIT user copy choice (lossless; links otherwise kept). */
  convertLinks?: boolean;
  /** Project-vs-user root map; defaults to project roots. */
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
      // `canonicalAbs` is a symlink whenever `source` points the skill at another
      // location, and cpSync's default would copy that link — so the "copy" host
      // would silently track the source instead of holding its own bytes.
      tracedCpSync(canonicalAbs, dest, { recursive: true, dereference: true });
    }
  };
  for (const editor of targets) {
    if (
      editor === 'agents'
        ? canonicalRootRel === '.agents/skills'
        : roots[editor] === canonicalRootRel
    ) {
      // This host's own dir IS the canonical root — never CREATE a copy here.
      // But an EXISTING lossless occurrence in the editor's own dir must still
      // follow an explicit mode flip: a leftover same-hash copy in link mode
      // (or link in explicit copy mode) is stale, double-loads, and contradicts
      // the skill-wide mode the menu shows.
      const own = skillTargetDir(cwd, editor, name, roots);
      if (own !== null && !hostSkillsRootEscapes(cwd, dirname(own))) {
        const cls = classifyInPlaceDest(own, canonicalAbs, canonicalHash);
        if (
          (mode === 'link' && cls === 'same-copy') ||
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
    // Writes never go through an alias: a host root that physically resolves
    // somewhere else (the folder or a parent is a symlink) is a derived view
    // of that other location, never a write target — materializing an absent
    // dest here would land the bytes in the aliased-to root. Skipped, and NOT
    // counted as a host: `hosts` = physical locations only (an alias-covered
    // editor is an audience icon, never an installed-location count).
    try {
      const rootReal = realpathSync(hostRoot);
      if (rootReal !== join(realpathSync(cwd), relative(cwd, hostRoot))) continue;
    } catch {
      // hostRoot absent — a real, creatable location
    }
    switch (classifyInPlaceDest(dest, canonicalAbs, canonicalHash)) {
      case 'canonical-dir':
        hosts.push(editor);
        break;
      case 'link-to-canonical':
        // A live link is already the freshest projection AND may be
        // user-authored — kept, unless the user EXPLICITLY chose copies
        // (unsymlink), which is a lossless conversion.
        if (mode === 'copy' && opts.convertLinks === true) materialize(dest, hostRoot);
        hosts.push(editor);
        break;
      case 'same-copy':
        // Lossless conversion when the preference is link; already right in copy mode.
        if (mode === 'link') materialize(dest, hostRoot);
        hosts.push(editor);
        break;
      case 'different':
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

/**
 * Move an in-place skill's SOURCE (canonical) to another host dir — the
 * user-directed "untoggle the source" action. The new target must be usable:
 * absent (the bundle MOVES there), a live link or same-hash copy (it becomes
 * the real dir), never a DIFFERENT bundle. Afterwards every sibling symlink
 * that pointed at the old source is re-pointed at the new one, so nothing
 * dangles. Identity note: the tracked path (docName) re-roots — an accepted
 * trade-off, here as an explicit user choice.
 */
export function relocateInPlaceCanonical(opts: {
  canonicalAbs: string;
  canonicalHash: string;
  name: string;
  cwd: string;
  newTarget: SkillHostId;
  /** Custom-root destination bundle dir (absolute) — overrides the host-dir
   *  mapping when the new source lives at a custom path (e.g. `.ok/skills`). */
  destDirAbs?: string;
  /** Leave a SYMLINK→dest at the old source path (the promote/downgrade swap:
   *  the clicked location becomes the real folder, the old one a link).
   *  Uncheck-driven relocation passes false — unchecking means REMOVE. */
  leaveLinkBehind?: boolean;
  /** Project-vs-user root map; defaults to project roots. */
  roots?: SkillProjectionRoots;
}): { ok: true; newAbs: string } | { ok: false; reason: 'target-unusable' | 'target-missing' } {
  const { canonicalHash, name, cwd, newTarget } = opts;
  const roots = opts.roots ?? EDITOR_PROJECT_SKILL_ROOT;
  // THE GUARD (the whole reason this survived a rewrite): this primitive moves
  // a skill's LAST REAL DIRECTORY, so it must be handed one. If the caller's
  // "canonical" path is a symlink (mis-election, races), operate on the REAL
  // directory it resolves to — renaming the link file instead of the folder is
  // exactly how a skill's bytes got orphaned into a self-link loop.
  let canonicalAbs: string;
  try {
    canonicalAbs = realpathSync(opts.canonicalAbs);
  } catch {
    return { ok: false, reason: 'target-unusable' }; // dangling — nothing real to move
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
  if (resolve(dest) === canonicalAbs) return { ok: true, newAbs: dest }; // already the source
  const hostRoot = dirname(dest);
  if (hostSkillsRootEscapes(cwd, hostRoot)) return { ok: false, reason: 'target-unusable' };
  switch (classifyInPlaceDest(dest, canonicalAbs, canonicalHash)) {
    case 'canonical-dir':
      return { ok: true, newAbs: dest }; // already the source
    case 'different':
      return { ok: false, reason: 'target-unusable' };
    case 'same-copy':
      // The copy IS the bundle (byte-identical real dir) — it becomes the
      // source. Only NOW is removing the old dir lossless; verify dest is a
      // real dir one more time before the delete (paranoia is the point).
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
  // POST-CONDITION: the destination must now be a real directory holding the
  // bundle. If it isn't, something raced us — fail loudly rather than continue
  // wiring links to a phantom.
  if (!existsSync(join(dest, 'SKILL.md')) || lstatSync(dest).isSymbolicLink()) {
    return { ok: false, reason: 'target-unusable' };
  }
  // The promote/downgrade swap: old source path becomes a link to the new one.
  if (opts.leaveLinkBehind === true && !existsSync(canonicalAbs)) {
    tracedSymlinkSync(skillLinkTarget(cwd, dirname(canonicalAbs), dest), canonicalAbs, 'dir');
  }
  // Claim links that referenced the old source (now gone), plus any resolving
  // to the new dest THROUGH another link (chain) — links always point DIRECTLY
  // at the real dir, so removing any one link can never strand another.
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

/** Every install-target host (editors with a project dir + the .agents hub). */
const ALL_TARGET_HOSTS: readonly SkillHostId[] = [
  'agents',
  ...(PROJECT_SKILL_EDITOR_IDS as readonly EditorId[]),
];

/**
 * The host-dir slots for `name` — the slots {@link repointSiblingLinks} sweeps
 * by default, and therefore the ones a caller passing its OWN `slots` must
 * exclude: two sweeps claiming one slot on the same relocation is a redundant
 * unlink-and-rebuild of a link the other just wrote correctly.
 */
export function hostSlotPaths(cwd: string, name: string, roots: SkillProjectionRoots): string[] {
  return ALL_TARGET_HOSTS.map((host) => skillTargetDir(cwd, host, name, roots)).filter(
    (p): p is string => p !== null,
  );
}

/**
 * Re-point sibling symlinks at `target`: walk every install-target host, skip
 * anything that is not a symlink, and replace each CLAIMED link with one aimed
 * directly at `target`. Shared by relocation and removal, which walk the same
 * slots for the same reason.
 *
 * The promote path's placement-ledger sweep in `skill-install-ops.ts` routes
 * through here too, handing its ledger paths to `slots`. The two sweeps fire on
 * the same relocation and PARTITION the slots between them: the ledger caller
 * excludes {@link hostSlotPaths}, because a slot swept twice is an unlink and
 * rebuild of a link the first sweep already wrote correctly. Folding them also
 * widened the ledger sweep's claim set to match this one's, so a placement that
 * reached the real dir by chaining through the new source is now flattened
 * rather than left as a chain.
 *
 * They differ in which links they claim, and that difference is data, not an
 * inverted condition. A dangling link is ALWAYS claimed: it resolves to
 * nothing, so re-pointing it cannot lose anything. `alsoClaim` adds link
 * realpaths that are stale for a caller-specific reason — relocation names the
 * old source and the new dest, removal names none. Expressing that as a set of
 * paths, rather than a boolean either caller could invert, is what keeps
 * removal from re-pointing links that were aimed elsewhere on purpose.
 *
 * `skip` is the second difference, and it is not cosmetic. Relocation has
 * already put two slots in their final form before the sweep runs: the new
 * `dest`, and the leave-behind link at the old source. Both are in `skip` so the
 * sweep never removes and rebuilds a link relocation just wrote. Without it the
 * leave-behind link realpaths to `dest`, which `alsoClaim` covers, so it would
 * be deleted and recreated with identical bytes. The resulting tree is the same
 * either way, which is why a tree-comparing test cannot see the difference; the
 * sequence of filesystem operations is not, and in this file an unnecessary
 * unlink of a link standing in for a real directory is the scar being avoided.
 */
export function repointSiblingLinks(opts: {
  name: string;
  cwd: string;
  roots: SkillProjectionRoots;
  /** Real bundle dir every claimed link is re-pointed at. */
  target: string;
  /**
   * Absolute slot paths to sweep. Defaults to {@link hostSlotPaths} for `name`;
   * the promote path passes its placement-ledger paths instead, so both slot
   * sources run the same claim + skip rules. When supplied, `name` and `roots`
   * are unused — they only feed the default — so the caller controls which
   * slots are swept without affecting the link target written (always `target`).
   */
  slots?: readonly string[];
  /** Sibling SLOTS never touched, matched on the slot path itself. */
  skip?: readonly string[];
  /** Link REALPATHS claimed on top of dangling ones. */
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
      resolved = null; // dangling
    }
    if (resolved !== null && !claim.has(resolved)) continue;
    tracedRmSync(sib, { recursive: true, force: true });
    tracedSymlinkSync(skillLinkTarget(cwd, dirname(sib), target), sib, 'dir');
  }
}

/**
 * Uninstall counterpart of {@link projectInPlaceSkill}: remove a target editor's
 * occurrence ONLY when doing so loses nothing — a symlink, or a real dir
 * byte-identical (same bundle hash) to the canonical. The canonical itself and
 * any DIFFERENT real dir (fork / user content) are never removed.
 */
export function removeInPlaceSkillCopies(opts: {
  canonicalAbs: string;
  canonicalHash: string;
  name: string;
  cwd: string;
  targets: readonly SkillHostId[];
  /** Project-vs-user root map; defaults to project roots. */
  roots?: SkillProjectionRoots;
}): SkillHostId[] {
  const { canonicalHash, name, cwd, targets } = opts;
  const roots = opts.roots ?? EDITOR_PROJECT_SKILL_ROOT;
  // Operate against the REAL canonical dir (a symlink path handed here would
  // make the canonical-protection classify miss) — same guard as relocation.
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
      default:
        break; // absent, the canonical itself, or a differing dir — never removed
    }
  }
  // Removing an occurrence (real copy OR a link other links chained through)
  // can orphan sibling links — re-point survivors at the canonical.
  // Dangling only: no `alsoClaim`, so a link still aimed at something real
  // keeps pointing there. Widening this is the regression the shared spine has
  // to make hard.
  if (removed.length > 0) {
    repointSiblingLinks({ name, cwd, roots, target: canonicalAbs });
  }
  return removed;
}

/**
 * Remove a skill's projection from each target editor's host dir
 * (uninstall / reverse-projection). Returns the editor ids a projection was
 * actually removed from.
 */
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
    // `lstatSync` does NOT follow the link, so a DANGLING projection symlink
    // (target gone after the source was deleted) is still detected + removed.
    // `existsSync` would follow it, see the missing target, return false, and
    // leave the orphan symlink behind (the cross-scope-move residue).
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

/** Max bytes inlined as text for a bundled skill file; larger files report `text: null`. */
const MAX_BUNDLED_FILE_BYTES = 256 * 1024;

/** Recursively list files under `dir`, POSIX-relative, sorted (deterministic). */
function listSkillFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listSkillFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * A skill's bundled files (everything beside `SKILL.md`: `scripts/`,
 * `reference/`, assets), each with inline `text` when it is a readable,
 * reasonably-sized text file — `text: null` for binary (NUL byte present),
 * oversize, or vanished-mid-scan (ENOENT) files. Read-only: a skill is a
 * folder, so its files are browsable + viewable as TEXT. Scripts come back as
 * text, never as an executable byte stream — the agent in the editor runs them,
 * OK only displays them.
 *
 * A genuine IO error (EACCES / EIO / EISDIR …) THROWS rather than returning
 * `text: null`. This is load-bearing for the cross-scope move: the move flow
 * treats a `null`-text file as binary/oversize and SKIPS it, then deletes the
 * source — so a read error masquerading as `null` would be silent data loss.
 * Throwing fails the `GET /api/skill` read, which makes the move's bundle read
 * return `!ok` and the move abort before deleting anything.
 */
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
      // Only a vanished file (ENOENT — listed then removed) is a benign null; a
      // real IO error must NOT be confused with a skippable binary file (the
      // move would skip it as "binary" and delete the source — data loss).
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      text = null;
    }
    out.push({ path: rel, text });
  }
  return out;
}
