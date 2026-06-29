import {
  FrontmatterValueSchema,
  MANAGED_ARTIFACT_SCOPES,
  SKILL_NAME_REGEX,
  TEMPLATE_NAME_REGEX,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';

const FrontmatterPatchValue = z.union([FrontmatterValueSchema, z.null()]);

export const FrontmatterArg = z
  .record(z.string(), FrontmatterPatchValue)
  .describe(
    'Metadata as a key→value map. Values may be a scalar (string | number | boolean), a scalar array, ' +
      'a nested object, or an array of objects. Merge-patch: include a top-level key to set it, set a ' +
      'top-level key to null to delete it; keys you omit are unchanged. A nested object REPLACES the ' +
      'existing subtree at that key (send the full subtree you want). ' +
      'Example: { title: "Q3 Planning", tags: ["planning"], metadata: { version: "1.0", author: "Inkeep" } }.',
  );

const POSITIONS = ['append', 'prepend', 'replace'] as const;
export const PositionArg = z
  .enum(POSITIONS)
  .describe(
    'Where content lands. replace = overwrite the whole body (default for a new doc; required for an existing doc). ' +
      'append / prepend = add to the end / start.',
  );

export const DocExtensionArg = z
  .enum(SUPPORTED_DOC_EXTENSIONS)
  .describe(
    'File format for a NEW doc: `.md` (default) or `.mdx` (Markdown + JSX components). ' +
      'Honored only on create — an existing doc keeps its on-disk extension. ' +
      'Takes precedence over an extension typed into `path`.',
  );

export function splitTargetPath(path: string): { folder: string; name: string } {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx === -1
    ? { folder: '', name: clean }
    : { folder: clean.slice(0, idx), name: clean.slice(idx + 1) };
}

export const TEMPLATE_PATH_DESCRIBE =
  'Template path = `<folder>/<name>` (e.g. "fishing-log/trip-log"). The slashes are the folder it belongs to; the final segment is the template name (letters, digits, `_`, `-` only — no dots/spaces). Stored at `<folder>/.ok/templates/<name>.md`.';
export const TEMPLATE_CONTENT_DESCRIBE =
  "Starter content — the Markdown a new document becomes. A leading `---…---` frontmatter block here sets the STARTING PROPERTIES every doc created from this template gets (e.g. `type`, `status`, `tags`); the markdown below it is the body. The template's own picker identity (title/description) is the separate `frontmatter` field, NOT this block — it is stripped at instantiation and never copied onto created docs. (On disk this composes to one frontmatter block with the identity under a reserved `template:` key; you don't author that — just give the starter content here.) Only the `{{date}}` and `{{user}}` substitution tokens are allowed; any other `{{...}}` token hard-errors at write time.";

export function resolveTemplatePath(
  path: string,
): { ok: true; folder: string; name: string } | { ok: false; error: string } {
  const { folder, name } = splitTargetPath(path);
  if (!TEMPLATE_NAME_REGEX.test(name)) {
    return {
      ok: false,
      error: `the final segment of a template path is its name — "${name}" must be letters, digits, \`_\`, \`-\` only (no dots/spaces). e.g. { template: { path: "fishing-log/trip-log" } }.`,
    };
  }
  return { ok: true, folder, name };
}

export const SKILL_NAME_DESCRIBE =
  'Skill name — the skill\'s identity AND its directory under `.ok/skills/<name>/`. Lowercase letters, digits, hyphens only (≤64 chars; no slashes, dots, spaces, or uppercase). Example: "trip-log".';
export const SKILL_DESCRIPTION_DESCRIBE =
  'One-line description (≤1024 chars) — the PRIMARY triggering surface telling an agent WHEN to use this skill. No XML tags (`<...>`), which break the skill loader.';
export const SKILL_BODY_DESCRIBE =
  'SKILL.md body (markdown guidance). Authored WITHOUT frontmatter — `name` + `description` are passed separately and composed server-side. Keep under ~500 lines; move depth into one-level-deep `references/`.';
const SKILL_SCOPE_DESCRIBE =
  'Level: "project" (default — a Project skill: lives in this KB\'s `.ok/skills/`, shared with teammates via git) or "global" (a Global skill: your user-level `~/.ok/skills/` store, available in every project on this machine — not shared, not version-tracked). Pass the literal value "global" for a Global skill.';

export const SkillScopeArg = z.enum(MANAGED_ARTIFACT_SCOPES).describe(SKILL_SCOPE_DESCRIBE);

export function resolveSkillName(
  name: string,
): { ok: true; name: string } | { ok: false; error: string } {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 64 ||
    !SKILL_NAME_REGEX.test(name)
  ) {
    return {
      ok: false,
      error: `a skill name must be lowercase letters, digits, and hyphens (≤64 chars, no slashes/dots/spaces/uppercase) — ${JSON.stringify(name)} is invalid. e.g. { skill: { name: "trip-log" } }.`,
    };
  }
  return { ok: true, name };
}

export const SKILL_FILES_DESCRIBE =
  'Bundle files to write beside `SKILL.md`, as an ARRAY of `{ path, content }` (consistent with `documents`/`asset`). ' +
  '`path` is SKILL-RELATIVE and MUST live under `references/` or `scripts/` (e.g. "references/tiers.md", "scripts/run.sh") — ' +
  'no `../`, no absolute paths, no other top-level dir. `content` is the full text. Text only (no binary). ' +
  'Independent of `body`: write one reference without resending SKILL.md.';
export const SKILL_FILE_DESCRIBE =
  'A single SKILL-RELATIVE bundle file path under `references/` or `scripts/` (e.g. "references/tiers.md"). ' +
  'For `edit`, names the one bundle file to find/replace in; for `skills`, the one file to read.';

export type SkillFileKind = 'reference' | 'script';

export function resolveSkillFilePath(
  path: string,
): { ok: true; path: string; kind: SkillFileKind } | { ok: false; error: string } {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'a skill file `path` is required (e.g. "references/tiers.md").' };
  }
  if (path.includes('\x00')) {
    return { ok: false, error: 'a skill file `path` may not contain a NUL byte.' };
  }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    return {
      ok: false,
      error: `a skill file \`path\` must be skill-relative, not absolute — "${path}" is rejected. e.g. { path: "references/tiers.md" }.`,
    };
  }
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    return {
      ok: false,
      error: `a skill file \`path\` may not contain ".." — "${path}" could escape the skill dir. Allowed roots: references/, scripts/.`,
    };
  }
  const top = segments[0];
  if (top !== 'references' && top !== 'scripts') {
    return {
      ok: false,
      error: `a skill file \`path\` must start with \`references/\` or \`scripts/\` — "${path}" is not allowed. SKILL.md is authored via \`body\`.`,
    };
  }
  if (segments.length < 2) {
    return {
      ok: false,
      error: `a skill file \`path\` needs a file under \`${top}/\` (e.g. "${top}/notes.md") — "${path}" names only the directory.`,
    };
  }
  return {
    ok: true,
    path: segments.join('/'),
    kind: top === 'scripts' ? 'script' : 'reference',
  };
}

export function exactlyOneTargetError(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  const present = keys.filter((k) => args[k] !== undefined);
  if (present.length === 1) return null;
  const quoted = keys.map((k) => `\`${k}\``).join(', ');
  if (present.length === 0) {
    return (
      `Name exactly one of ${quoted} — the one thing you are addressing. ` +
      "Nest that target's fields under its key (e.g. `{ document: { path, … } }`); " +
      "see this tool's parameter docs for which fields each target takes."
    );
  }
  return `You named ${present.map((k) => `\`${k}\``).join(' and ')} — name exactly ONE target.`;
}
