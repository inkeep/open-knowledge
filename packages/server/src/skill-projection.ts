
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

export function resolvedHosts(hosts: readonly string[]): EditorId[] {
  const valid = PROJECT_SKILL_EDITOR_IDS as readonly string[];
  return hosts.filter((h): h is EditorId => valid.includes(h));
}

const RESERVED_SKILL_PREFIX = 'open-knowledge';

export const PACK_SKILL_PREFIX = 'open-knowledge-pack-';

const SHIPPED_SKILL_NAME = 'open-knowledge';

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
  hasScripts: boolean;
}

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

export function skillHostDir(cwd: string, editor: EditorId, name: string): string | null {
  const root = EDITOR_PROJECT_SKILL_ROOT[editor];
  return root === null ? null : resolve(cwd, root, name);
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
): EditorId[] {
  const written: EditorId[] = [];
  for (const editor of targets) {
    const dest = skillHostDir(cwd, editor, name);
    if (dest === null) continue;
    const hostRoot = dirname(dest);
    if (hostSkillsRootEscapes(cwd, hostRoot)) continue;
    tracedRmSync(dest, { recursive: true, force: true });
    tracedMkdirSync(hostRoot, { recursive: true });
    tracedSymlinkSync(skillLinkTarget(cwd, hostRoot, skillDir), dest, 'dir');
    written.push(editor);
  }
  return written;
}

export function reverseProjectSkill(
  name: string,
  cwd: string,
  targets: readonly EditorId[],
): EditorId[] {
  const removed: EditorId[] = [];
  for (const editor of targets) {
    const dest = skillHostDir(cwd, editor, name);
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

export function reverseBundleSkill(cwd: string, targets: readonly EditorId[]): EditorId[] {
  return reverseProjectSkill(SHIPPED_SKILL_NAME, cwd, targets);
}

const MAX_BUNDLED_FILE_BYTES = 256 * 1024;

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
