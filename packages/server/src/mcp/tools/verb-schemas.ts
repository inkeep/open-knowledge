/**
 * Shared leaves + teaching-error helpers for the CRUD verb tools
 * (`write` / `edit` / `delete` / `move`).
 *
 * Anti-confusion design (Pattern B): each verb nests a target's fields inside
 * its address key (`document` / `folder` / `template` / `asset`) so the
 * per-target REQUIRED fields are visible in the JSON Schema the model reads.
 * The one irreducible soft constraint — "pass exactly one target" — can't be
 * compiled to JSON Schema by the MCP SDK (no `z.discriminatedUnion` / "exactly
 * one key"), so it is stated in each tool's top-level description AND enforced
 * by a teaching error here, so any miss self-corrects on the next call.
 *
 * One argument vocabulary across all verbs: `document` / `folder` / `template`
 * / `asset` addressing, `content` / `frontmatter` / `from` / `to`, and a
 * single `frontmatter` merge-patch shape reused from the doc frontmatter
 * schema (`FrontmatterPatchSchema` in core) so doc + folder + template
 * frontmatter behave identically.
 */

import {
  type FrontmatterValue,
  FrontmatterValueSchema,
  MANAGED_ARTIFACT_SCOPES,
  SKILL_NAME_REGEX,
  TEMPLATE_NAME_REGEX,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';

/**
 * Frontmatter merge-patch value: the canonical recursive doc-frontmatter
 * value union (scalar | scalar[] | nested map | array of nested maps) plus
 * `null` as the RFC 7396 delete sentinel at the TOP level of the patch.
 * Shared by every verb's `frontmatter` field so doc, folder, and template
 * frontmatter validate identically.
 *
 * Nested merge is whole-subtree REPLACE — a nested object at a top-level key
 * replaces the existing subtree at that key. A nested null INSIDE a subtree
 * is rejected; to delete a single nested leaf, send the full subtree without
 * that leaf, or null out the whole top-level key to drop the subtree.
 */
/** The real per-value contract: a recursive frontmatter value, or top-level `null` (RFC 7396 delete). */
const FrontmatterPatchValue = z.union([FrontmatterValueSchema, z.null()]);

/**
 * Flat, ref-free ADVERTISED shape for the frontmatter value. Superset of what
 * {@link FrontmatterPatchValue} admits at the top level (array/object leaves are
 * open), so the `.superRefine` below narrows it to the exact recursive contract
 * without the base union ever pre-rejecting a valid value.
 *
 * Why not just advertise the recursive schema: a self-referential Zod schema
 * serializes to `$ref: "#/definitions/__schema0"` in the tool's JSON Schema.
 * Constrained-decoding MCP hosts (LM Studio) and some function-calling APIs
 * (Gemini) can't resolve a `$ref` inside a tool schema and reject the whole
 * tool. This flat union carries no `$ref`, and refinements don't appear in JSON
 * Schema — so the wire schema stays portable while runtime validation is
 * unchanged for every client and every write path (write-with-inline-content
 * and folder frontmatter have no downstream value gate, so this IS the gate).
 */
// The runtime union is the real schema the SDK serializes (flat, ref-free) and
// the `.superRefine` validates against the recursive contract — so pinning the
// INFERRED output type to the recursive `FrontmatterValue | null` is sound and
// keeps every consuming handler typed against the canonical frontmatter value.
const FrontmatterAdvertisedValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
  z.null(),
]) as unknown as z.ZodType<FrontmatterValue | null>;

/** A frontmatter merge-patch map with an instructive description + example. */
export const FrontmatterArg = z
  .record(z.string(), FrontmatterAdvertisedValue)
  .superRefine((patch, ctx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!FrontmatterPatchValue.safeParse(value).success) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            'invalid frontmatter value — allowed: a scalar (string | number | boolean), a scalar array, ' +
            'a nested object, or an array of objects; a top-level key may be null to delete it, but nested null is not allowed',
        });
      }
    }
  })
  .describe(
    'Metadata as a key→value map. Values may be a scalar (string | number | boolean), a scalar array, ' +
      'a nested object, or an array of objects. Merge-patch: include a top-level key to set it, set a ' +
      'top-level key to null to delete it; keys you omit are unchanged. A nested object REPLACES the ' +
      'existing subtree at that key (send the full subtree you want). ' +
      'Example: { title: "Q3 Planning", tags: ["planning"], metadata: { version: "1.0", author: "Inkeep" } }.',
  );

/** Where written content lands in a document body. */
const POSITIONS = ['append', 'prepend', 'replace'] as const;
export const PositionArg = z
  .enum(POSITIONS)
  .describe(
    'Where content lands. replace = overwrite the whole body (default for a new doc; required for an existing doc). ' +
      'append / prepend = add to the end / start.',
  );

/**
 * On-disk file format for a NEW document. Single-sourced from the canonical
 * `SUPPORTED_DOC_EXTENSIONS` so the MCP field, the file format the engine
 * writes, and the supported-extension list can never drift apart.
 * Honored only on a pure create; an existing doc keeps its recorded extension.
 */
export const DocExtensionArg = z
  .enum(SUPPORTED_DOC_EXTENSIONS)
  .describe(
    'File format for a NEW doc: `.md` (default) or `.mdx` (Markdown + JSX components). ' +
      'Honored only on create — an existing doc keeps its on-disk extension. ' +
      'Takes precedence over an extension typed into `path`.',
  );

/**
 * Split an addressing `path` into its parent folder (the slashes — where it
 * goes) and its final segment (the name — what it is). Every verb target is
 * addressed by `path`; the handler resolves the per-kind storage from this
 * split (a document → `<path>.md`; a template → `<folder>/.ok/templates/<name>.md`;
 * an asset → `<folder>/<name>`).
 */
export function splitTargetPath(path: string): { folder: string; name: string } {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx === -1
    ? { folder: '', name: clean }
    : { folder: clean.slice(0, idx), name: clean.slice(idx + 1) };
}

// Template name grammar (`TEMPLATE_NAME_REGEX`) is the canonical core export —
// `resolveTemplatePath` below validates the final path segment against it.
export const TEMPLATE_PATH_DESCRIBE =
  'Template path = `<folder>/<name>` (e.g. "fishing-log/trip-log"). The slashes are the folder it belongs to; the final segment is the template name (letters, digits, `_`, `-` only — no dots/spaces). Stored at `<folder>/.ok/templates/<name>.md`.';
export const TEMPLATE_CONTENT_DESCRIBE =
  "Starter content — the Markdown a new document becomes. A leading `---…---` frontmatter block here sets the STARTING PROPERTIES every doc created from this template gets (e.g. `type`, `status`, `tags`); the markdown below it is the body. The template's own picker identity (title/description) is the separate `frontmatter` field, NOT this block — it is stripped at instantiation and never copied onto created docs. (On disk this composes to one frontmatter block with the identity under a reserved `template:` key; you don't author that — just give the starter content here.) Only the `{{date}}` and `{{user}}` substitution tokens are allowed; any other `{{...}}` token hard-errors at write time.";

/**
 * Resolve a template `path` into its folder + name, validating the final
 * segment against the template-name grammar. Returns a teaching-error message
 * (not a throw) on a bad name, so write / edit / delete share one rule.
 */
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

// ─────────────────────────── skill target ───────────────────────────
// Skills are addressed by `name` (their identity == directory under
// `.ok/skills/`) plus an optional `scope`, NOT a folder path — a skill has no
// leaf-to-root walk. Frontmatter is the Agent Skills schema (`name` +
// `description`); the verb tools pass `name` / `description` / `body`
// separately and the server composes the SKILL.md.

export const SKILL_NAME_DESCRIBE =
  'Skill name — the skill\'s identity AND its directory under `.ok/skills/<name>/`. Lowercase letters, digits, hyphens only (≤64 chars; no slashes, dots, spaces, or uppercase). Example: "trip-log".';
export const SKILL_DESCRIPTION_DESCRIBE =
  'One-line description (≤1024 chars) — the PRIMARY triggering surface telling an agent WHEN to use this skill. No XML tags (`<...>`), which break the skill loader.';
export const SKILL_BODY_DESCRIBE =
  'SKILL.md body (markdown guidance). Authored WITHOUT frontmatter — `name` + `description` are passed separately and composed server-side. Keep under ~500 lines; move depth into one-level-deep `references/`.';
// Local — only consumed by `SkillScopeArg` below.
const SKILL_SCOPE_DESCRIBE =
  'Level: "project" (default — a Project skill: lives in this KB\'s `.ok/skills/`, shared with teammates via git) or "global" (a Global skill: your user-level `~/.ok/skills/` store, available in every project on this machine — not shared, not version-tracked). Pass the literal value "global" for a Global skill.';

/**
 * Shared skill `scope` argument for the CRUD verb tools — the single source for
 * the enum (derived from the canonical `MANAGED_ARTIFACT_SCOPES`) plus the
 * standard describe. Tools use `SkillScopeArg.optional()`; a tool needing a
 * different describe (e.g. `move`'s `toScope`) reuses the bare
 * `z.enum(MANAGED_ARTIFACT_SCOPES)` so the value list still single-sources here.
 */
export const SkillScopeArg = z.enum(MANAGED_ARTIFACT_SCOPES).describe(SKILL_SCOPE_DESCRIBE);

/**
 * Validate a skill `name` against the name grammar. Returns a teaching-error
 * message (not a throw) on a bad name so write / edit / delete / move share
 * one rule (mirrors `resolveTemplatePath`).
 */
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

// ─────────────────────────── skill bundle files ───────────────────────────
// A skill is a DIRECTORY: `SKILL.md` (authored via `body`) plus optional
// one-level `references/**` + `scripts/**`. Bundle files are addressed by a
// SKILL-RELATIVE path (`references/x.md`, `scripts/run.sh`) — agents never see
// or pass `.ok/...` paths; the verb maps the relative path onto the on-disk
// skill dir. The allowlist below is the single safety gate every bundle-file
// verb (write / edit / delete / read) funnels through.

export const SKILL_FILES_DESCRIBE =
  'Bundle files to write beside `SKILL.md`, as an ARRAY of `{ path, content }` (consistent with `documents`/`asset`). ' +
  '`path` is SKILL-RELATIVE and MUST live under `references/` or `scripts/` (e.g. "references/tiers.md", "scripts/run.sh") — ' +
  'no `../`, no absolute paths, no other top-level dir. `content` is the full text. Text only (no binary). ' +
  'Independent of `body`: write one reference without resending SKILL.md.';
export const SKILL_FILE_DESCRIBE =
  'A single SKILL-RELATIVE bundle file path under `references/` or `scripts/` (e.g. "references/tiers.md"). ' +
  'For `edit`, names the one bundle file to find/replace in; for `skills`, the one file to read.';

/** A bundle file is a `reference` (under `references/`) or a `script` (under `scripts/`). */
export type SkillFileKind = 'reference' | 'script';

/**
 * Validate + normalize a SKILL-RELATIVE bundle-file path against the allowlist:
 * it must sit under `references/` or `scripts/`, carry a non-empty leaf, and
 * never escape (no `..` segments, no absolute path, no NUL). Returns the
 * normalized POSIX-relative path + its `kind`, or a teaching error (not a
 * throw) so write / edit / delete / read share one rule (mirrors
 * `resolveTemplatePath`). `SKILL.md` is rejected here — it is authored via
 * `body`, never as a bundle file.
 */
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
  // Normalize separators + collapse, then reject any `..` segment lexically.
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

/**
 * Enforce the "exactly one target" soft constraint with a teaching error.
 * Returns a corrective message (the exact shape to retry with) when zero or
 * more than one target key is present, or `null` when exactly one is present.
 */
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
