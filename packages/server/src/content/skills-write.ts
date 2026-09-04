import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import {
  containsXmlTag,
  SKILL_NAME_REGEX,
  type SkillFrontmatter,
} from '@inkeep/open-knowledge-core';
import { stringify as stringifyYaml } from 'yaml';
/*
 * STOP: every disk write in this module goes through `fs-traced.ts` so it
 * carries an `fs.*` span. A bare `node:fs` call here drops the span.
 */
import {
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmdirSync,
  tracedRmSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const DISCOURAGED_NAME_WORDS = ['anthropic', 'claude'];
const BODY_SOFT_MAX_LINES = 500;
const SKILL_FILE = 'SKILL.md';

type SkillWriteResult =
  | { ok: true; path: string; created: boolean; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

export type SkillContentResult =
  | { ok: true; content: string; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

type SkillDeleteResult =
  | { ok: true; path: string; existed: boolean }
  | { ok: false; error: { code: string; message: string } };

type SkillMoveResult =
  | { ok: true; fromPath: string; toPath: string; committed: boolean }
  | { ok: false; error: { code: string; message: string } };

interface WriteSkillInput {
  skillsRoot: string;
  name: string;
  body: string;
  frontmatter: SkillFrontmatter;
}

interface DeleteSkillInput {
  skillsRoot: string;
  name: string;
}

interface MoveSkillInput {
  skillsRoot: string;
  fromName: string;
  toName: string;
  relocate: (fromAbs: string, toAbs: string) => Promise<boolean>;
}

export function composeSkillContent(input: {
  name: string;
  body: string;
  frontmatter: SkillFrontmatter;
}): SkillContentResult {
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const fmCheck = validateFrontmatter(input.frontmatter, input.name);
  if (!fmCheck.ok) return { ok: false, error: fmCheck.error };

  const fmYaml = serializeFrontmatter(input.frontmatter);
  const content = `---\n${fmYaml}---\n${input.body}`;

  const warnings: string[] = [];
  const discouraged = DISCOURAGED_NAME_WORDS.filter((w) => input.name.includes(w));
  if (discouraged.length > 0) {
    warnings.push(
      `Skill name contains ${discouraged.map((w) => `"${w}"`).join(', ')} — Anthropic's authoring guidance discourages vendor words in skill names.`,
    );
  }
  const lineCount = input.body.split('\n').length;
  if (lineCount > BODY_SOFT_MAX_LINES) {
    warnings.push(
      `SKILL.md body is ${lineCount} lines — keep it under ${BODY_SOFT_MAX_LINES} for performance (every line is a recurring token cost). Move detail into one-level-deep references/.`,
    );
  }
  return { ok: true, content, warnings };
}

export function applySkillWrite(input: WriteSkillInput): SkillWriteResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };

  const composed = composeSkillContent({
    name: input.name,
    body: input.body,
    frontmatter: input.frontmatter,
  });
  if (!composed.ok) return { ok: false, error: composed.error };
  const { content, warnings } = composed;

  const { skillDir, filePath } = skillPaths(input.skillsRoot, input.name);

  try {
    tracedMkdirSync(skillDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to create skill directory at ${relPathOf(input.skillsRoot, skillDir)}: ${(err as Error).message}`,
      },
    };
  }

  const created = !existsSync(filePath);

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    tracedWriteFileSync(tmpPath, content, 'utf-8');
    tracedRenameSync(tmpPath, filePath);
  } catch (err) {
    try {
      tracedUnlinkSync(tmpPath);
    } catch {}
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write skill at ${relPathOf(input.skillsRoot, filePath)}: ${(err as Error).message}`,
      },
    };
  }

  return { ok: true, path: relPathOf(input.skillsRoot, filePath), created, warnings };
}

export const BUNDLE_FILE_MAX_BYTES = 256 * 1024;
export const BUNDLE_MAX_FILES = 50;

export interface BundleFileWriteLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
}

interface BundleFileInput {
  skillsRoot: string;
  name: string;
  relPath: string;
}

type BundleFileWriteResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; error: { code: string; message: string } };

type BundleFileDeleteResult =
  | { ok: true; path: string; existed: boolean }
  | { ok: false; error: { code: string; message: string } };

function resolveBundleFileAbs(
  skillDir: string,
  relPath: string,
): { ok: true; abs: string } | { ok: false; error: { code: string; message: string } } {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\x00')) {
    return { ok: false, error: { code: 'BAD_FILE_PATH', message: 'Invalid skill file path.' } };
  }
  const segments = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.some((s) => s === '..')) {
    return {
      ok: false,
      error: { code: 'BAD_FILE_PATH', message: `Invalid skill file path: ${relPath}` },
    };
  }
  if (segments.length === 1 && segments[0] === SKILL_FILE) {
    return {
      ok: false,
      error: {
        code: 'BAD_FILE_PATH',
        message: 'SKILL.md is written through the skill write path, not as a bundle file.',
      },
    };
  }
  const abs = join(skillDir, ...segments);
  if (abs !== skillDir && !abs.startsWith(skillDir + sep)) {
    return {
      ok: false,
      error: { code: 'BAD_FILE_PATH', message: `Skill file escapes the skill dir: ${relPath}` },
    };
  }
  return { ok: true, abs };
}

export function countBundleFiles(skillDir: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const entryName of names) {
      const abs = join(dir, entryName);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(abs);
      else if (!(dir === skillDir && entryName === SKILL_FILE)) count++;
    }
  };
  walk(skillDir);
  return count;
}

export function applySkillBundleFileWrite(
  input: BundleFileInput & {
    content: string | null;
    bytes?: Uint8Array;
    limits?: BundleFileWriteLimits;
  },
): BundleFileWriteResult {
  const payload: string | Uint8Array = input.bytes ?? input.content ?? '';
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const { skillDir, filePath: skillMd } = skillPaths(input.skillsRoot, input.name);
  if (!existsSync(skillMd)) {
    return {
      ok: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `No skill "${input.name}" — create it (write its SKILL.md) before adding bundle files.`,
      },
    };
  }
  const resolved = resolveBundleFileAbs(skillDir, input.relPath);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { abs } = resolved;

  const byteLength =
    typeof payload === 'string' ? Buffer.byteLength(payload, 'utf-8') : payload.length;
  const maxFileBytes = input.limits?.maxFileBytes ?? BUNDLE_FILE_MAX_BYTES;
  const maxFiles = input.limits?.maxFiles ?? BUNDLE_MAX_FILES;
  if (byteLength > maxFileBytes) {
    return {
      ok: false,
      error: {
        code: 'FILE_TOO_LARGE',
        message: `Skill file ${input.relPath} is ${byteLength} bytes — the per-file cap is ${maxFileBytes}.`,
      },
    };
  }

  const created = !existsSync(abs);
  if (created && countBundleFiles(skillDir) >= maxFiles) {
    return {
      ok: false,
      error: {
        code: 'TOO_MANY_FILES',
        message: `Skill "${input.name}" already holds ${maxFiles} bundle files (the cap) — delete one before adding another.`,
      },
    };
  }

  try {
    tracedMkdirSync(join(abs, '..'), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to create directory for ${input.relPath}: ${(err as Error).message}`,
      },
    };
  }
  const tmpPath = `${abs}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (typeof payload === 'string') tracedWriteFileSync(tmpPath, payload, 'utf-8');
    else tracedWriteFileSync(tmpPath, payload);
    tracedRenameSync(tmpPath, abs);
  } catch (err) {
    try {
      tracedUnlinkSync(tmpPath);
    } catch {}
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write skill file ${input.relPath}: ${(err as Error).message}`,
      },
    };
  }
  return {
    ok: true,
    path: relPathOf(input.skillsRoot, abs),
    created,
  };
}

export type BundleFileRenameResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export function applySkillBundleFileRename(
  input: BundleFileInput & { toRelPath: string },
): BundleFileRenameResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const { skillDir } = skillPaths(input.skillsRoot, input.name);
  const from = resolveBundleFileAbs(skillDir, input.relPath);
  if (!from.ok) return { ok: false, error: from.error };
  const to = resolveBundleFileAbs(skillDir, input.toRelPath);
  if (!to.ok) return { ok: false, error: to.error };

  if (!existsSync(from.abs)) {
    return {
      ok: false,
      error: { code: 'FILE_NOT_FOUND', message: `No bundle file at ${input.relPath}.` },
    };
  }
  if (existsSync(to.abs)) {
    return {
      ok: false,
      error: {
        code: 'DEST_EXISTS',
        message: `A bundle file already exists at ${input.toRelPath} — renames never overwrite.`,
      },
    };
  }
  try {
    tracedMkdirSync(join(to.abs, '..'), { recursive: true });
    tracedRenameSync(from.abs, to.abs);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'RENAME_FAILED',
        message: `Failed to rename ${input.relPath} -> ${input.toRelPath}: ${(err as Error).message}`,
      },
    };
  }
  const parent = join(from.abs, '..');
  if (parent !== skillDir && isEmpty(parent)) {
    try {
      tracedRmdirSync(parent);
    } catch {}
  }
  return { ok: true };
}

export function applySkillBundleFileDelete(input: BundleFileInput): BundleFileDeleteResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const { skillDir } = skillPaths(input.skillsRoot, input.name);
  const resolved = resolveBundleFileAbs(skillDir, input.relPath);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { abs } = resolved;

  const existed = existsSync(abs);
  if (existed) {
    try {
      if (statSync(abs).isDirectory()) tracedRmSync(abs, { recursive: true, force: true });
      else tracedUnlinkSync(abs);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'UNLINK_FAILED',
          message: `Failed to delete skill file ${input.relPath}: ${(err as Error).message}`,
        },
      };
    }
    const parent = join(abs, '..');
    if (parent !== skillDir && isEmpty(parent)) {
      try {
        tracedRmdirSync(parent);
      } catch {}
    }
  }
  return { ok: true, path: relPathOf(input.skillsRoot, abs), existed };
}

export function applySkillDelete(input: DeleteSkillInput): SkillDeleteResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const { skillsRoot } = base;
  const { skillDir } = skillPaths(input.skillsRoot, input.name);

  const existed = existsSync(skillDir);
  if (existed) {
    try {
      tracedRmSync(skillDir, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'UNLINK_FAILED',
          message: `Failed to delete skill at ${relPathOf(input.skillsRoot, skillDir)}: ${(err as Error).message}`,
        },
      };
    }
  }
  cleanEmptyDirs(skillsRoot);

  return { ok: true, path: relPathOf(input.skillsRoot, skillDir), existed };
}

export async function applySkillMove(input: MoveSkillInput): Promise<SkillMoveResult> {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const fromCheck = validateName(input.fromName);
  if (!fromCheck.ok) return { ok: false, error: fromCheck.error };
  const toCheck = validateName(input.toName);
  if (!toCheck.ok) return { ok: false, error: toCheck.error };

  const from = skillPaths(input.skillsRoot, input.fromName);
  const to = skillPaths(input.skillsRoot, input.toName);

  if (from.skillDir === to.skillDir) {
    return {
      ok: false,
      error: { code: 'NOOP', message: 'Source and destination are the same skill.' },
    };
  }
  if (!existsSync(from.skillDir)) {
    return {
      ok: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `No skill at ${relPathOf(input.skillsRoot, from.skillDir)}.`,
      },
    };
  }
  if (existsSync(to.skillDir)) {
    return {
      ok: false,
      error: {
        code: 'SKILL_EXISTS',
        message: `A skill already exists at ${relPathOf(input.skillsRoot, to.skillDir)}.`,
      },
    };
  }

  let committed: boolean;
  try {
    committed = await input.relocate(from.skillDir, to.skillDir);
  } catch (err) {
    return {
      ok: false,
      error: { code: 'MOVE_FAILED', message: `Failed to move skill: ${(err as Error).message}` },
    };
  }

  return {
    ok: true,
    fromPath: relPathOf(input.skillsRoot, from.skillDir),
    toPath: relPathOf(input.skillsRoot, to.skillDir),
    committed,
  };
}

function validateBase(
  skillsRoot: string,
): { ok: true; skillsRoot: string } | { ok: false; error: { code: string; message: string } } {
  if (!isAbsolute(skillsRoot)) {
    return {
      ok: false,
      error: { code: 'BAD_SKILLS_ROOT', message: 'skillsRoot must be absolute' },
    };
  }
  return { ok: true, skillsRoot };
}

function validateName(
  name: string,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: { code: 'BAD_NAME', message: 'Skill name is required.' } };
  }
  if (name.length > NAME_MAX) {
    return {
      ok: false,
      error: { code: 'BAD_NAME', message: `Skill name must be ≤${NAME_MAX} characters.` },
    };
  }
  if (!SKILL_NAME_REGEX.test(name)) {
    return {
      ok: false,
      error: {
        code: 'BAD_NAME',
        message: `Skill name must match /^[a-z0-9-]+$/ (got: ${JSON.stringify(name)}). Lowercase letters, digits, hyphens — no slashes, dots, spaces, or uppercase.`,
      },
    };
  }
  return { ok: true };
}

function validateFrontmatter(
  fm: SkillFrontmatter,
  dirName: string,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (!fm || typeof fm !== 'object') {
    return {
      ok: false,
      error: {
        code: 'BAD_FRONTMATTER',
        message: 'Skill frontmatter (name, description) is required.',
      },
    };
  }
  if (typeof fm.name !== 'string' || fm.name.length === 0) {
    return {
      ok: false,
      error: { code: 'SKILL_NAME_REQUIRED', message: 'Skill frontmatter.name is required.' },
    };
  }
  if (fm.name !== dirName) {
    return {
      ok: false,
      error: {
        code: 'NAME_DIR_MISMATCH',
        message: `Skill frontmatter.name (${JSON.stringify(fm.name)}) must equal the skill directory name (${JSON.stringify(dirName)}).`,
      },
    };
  }
  if (containsXmlTag(fm.name)) {
    return {
      ok: false,
      error: {
        code: 'XML_TAG_IN_NAME',
        message: 'Skill frontmatter.name may not contain XML tags (`<...>`).',
      },
    };
  }
  if (typeof fm.description !== 'string') {
    return {
      ok: false,
      error: {
        code: 'SKILL_DESCRIPTION_REQUIRED',
        message:
          'Skill frontmatter.description must be a string — it is the primary triggering surface (when to use the skill).',
      },
    };
  }
  if (fm.description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      error: {
        code: 'DESCRIPTION_TOO_LONG',
        message: `Skill frontmatter.description must be ≤${DESCRIPTION_MAX} characters (got ${fm.description.length}).`,
      },
    };
  }
  if (containsXmlTag(fm.description)) {
    return {
      ok: false,
      error: {
        code: 'XML_TAG_IN_DESCRIPTION',
        message:
          'Skill frontmatter.description may not contain XML tags (`<...>`) — they break the Cowork parser and skill loader.',
      },
    };
  }
  return { ok: true };
}

function skillPaths(skillsRoot: string, name: string): { skillDir: string; filePath: string } {
  const skillDir = join(skillsRoot, name);
  const filePath = join(skillDir, SKILL_FILE);
  return { skillDir, filePath };
}

function cleanEmptyDirs(skillsRoot: string): void {
  if (existsSync(skillsRoot) && isEmpty(skillsRoot)) {
    try {
      tracedRmdirSync(skillsRoot);
    } catch {}
  }
  const okDir = normalize(join(skillsRoot, '..'));
  if (okDir.endsWith(`${sep}.ok`) && existsSync(okDir) && isEmpty(okDir)) {
    try {
      tracedRmdirSync(okDir);
    } catch {}
  }
}

function relPathOf(base: string, abs: string): string {
  const rel = abs.startsWith(base + sep) ? abs.slice(base.length + 1) : abs;
  return normalize(rel).split(sep).join('/');
}

function serializeFrontmatter(fm: SkillFrontmatter): string {
  return stringifyYaml({
    name: fm.name,
    description: fm.description,
    ...(fm.metadata !== undefined ? { metadata: fm.metadata } : {}),
  });
}

function isEmpty(absDir: string): boolean {
  try {
    return readdirSync(absDir).length === 0;
  } catch {
    return false;
  }
}
