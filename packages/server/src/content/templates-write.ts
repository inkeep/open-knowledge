/**
 * Filesystem writers for `.ok/templates/<name>.md` files.
 *
 * Two callable surfaces — wrapped by the `write` / `edit` MCP tools (template target)
 * (`write-template` / `delete-template` actions). Both are atomic-ish: write goes
 * through a tmp+rename to avoid partial-state visibility for the
 * file-watcher; delete is a single unlink + auto-clean of empty
 * `.ok/templates/` and `.ok/`.
 *
 * Templates are project-scoped: a write targets a folder inside the
 * current project at `<projectDir>/<folder>/.ok/templates/<name>.md`.
 * `folder` is project-root-relative; `""` means the project root.
 *
 * Validation:
 *   - `folder` must resolve under `projectDir` (no traversal escape).
 *   - `name` is a safe filename: `[A-Za-z0-9_-]+` only.
 *   - `frontmatter.title` MUST be present and non-empty — hard error
 *     `TEMPLATE_TITLE_REQUIRED`. `title` is the menu surface (agents pick
 *     templates by name+title); a title-less template is effectively
 *     invisible. Storing one would create a silent failure later.
 *   - `frontmatter.description` SHOULD be present — surfaced as a
 *     post-write warning (not a hard error).
 *   - `body` substitution allowlist: only `{{date}}` and `{{user}}` tokens
 *     accepted; anything else inside `{{...}}` triggers hard error
 *     `TEMPLATE_UNKNOWN_VARIABLE`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  composeTemplateFile,
  stripFrontmatter,
  TEMPLATE_IDENTITY_KEY,
  TEMPLATE_NAME_REGEX,
  type TemplateIdentity,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { validateSubstitution } from './substitution.ts';

type TemplateWriteResult =
  | {
      ok: true;
      path: string;
      created: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

type TemplateDeleteResult =
  | {
      ok: true;
      path: string;
      existed: boolean;
      cleanedEmpty: { templatesDir: boolean; okDir: boolean };
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

export interface TemplateFrontmatter {
  title?: string;
  description?: string;
  tags?: string[];
}

interface WriteTemplateInput {
  projectDir: string;
  folder: string;
  name: string;
  body: string;
  frontmatter: TemplateFrontmatter;
}

interface DeleteTemplateInput {
  projectDir: string;
  folder: string;
  name: string;
}

/** Filename grammar: ASCII alnum + `_` + `-`. Stable identifier for write. */
const NAME_RE = TEMPLATE_NAME_REGEX;

/** Result of {@link composeTemplateContent} — validated `.md` bytes, no disk I/O. */
export type TemplateContentResult =
  | { ok: true; content: string; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

/**
 * Validate a template's name + frontmatter + body substitutions and serialize
 * the full `.md` bytes — WITHOUT touching disk. The content-composition core
 * shared by the fs writer (`applyTemplateWrite`) and the CRDT write path (the
 * `template-put` handler routes the returned `content` through the doc's
 * Y.Text). Mirrors `composeSkillContent`. Folder/path validation stays with the
 * caller (it is path-level, not content-level).
 */
export function composeTemplateContent(input: {
  name: string;
  body: string;
  frontmatter: TemplateFrontmatter;
}): TemplateContentResult {
  if (!NAME_RE.test(input.name)) {
    return {
      ok: false,
      error: {
        code: 'BAD_NAME',
        message: `Template name must match /^[A-Za-z0-9_-]+$/ (got: ${JSON.stringify(input.name)}). Use letters, digits, underscores, or hyphens — no slashes, dots, or spaces.`,
      },
    };
  }
  const titleCheck = validateTitle(input.frontmatter.title);
  if (!titleCheck.ok) return { ok: false, error: titleCheck.error };

  // Only `{{date}}` and `{{user}}` substitutions are allowed in template
  // bodies. Reject any other `{{...}}` token at write time so the agent never
  // persists a template that would silently leave unknown tokens at
  // instantiation time.
  const subsCheck = validateSubstitutionAllowlist(input.body);
  if (!subsCheck.ok) return { ok: false, error: subsCheck.error };

  // The doc-frontmatter (in `body`) may not declare a top-level `template:`
  // key — it is reserved for the template's own identity in the single block.
  const reservedCheck = validateNoReservedDocKey(input.body);
  if (!reservedCheck.ok) return { ok: false, error: reservedCheck.error };

  // Compose a single-block template file: the `template:` identity followed
  // by the doc-frontmatter + markdown carried in `body`. Only the (token-free)
  // identity is serialized through YAML; `body` passes through verbatim so
  // `{{date}}`/`{{user}}` survive.
  const identity: TemplateIdentity = {};
  if (input.frontmatter.title !== undefined) identity.title = input.frontmatter.title;
  if (input.frontmatter.description !== undefined) {
    identity.description = input.frontmatter.description;
  }
  if (Array.isArray(input.frontmatter.tags) && input.frontmatter.tags.length > 0) {
    identity.tags = input.frontmatter.tags;
  }
  const content = composeTemplateFile(identity, input.body);

  const warnings: string[] = [];
  if (
    input.frontmatter.description === undefined ||
    typeof input.frontmatter.description !== 'string' ||
    input.frontmatter.description.length === 0
  ) {
    warnings.push(
      'Template frontmatter.description is missing — `description` disambiguates between similarly-named templates in the menu. Recommended but not required.',
    );
  }
  return { ok: true, content, warnings };
}

export function applyTemplateWrite(input: WriteTemplateInput): TemplateWriteResult {
  const validation = validateInputs(input.projectDir, input.folder, input.name);
  if (!validation.ok) return { ok: false, error: validation.error };

  const composed = composeTemplateContent({
    name: input.name,
    body: input.body,
    frontmatter: input.frontmatter,
  });
  if (!composed.ok) return { ok: false, error: composed.error };
  const { content, warnings } = composed;

  const { templatesDir, filePath } = templatePaths(
    input.projectDir,
    validation.folderRel,
    input.name,
  );

  // Lazy-create .ok/ and templates/.
  try {
    mkdirSync(templatesDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to create template directory at ${relPathOf(input.projectDir, templatesDir)}: ${(err as Error).message}`,
      },
    };
  }

  const created = !existsSync(filePath);

  // Atomic write: tmp + rename so the file-watcher sees one event.
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up orphaned tmp file if write succeeded but rename failed.
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort — tmp may not exist (writeFileSync failed) or may
      // have already been moved (renameSync partial). Either way, leave it.
    }
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write template at ${relPathOf(input.projectDir, filePath)}: ${(err as Error).message}`,
      },
    };
  }

  return {
    ok: true,
    path: relPathOf(input.projectDir, filePath),
    created,
    warnings,
  };
}

export function applyTemplateDelete(input: DeleteTemplateInput): TemplateDeleteResult {
  const validation = validateInputs(input.projectDir, input.folder, input.name);
  if (!validation.ok) return { ok: false, error: validation.error };

  const { templatesDir, okDir, filePath } = templatePaths(
    input.projectDir,
    validation.folderRel,
    input.name,
  );

  const existed = existsSync(filePath);
  if (existed) {
    try {
      unlinkSync(filePath);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'UNLINK_FAILED',
          message: `Failed to delete template at ${relPathOf(input.projectDir, filePath)}: ${(err as Error).message}`,
        },
      };
    }
  }

  return {
    ok: true,
    path: relPathOf(input.projectDir, filePath),
    existed,
    cleanedEmpty: cleanEmptyOkDirs(templatesDir, okDir),
  };
}

/**
 * Auto-clean the now-possibly-empty `templates/` then `.ok/` dirs left behind
 * after a template delete or move-out. Empty `templates/` → remove; if that
 * leaves `.ok/` empty too → remove it. A non-empty dir (race, or `.ok/` still
 * holding `frontmatter.yml`/`local/`) is left intact. Shared by
 * `applyTemplateDelete` and `applyTemplateMove` so the cleanup rule lives once.
 */
function cleanEmptyOkDirs(
  templatesDir: string,
  okDir: string,
): { templatesDir: boolean; okDir: boolean } {
  let templatesCleaned = false;
  let okCleaned = false;
  if (existsSync(templatesDir) && isEmpty(templatesDir)) {
    try {
      rmdirSync(templatesDir);
      templatesCleaned = true;
    } catch {
      // Non-empty (race) or permission error — leave it.
    }
  }
  if (existsSync(okDir) && isEmpty(okDir)) {
    try {
      rmdirSync(okDir);
      okCleaned = true;
    } catch {
      // Non-empty (e.g., frontmatter.yml still here) — leave it.
    }
  }
  return { templatesDir: templatesCleaned, okDir: okCleaned };
}

interface MoveTemplateInput {
  projectDir: string;
  fromFolder: string;
  fromName: string;
  toFolder: string;
  toName: string;
  /**
   * Relocate the file on disk. Injected by the caller so this module stays
   * git-agnostic (the `git mv` primitive lives server-side). Returns `true`
   * when the relocation was a tracked `git mv` (history-preserving), `false`
   * when it fell back to a plain rename. Must create the destination if the
   * relocator itself doesn't — `applyTemplateMove` pre-creates the dest dir.
   */
  relocate: (fromAbs: string, toAbs: string) => Promise<boolean>;
}

type TemplateMoveResult =
  | {
      ok: true;
      fromPath: string;
      toPath: string;
      committed: boolean;
      cleanedEmpty: { templatesDir: boolean; okDir: boolean };
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

/**
 * Move/rename a template from `(fromFolder, fromName)` to `(toFolder, toName)`.
 * Both endpoints are validated (traversal/escape + name grammar). The source
 * must exist at EXACTLY `fromFolder` — an inherited template (resolved from an
 * ancestor) is NOT moved here; the caller detects that case and teaches
 * localize-then-move. Destination collision (exact path exists) is refused;
 * a destination folder that merely *inherits* a same-named template is allowed
 * (closest-wins shadow). The destination `templates/` dir is created; the
 * relocation is delegated to `input.relocate` (git mv with fs fallback); the
 * now-empty source dirs are auto-cleaned. Content is NOT rewritten here — the
 * caller layers an `applyTemplateWrite` at the destination for atomic
 * move+edit.
 */
export async function applyTemplateMove(input: MoveTemplateInput): Promise<TemplateMoveResult> {
  const fromValidation = validateInputs(input.projectDir, input.fromFolder, input.fromName);
  if (!fromValidation.ok) return { ok: false, error: fromValidation.error };
  const toValidation = validateInputs(input.projectDir, input.toFolder, input.toName);
  if (!toValidation.ok) return { ok: false, error: toValidation.error };

  const from = templatePaths(input.projectDir, fromValidation.folderRel, input.fromName);
  const to = templatePaths(input.projectDir, toValidation.folderRel, input.toName);

  if (from.filePath === to.filePath) {
    return {
      ok: false,
      error: { code: 'NOOP', message: 'Source and destination are the same template.' },
    };
  }
  if (!existsSync(from.filePath)) {
    return {
      ok: false,
      error: {
        code: 'TEMPLATE_NOT_FOUND',
        message: `No template at ${relPathOf(input.projectDir, from.filePath)}.`,
      },
    };
  }
  if (existsSync(to.filePath)) {
    return {
      ok: false,
      error: {
        code: 'TEMPLATE_EXISTS',
        message: `A template already exists at ${relPathOf(input.projectDir, to.filePath)}.`,
      },
    };
  }

  try {
    mkdirSync(to.templatesDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to create destination template directory at ${relPathOf(input.projectDir, to.templatesDir)}: ${(err as Error).message}`,
      },
    };
  }

  let committed: boolean;
  try {
    committed = await input.relocate(from.filePath, to.filePath);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'MOVE_FAILED',
        message: `Failed to move template: ${(err as Error).message}`,
      },
    };
  }

  // Source dirs may now be empty (last template left the folder).
  const cleanedEmpty = cleanEmptyOkDirs(from.templatesDir, from.okDir);

  return {
    ok: true,
    fromPath: relPathOf(input.projectDir, from.filePath),
    toPath: relPathOf(input.projectDir, to.filePath),
    committed,
    cleanedEmpty,
  };
}

function validateInputs(
  projectDir: string,
  folder: string,
  name: string,
): { ok: true; folderRel: string } | { ok: false; error: { code: string; message: string } } {
  if (!isAbsolute(projectDir)) {
    return {
      ok: false,
      error: { code: 'BAD_PROJECT_DIR', message: 'projectDir must be absolute' },
    };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: {
        code: 'BAD_NAME',
        message: `Template name must match /^[A-Za-z0-9_-]+$/ (got: ${JSON.stringify(name)}). Use letters, digits, underscores, or hyphens — no slashes, dots, or spaces.`,
      },
    };
  }

  const folderNormalized = folder
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '');
  if (folderNormalized.includes('..')) {
    return {
      ok: false,
      error: {
        code: 'PATH_TRAVERSAL',
        message: `Folder path may not contain "..": ${JSON.stringify(folder)}`,
      },
    };
  }
  // Re-resolve and confirm we stay under projectDir.
  const folderAbs = folderNormalized ? resolve(projectDir, folderNormalized) : projectDir;
  const projectAbs = resolve(projectDir);
  if (!folderAbs.startsWith(projectAbs + sep) && folderAbs !== projectAbs) {
    return {
      ok: false,
      error: {
        code: 'PATH_ESCAPE',
        message: `Resolved folder path escapes projectDir: ${folderAbs}`,
      },
    };
  }
  return { ok: true, folderRel: folderNormalized };
}

function validateTitle(
  title: unknown,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (typeof title !== 'string' || title.length === 0) {
    return {
      ok: false,
      error: {
        code: 'TEMPLATE_TITLE_REQUIRED',
        message:
          'Template frontmatter.title is required. `title` is the menu surface — agents pick templates by name+title; a title-less template is effectively invisible. Set a non-empty `title` and retry.',
      },
    };
  }
  return { ok: true };
}

function validateSubstitutionAllowlist(
  body: string,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  const errors = validateSubstitution(body);
  if (errors.length === 0) return { ok: true };
  const offenders = errors.map((e) => `\`{{${e.token}}}\` at offset ${e.offset}`).join(', ');
  return {
    ok: false,
    error: {
      code: 'TEMPLATE_UNKNOWN_VARIABLE',
      message: `Template body contains unknown substitution token(s): ${offenders}. v1 allowlist: \`{{date}}\`, \`{{user}}\`. Remove or rename the offending tokens and retry.`,
    },
  };
}

function templatePaths(
  projectDir: string,
  folderRel: string,
  name: string,
): { okDir: string; templatesDir: string; filePath: string } {
  const okDir = folderRel ? join(projectDir, folderRel, '.ok') : join(projectDir, '.ok');
  const templatesDir = join(okDir, 'templates');
  const filePath = join(templatesDir, `${name}.md`);
  return { okDir, templatesDir, filePath };
}

function relPathOf(projectDir: string, abs: string): string {
  const rel = abs.startsWith(projectDir + sep) ? abs.slice(projectDir.length + 1) : abs;
  return normalize(rel).split(sep).join('/');
}

/**
 * Reject a top-level `template:` key inside the starter content's
 * doc-frontmatter — it is reserved for the template's own identity in the
 * single-block file, and a duplicate would corrupt the merged block.
 */
function validateNoReservedDocKey(
  body: string,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  const { frontmatter } = stripFrontmatter(body);
  if (frontmatter === '') return { ok: true };
  const inner = unwrapFrontmatterFences(frontmatter);
  if (new RegExp(`^${TEMPLATE_IDENTITY_KEY}:`, 'm').test(inner)) {
    return {
      ok: false,
      error: {
        code: 'TEMPLATE_RESERVED_KEY',
        message: `Template starter content may not declare a top-level \`${TEMPLATE_IDENTITY_KEY}:\` frontmatter key — it is reserved for the template's identity.`,
      },
    };
  }
  return { ok: true };
}

function isEmpty(absDir: string): boolean {
  try {
    return readdirSync(absDir).length === 0;
  } catch {
    return false;
  }
}
