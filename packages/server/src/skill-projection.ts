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
 * (`projectBundleSkill`) — it ships inside the app asar with no `.ok/skills`
 * source to link to.
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
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { resolveBundledSkillDir } from './build-skill-zip.ts';
import { tracedCpSync, tracedMkdirSync, tracedRmSync, tracedSymlinkSync } from './fs-traced.ts';

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

/**
 * Starter-pack project skills (`open-knowledge-pack-<packId>`, seeded by
 * `installPackSkill`). They sit under the reserved prefix but are OK's own
 * shipped content, so they're exempt from the reserved-name install block —
 * otherwise a pack skill couldn't be re-installed after a user uninstalls it
 * (the seed copies it in directly, but a user-triggered reinstall re-validates).
 */
export const PACK_SKILL_PREFIX = 'open-knowledge-pack-';

/** OK's shipped project-skill bundle name (lives at `.{host}/skills/open-knowledge/`). */
const SHIPPED_SKILL_NAME = 'open-knowledge';

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
  /** True when the skill ships a `scripts/` dir (projected but flagged). */
  hasScripts: boolean;
}

/**
 * Pre-install validity gate. A source that fails MUST NOT be projected —
 * a conflicted or malformed SKILL.md landing verbatim in an agent's live
 * context is the failure mode this guards. `allowReservedName` is set only for
 * OK's own shipped `open-knowledge` bundle; `open-knowledge-pack-*` skills are
 * exempt by name (they're shipped pack content, installable + reinstallable).
 */
export function validateSkillForInstall(
  skillDir: string,
  name: string,
  opts?: { allowReservedName?: boolean },
): SkillValidity {
  const errors: string[] = [];
  const skillMd = join(skillDir, 'SKILL.md');
  const hasScripts =
    existsSync(join(skillDir, 'scripts')) && statSync(join(skillDir, 'scripts')).isDirectory();

  const usesReservedName =
    name.startsWith(RESERVED_SKILL_PREFIX) && !name.startsWith(PACK_SKILL_PREFIX);
  if (!opts?.allowReservedName && usesReservedName) {
    errors.push(
      `"${name}" uses the reserved \`${RESERVED_SKILL_PREFIX}*\` prefix (reserved for OK's shipped skills) — choose another name.`,
    );
  }
  if (!existsSync(skillMd)) {
    errors.push(`No SKILL.md found at ${skillDir}.`);
    return { ok: errors.length === 0, errors, hasScripts };
  }
  let raw: string;
  try {
    raw = readFileSync(skillMd, 'utf-8');
  } catch (e) {
    errors.push(`Cannot read SKILL.md: ${(e as Error).message}.`);
    return { ok: false, errors, hasScripts };
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
      errors.push('SKILL.md frontmatter.description is missing or empty.');
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
  return { ok: errors.length === 0, errors, hasScripts };
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
 * Absolute host skills dir for a skill name + editor, or `null` when the
 * editor has no project skill surface (e.g. Claude Desktop).
 */
export function skillHostDir(cwd: string, editor: EditorId, name: string): string | null {
  const root = EDITOR_PROJECT_SKILL_ROOT[editor];
  return root === null ? null : resolve(cwd, root, name);
}

/**
 * True when an editor's host skills root (`<cwd>/.claude/skills` etc.) EXISTS and
 * is a symlink resolving OUTSIDE the project — a write through it would escape the
 * project tree. A not-yet-created root is fine (it's created inside `cwd`). Shared
 * by `projectSkill`/`projectBundleSkill` and the seed (`installPackSkill`) so every
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
 * Install a skill source dir into each target editor's host dir by SYMLINK.
 * Removes any existing entry first (authoritative replace — a stale/broken
 * link or a legacy real-dir copy is dropped before the link is made). Returns
 * the editor ids actually written (skipping editors with no skill surface).
 */
export function projectSkill(
  skillDir: string,
  name: string,
  cwd: string,
  targets: readonly EditorId[],
): EditorId[] {
  const written: EditorId[] = [];
  for (const editor of targets) {
    const dest = skillHostDir(cwd, editor, name);
    if (dest === null) continue;
    const hostRoot = dirname(dest);
    // Refuse to write through a host root that symlink-escapes the project.
    if (hostSkillsRootEscapes(cwd, hostRoot)) continue;
    tracedRmSync(dest, { recursive: true, force: true });
    tracedMkdirSync(hostRoot, { recursive: true });
    tracedSymlinkSync(skillLinkTarget(cwd, hostRoot, skillDir), dest, 'dir');
    written.push(editor);
  }
  return written;
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
): EditorId[] {
  const removed: EditorId[] = [];
  for (const editor of targets) {
    const dest = skillHostDir(cwd, editor, name);
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

/**
 * Project OK's shipped `open-knowledge` bundle into each target editor's host
 * dir, so OK's own project skill follows the same `skill_targets` set as
 * authored skills. Source is the bundled asset (`resolveBundledSkillDir`),
 * NOT a `.ok/skills/` dir. Returns the editor ids written; `[]` when the
 * bundle can't be resolved (e.g. a dev tree with no built assets).
 */
export function projectBundleSkill(cwd: string, targets: readonly EditorId[]): EditorId[] {
  let bundleDir: string;
  try {
    bundleDir = resolveBundledSkillDir('project', { checkDesktop: true });
  } catch {
    return [];
  }
  const written: EditorId[] = [];
  for (const editor of targets) {
    const dest = skillHostDir(cwd, editor, SHIPPED_SKILL_NAME);
    if (dest === null) continue;
    if (hostSkillsRootEscapes(cwd, dirname(dest))) continue;
    tracedRmSync(dest, { recursive: true, force: true });
    tracedCpSync(bundleDir, dest, { recursive: true });
    written.push(editor);
  }
  return written;
}

/** Remove OK's shipped bundle projection from each target editor's host dir. */
export function reverseBundleSkill(cwd: string, targets: readonly EditorId[]): EditorId[] {
  return reverseProjectSkill(SHIPPED_SKILL_NAME, cwd, targets);
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
