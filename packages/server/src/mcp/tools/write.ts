/**
 * `write` MCP tool — create or overwrite one thing, polymorphic over
 * `document` / `folder` / `template` / `skill` / `asset` (Pattern B: each target's
 * fields nest inside its address key so the per-target required fields are
 * visible in the JSON Schema the model reads).
 *
 * Backends by target:
 *   - document → CRDT (`POST /api/agent-write-md`) [Requires: Hocuspocus]
 *   - folder   → `POST /api/create-folder` (mkdir) + `PUT /api/folder-config` frontmatter (attributed) [Requires: Hocuspocus]
 *   - template → `PUT /api/template` (server, attributed) → `<folder>/.ok/templates/<name>.md`
 *   - skill    → `PUT /api/skill` (server, attributed) → `.ok/skills/<name>/SKILL.md` (authored via the `skill` target, never a raw `document` path under `.ok/skills/`)
 *   - asset    → multipart `POST /api/upload` [Requires: Hocuspocus]
 *
 * The "exactly one target" constraint is the one soft constraint the SDK
 * can't compile to JSON Schema; a miss returns a teaching error with the
 * corrective shape.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  type DocExtension,
  type FrontmatterMap,
  type FrontmatterPatch,
  instantiateDoc,
  normalizeBridge,
  parseFrontmatterYaml,
  renderInventoryFooter,
  serializeFrontmatterMap,
  stripFrontmatter,
  unwrapFrontmatterFences,
  withFences,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { resolveContentDir, resolveLockDir } from '../../config/paths.ts';
import { mergePatch } from '../../content/frontmatter-merge.ts';
import { parentFolderOf } from '../../content/nested-folder-rules.ts';
import { applySubstitution, todayIsoUtc } from '../../content/substitution.ts';
import { resolveTemplatesAvailable } from '../../content/templates-resolver.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import {
  formatAdvisoryBriefs,
  formatAdvisoryLines,
  formatBrokenLinkBrief,
  formatBrokenLinkLines,
  parseAdvisoryWarnings,
  parseBrokenLinks,
} from './advisory-warnings.ts';
import { buildPreviewAttachWarning, resolvePreviewUrl, START_UI_TEXT_HINT } from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  agentIdentityFields,
  docExtensionOnDisk,
  documentResultBaseShape,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpPost,
  httpPut,
  looseObjectArray,
  nestDocResult,
  normalizeDocName,
  okReservedPathRedirect,
  outputSchemaWithText,
  previewAttachWarningField,
  previewUrlOutputField,
  previewUrlSourceField,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  summaryArgSchema,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { writeSkill, writeSkillFile } from './skill-target.ts';
import {
  DocExtensionArg,
  exactlyOneTargetError,
  FrontmatterArg,
  PositionArg,
  resolveSkillFilePath,
  resolveTemplatePath,
  SKILL_BODY_DESCRIBE,
  SKILL_DESCRIPTION_DESCRIBE,
  SKILL_FILES_DESCRIBE,
  SKILL_NAME_DESCRIBE,
  SkillScopeArg,
  splitTargetPath,
  TEMPLATE_CONTENT_DESCRIBE,
  TEMPLATE_PATH_DESCRIBE,
} from './verb-schemas.ts';

const BASE_DESCRIPTION = [
  'Create or replace one thing. Pass EXACTLY ONE of `document`, `folder`, `template`, `skill`, or `asset` (or `documents` for a batch of docs).',
  '',
  '- `document` — Create or overwrite a doc via the CRDT layer [Requires: Hocuspocus server]. `{ path, content }`, or `{ path, template }` to instantiate from a folder template (mutually exclusive with `content`). Optional `frontmatter` (its own YAML) and `position` (`replace` default for a new doc; required for an existing one) — note supplying `frontmatter` alongside literal `content` forces `position: replace` (the only position that persists a YAML block), overriding an explicit `append`/`prepend`. Example: `{ document: { path: "meetings/standup", content: "# Standup\\n..." } }`.',
  '- `folder` — Create a NEW folder (optionally with its own properties) [Requires: Hocuspocus server]. `{ path, frontmatter? }`. To change an EXISTING folder use `edit`. Example: `{ folder: { path: "ideas" } }`.',
  '- `template` — Create a reusable starting shape for new docs in a folder. `{ path: "<folder>/<name>", content, frontmatter: { title, description?, tags? } }`.',
  '- `skill` — Create or overwrite an agent SKILL (`.ok/skills/<name>/SKILL.md`): reusable agent guidance you author in OK and `install` into your editors. `{ name, description, body, scope? }`. `name` is the identity (lowercase-hyphen); `description` is the trigger (when to use it). Example: `{ skill: { name: "trip-log", description: "Use when logging a fishing trip.", body: "# Steps\\n..." } }`.',
  '- `asset` — Upload a binary (image/file) via the media route [Requires: Hocuspocus server]. `{ path: "<folder>/<file.ext>", content(base64) | source(local path) }`.',
  '- `documents` — Batch: `[{ path, content?|template?, frontmatter?, position?, summary? }, ...]` written in order; the response reports each.',
  '- `summary` — Optional one-line user-outcome (≤80 chars) for the timeline, for a single `document`/`folder`/`template`/`asset` write. For a `documents` batch, give each entry its own `summary` instead (a top-level `summary` is ignored on the batch path). Avoid secrets or PII — persisted to git history.',
  '',
  'Responses may include `structuredContent.document.warnings` (batch: per-entry under `documents[]`) — advisory entries discriminated by `kind`: `content-divergence` / `disk-edit-reconciled` (write-integrity — re-read the doc) and `mermaid-parse-error` (the write landed but that fence will not render — fix it and re-edit).',
].join('\n');

const DESCRIPTION = `${BASE_DESCRIPTION}\n${renderInventoryFooter()}`;

interface WriteDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

interface DocSpec {
  path: string;
  content?: string;
  template?: string;
  frontmatter?: FrontmatterPatch;
  position?: string;
  summary?: string;
  extension?: DocExtension;
}

type WriteApiResult = Awaited<ReturnType<typeof httpPost>>;

type WriteOneResult =
  | {
      docName: string;
      ok: true;
      position: string;
      fromTemplate?: string;
      extensionNote?: string;
      /**
       * Templates the parent folder offers, surfaced only on a create that
       * passed no `template`. Nudges the agent toward the folder's shape
       * without blocking the write that already landed.
       */
      templateHint?: readonly { name: string; description?: string }[];
      raw: WriteApiResult;
    }
  | { docName: string; ok: false; error: string };

// ─────────────────────────── doc-write helpers ───────────────────────────
// the document target of
// `write` preserves every guard (template instantiation, position-defaulting,
// extension coercion notes, empty-content rejection, frontmatter-ignored
// notes).

/**
 * A `---` frontmatter block in a `prepend`/`append` payload is dropped by the
 * CRDT write path (a second FM block would be invalid). Surface a note instead
 * of silently discarding it.
 */
function frontmatterIgnoredNote(position: string, markdown: string | undefined): string | null {
  if ((position !== 'prepend' && position !== 'append') || !markdown) return null;
  if (stripFrontmatter(markdown).frontmatter.trim() === '') return null;
  return `Note: a \`---\` frontmatter block in this \`${position}\` payload was ignored — frontmatter is written only with \`position: "replace"\`. To change frontmatter, use \`edit({ document: { path, frontmatter } })\` (patch) or \`write({ document: { path, content, position: "replace" } })\` (full rewrite).`;
}

/** An `append`/`prepend` whose body is empty is a server-side no-op. */
function emptyAppendNoOpNote(position: string, markdown: string | undefined): string | null {
  if ((position !== 'prepend' && position !== 'append') || markdown === undefined) return null;
  if (stripFrontmatter(markdown).body !== '') return null;
  return `No content to ${position} — document unchanged. To clear a document, use \`position: "replace"\` with empty \`content\`.`;
}

/** The supported extension the caller typed on the raw name, or null. */
function requestedDocExtension(rawDocName: string): '.md' | '.mdx' | null {
  const lower = rawDocName.toLowerCase();
  if (lower.endsWith('.mdx')) return '.mdx';
  if (lower.endsWith('.md')) return '.md';
  return null;
}

function extensionIgnoredNote(
  requestedExt: '.md' | '.mdx' | null,
  existingExt: '.md' | '.mdx' | null,
  docName: string,
): string | null {
  if (requestedExt === null || existingExt === null || requestedExt === existingExt) return null;
  return `Note: "${docName}" already exists as \`${docName}${existingExt}\`, so the requested \`${requestedExt}\` extension was not applied — the write went to \`${docName}${existingExt}\`. Changing a doc's on-disk extension in place isn't available via the MCP today.`;
}

/**
 * Compose a `---\nYAML\n---\nbody` document. Used when `document.frontmatter`
 * accompanies literal `content`: `/api/agent-write-md` has no frontmatter
 * field, so the create writes the YAML block inline with `position: "replace"`
 * (the one position that persists frontmatter). Null/empty patch values are
 * dropped — a create has nothing to delete.
 *
 * When `body` already opens with its own `---…---` block, that block is the
 * base and the `frontmatter` param is overlaid on top (PATCH semantics: param
 * wins per key, empties drop, embedded-only keys survive), yielding a SINGLE
 * block — never a second block stacked on the first. A malformed embedded
 * block can't be merged, so it's rejected with a teaching error rather than
 * silently doubled.
 */
export function composeWithFrontmatter(
  frontmatter: FrontmatterPatch,
  body: string,
): { ok: true; markdown: string } | { ok: false; error: string } {
  const { frontmatter: embeddedFenced, body: cleanBody } = stripFrontmatter(body);

  let base: FrontmatterMap = {};
  if (embeddedFenced !== '') {
    const parsed = parseFrontmatterYaml(unwrapFrontmatterFences(embeddedFenced));
    if (parsed.map === null) {
      return {
        ok: false,
        error: `EMBEDDED_FRONTMATTER_MALFORMED — \`content\` opens with a \`---\` block whose YAML failed to parse (${parsed.parseError}), so it can't be merged with the \`frontmatter\` param. Fix the embedded YAML, or supply the frontmatter only via the \`frontmatter\` param (not also inline in \`content\`).`,
      };
    }
    base = parsed.map;
  }

  // `mergePatch` is param-wins: param values replace, param empties drop the
  // key, embedded-only keys survive. Matches the folder-frontmatter precedence.
  // `serializeFrontmatterMap` + `withFences` are the canonical FM codec the
  // bridge invariant depends on — empty map → no block, fence-less body.
  const merged = mergePatch(base, frontmatter as Record<string, unknown>) as FrontmatterMap;
  const yamlBody = serializeFrontmatterMap(merged);
  if (yamlBody === '') return { ok: true, markdown: cleanBody };
  return { ok: true, markdown: withFences(yamlBody) + cleanBody };
}

/** Write one document, returning a plain per-doc result (no MCP wrapping). */
async function writeOneDoc(
  spec: DocSpec,
  cwd: string,
  contentDir: string,
  url: string,
  deps: WriteDeps,
): Promise<WriteOneResult> {
  const normalized = normalizeDocName(spec.path);
  if (!normalized.ok) {
    return {
      docName: spec.path,
      ok: false,
      error: okReservedPathRedirect(spec.path) ?? normalized.error,
    };
  }
  const docName = normalized.docName;
  const identity = deps.identityRef?.current;

  if (spec.template === undefined && spec.content === undefined) {
    return {
      docName,
      ok: false,
      error:
        'either `content` or `template` must be provided — omitting both would write empty content.',
    };
  }
  if (spec.template !== undefined && spec.content !== undefined) {
    return {
      docName,
      ok: false,
      error:
        'TEMPLATE_AND_CONTENT_BOTH_SET — `template` and `content` are mutually exclusive. Pass one; fill placeholders via subsequent `edit` calls.',
    };
  }

  let effectiveMarkdown = spec.content ?? '';
  const hasFrontmatter = spec.frontmatter !== undefined && Object.keys(spec.frontmatter).length > 0;

  const existingExt = docExtensionOnDisk(contentDir, docName) ?? null;
  const docExists = existingExt !== null;
  // Explicit `extension` field wins over an extension typed into `path`; either
  // is honored only on a pure create (handled downstream at the forward below).
  const requestedExt = spec.extension ?? requestedDocExtension(spec.path);

  // Omitted `position` defaults to `replace` on create; rejected for an
  // existing doc so an omitted arg can't silently overwrite. Frontmatter
  // forces `replace` (the only position that persists a YAML block).
  let effectivePosition: string;
  if (spec.position !== undefined) {
    effectivePosition = spec.position;
  } else if (docExists) {
    return {
      docName,
      ok: false,
      error: `"${docName}" already exists — pass \`position\` (\`append\` | \`prepend\` | \`replace\`), or use \`edit\` for a targeted change.`,
    };
  } else {
    effectivePosition = 'replace';
  }

  // Nudge: creating a doc in a folder that ships templates, but reaching for
  // none. Templates only get used if the agent knows they exist, and it may
  // write from memory without an `exec ls` first — so surface the folder's menu
  // on the write itself. Create-only (an overwrite/append is deliberate) and
  // skipped when a template WAS used.
  let templateHint: readonly { name: string; description?: string }[] | undefined;
  if (spec.template === undefined && !docExists) {
    const available = resolveTemplatesAvailable(cwd, parentFolderOf(docName), { depth: 1 });
    if (available.length > 0) {
      templateHint = available.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
      }));
    }
  }

  if (spec.template !== undefined) {
    const parentFolder = parentFolderOf(docName);
    const available = resolveTemplatesAvailable(cwd, parentFolder, { depth: 1 });
    const matched = available.find((t) => t.name === spec.template);
    if (!matched) {
      return {
        docName,
        ok: false,
        error: `template "${spec.template}" not found for folder "${parentFolder || '.'}". Available: ${
          available.length === 0
            ? '(none)'
            : available.map((t) => `${t.name} [${t.scope}]`).join(', ')
        }. Templates are resolved by walk-up; check the parent folder's exec listing to see the menu.`,
      };
    }
    let templateContent: string;
    try {
      templateContent = readFileSync(resolvePath(cwd, matched.path), 'utf-8');
    } catch (err) {
      return {
        docName,
        ok: false,
        error: `failed to read template at ${matched.path}: ${(err as Error).message}`,
      };
    }
    // The new doc IS the template's starter content (doc-frontmatter +
    // markdown) with the `template:` identity stripped. `instantiateDoc`
    // normalizes single-block and legacy two-block templates the same way and
    // preserves `{{date}}`/`{{user}}` tokens for substitution. (Plain
    // `stripFrontmatter` would drop the doc-frontmatter from a single-block
    // template, losing `type`/`status`/etc. on every created doc.)
    const templateBody = instantiateDoc(templateContent);
    effectiveMarkdown = applySubstitution(templateBody, {
      date: todayIsoUtc(),
      user: identity?.displayName ?? '',
    });
    effectivePosition = 'replace';
  } else if (hasFrontmatter) {
    // Literal content + own frontmatter: merge into a single YAML block and
    // force `replace` (the only position that persists frontmatter). If the
    // content already opens with its own block, it's merged, not stacked.
    const composed = composeWithFrontmatter(
      spec.frontmatter as FrontmatterPatch,
      effectiveMarkdown,
    );
    if (!composed.ok) return { docName, ok: false, error: composed.error };
    effectiveMarkdown = composed.markdown;
    effectivePosition = 'replace';
  }

  // Empty content on a NON-EXISTENT doc creates nothing (phantom-doc guard).
  if (!docExists && normalizeBridge(effectiveMarkdown) === '') {
    return {
      docName,
      ok: false,
      error: `"${docName}" does not exist and the content is empty — provide non-empty content to create the document.`,
    };
  }

  const result = await httpPost(url, '/api/agent-write-md', {
    docName,
    markdown: effectiveMarkdown,
    position: effectivePosition,
    ...(requestedExt !== null && !docExists ? { extension: requestedExt } : {}),
    ...(spec.summary !== undefined ? { summary: spec.summary } : {}),
    ...agentIdentityFields(identity),
  });
  if (!result.ok) {
    const detail =
      typeof result.detail === 'string' && result.detail.length > 0 ? result.detail : '';
    return {
      docName,
      ok: false,
      error: detail ? `${String(result.error)} (${detail})` : String(result.error),
    };
  }

  // Template path + own frontmatter: the template body became the doc, so the
  // doc's own frontmatter is applied as a follow-up merge-patch.
  if (spec.template !== undefined && hasFrontmatter) {
    const fmResult = await httpPost(url, '/api/frontmatter-patch', {
      docName,
      patch: spec.frontmatter,
      ...agentIdentityFields(identity),
    });
    if (!fmResult.ok) {
      return {
        docName,
        ok: false,
        error: `document created from template but frontmatter failed: ${String(fmResult.error)}`,
      };
    }
  }

  const extensionNote = extensionIgnoredNote(requestedExt, existingExt, docName);
  return {
    docName,
    ok: true,
    position: effectivePosition,
    ...(spec.template !== undefined ? { fromTemplate: spec.template } : {}),
    ...(extensionNote ? { extensionNote } : {}),
    ...(templateHint ? { templateHint } : {}),
    raw: result,
  };
}

/**
 * One-line nudge listing a folder's available templates. Info (`ℹ`), not a
 * warning (`⚠`) — the write landed; this only points at a cleaner next time.
 */
function formatTemplateHintLine(hint: readonly { name: string; description?: string }[]): string {
  const list = hint
    .map((t) => (t.description ? `${t.name} (${t.description})` : t.name))
    .join(', ');
  return `ℹ This folder has templates you can start from: ${list}. Pass \`template: "${hint[0]?.name ?? ''}"\` next time to match the folder's shape (the doc still landed).`;
}

// ─────────────────────────── target handlers ───────────────────────────

async function handleFolder(
  folder: { path: string; frontmatter?: FrontmatterPatch },
  summary: string | undefined,
  url: string | undefined,
  deps: WriteDeps,
) {
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  const identity = deps.identityRef?.current;
  const result = await httpPost(url, '/api/create-folder', {
    path: folder.path,
    ...(summary !== undefined ? { summary } : {}),
    ...agentIdentityFields(identity),
  });
  if (!result.ok) {
    const detail =
      typeof result.detail === 'string' && result.detail.length > 0 ? result.detail : '';
    return textResult(
      detail ? `Error: ${result.error} (${detail})` : `Error: ${result.error}`,
      true,
    );
  }

  const lines = [`Created folder ${folder.path}.`];
  if (folder.frontmatter !== undefined && Object.keys(folder.frontmatter).length > 0) {
    // Folder properties route through PUT /api/folder-config so the write is
    // attributed in the folder timeline (the create-folder already
    // requires the server). On a fresh folder the merge over `{}` is a set.
    const fm = await httpPut(url, '/api/folder-config', {
      path: folder.path,
      frontmatter: folder.frontmatter,
      ...(summary !== undefined ? { summary } : {}),
      ...agentIdentityFields(identity),
    });
    if (!fm.ok) {
      // The folder itself was created — only the secondary frontmatter write
      // failed. Returning `isError` would make agents retry the whole `write`
      // and hit a 409. Report success with a partial-failure detail so the
      // recovery is the narrow `edit({ folder: { frontmatter } })`.
      return textPlusStructured(
        `Created folder ${folder.path}, but writing its properties failed: ${fm.error}. Use edit({ folder: { path: "${folder.path}", frontmatter } }) to retry the properties.`,
        { folder: { ok: true, path: folder.path, frontmatterError: String(fm.error) } },
      );
    }
    lines.push(`Set folder properties (${folder.path}/.ok/frontmatter.yml).`);
  }
  return textPlusStructured(lines.join('\n'), { folder: { ok: true, path: folder.path } });
}

async function handleTemplate(
  template: {
    path: string;
    content: string;
    frontmatter: { title: string } & Record<string, unknown>;
  },
  summary: string | undefined,
  url: string | undefined,
  deps: WriteDeps,
) {
  const resolved = resolveTemplatePath(template.path);
  if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
  const { folder, name } = resolved;
  // Server-routed (PUT /api/template) so the create/overwrite is attributed in
  // the folder timeline. Requires the server, like every attributed mutation.
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  const result = await httpPut(url, '/api/template', {
    folder,
    name,
    body: template.content,
    frontmatter: {
      title: template.frontmatter.title,
      ...(typeof template.frontmatter.description === 'string'
        ? { description: template.frontmatter.description }
        : {}),
      ...(Array.isArray(template.frontmatter.tags)
        ? { tags: template.frontmatter.tags as string[] }
        : {}),
    },
    ...(summary !== undefined ? { summary } : {}),
    ...agentIdentityFields(deps.identityRef?.current),
  });
  if (!result.ok) {
    return textResult(`Error: ${result.error}`, true);
  }
  const created = result.created === true;
  const path = typeof result.path === 'string' ? result.path : undefined;
  return textPlusStructured(
    `${created ? 'Created' : 'Updated'} template "${name}" in ${folder || '(root)'}${path ? ` (${path})` : ''}.`,
    { template: { ok: true, path, created } },
  );
}

async function handleAsset(
  asset: { path: string; content?: string; source?: string },
  cwd: string,
  url: string | undefined,
  deps: WriteDeps,
) {
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  if ((asset.content === undefined) === (asset.source === undefined)) {
    return textResult(
      'Error: provide exactly one of `content` (base64) or `source` (local file path) for an asset.',
      true,
    );
  }
  let bytes: Buffer;
  try {
    bytes =
      asset.content !== undefined
        ? Buffer.from(asset.content, 'base64')
        : readFileSync(resolvePath(cwd, asset.source as string));
  } catch (err) {
    return textResult(`Error: could not read asset bytes: ${(err as Error).message}`, true);
  }
  if (bytes.byteLength === 0) {
    return textResult('Error: asset is empty (0 bytes).', true);
  }

  // `/api/upload` derives the destination folder from `dirname(parentDocName)`
  // and the filename from the file part. The asset path IS that target path:
  // the slashes are the folder, the final segment is the filename.
  const { folder, name: fileName } = splitTargetPath(asset.path);
  const parentDocName = folder ? `${folder}/${fileName}` : fileName;

  const identity = deps.identityRef?.current;
  const query = new URLSearchParams();
  if (identity?.connectionId) query.set('agentId', identity.connectionId);
  if (identity?.displayName) query.set('agentName', identity.displayName);
  const qs = query.toString();

  const form = new FormData();
  form.append('parentDocName', parentDocName);
  form.append('file', new Blob([new Uint8Array(bytes)]), fileName);

  let resBody: { ok: boolean; status: number; data?: Record<string, unknown>; error?: string };
  try {
    const res = await fetch(`${url}/api/upload${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      body: form,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    resBody = res.ok
      ? { ok: true, status: res.status, data: data ?? {} }
      : {
          ok: false,
          status: res.status,
          error:
            (data && (typeof data.title === 'string' ? data.title : (data.error as string))) ||
            `Upload failed (HTTP ${res.status}).`,
        };
  } catch (err) {
    return textResult(`Error: upload request failed: ${(err as Error).message}`, true);
  }
  if (!resBody.ok) return textResult(`Error: ${resBody.error}`, true);

  const src = typeof resBody.data?.src === 'string' ? resBody.data.src : undefined;
  const path = typeof resBody.data?.path === 'string' ? resBody.data.path : undefined;
  const deduped = resBody.data?.deduped === true;
  const ref = src ?? path ?? fileName;
  const text = [
    `Uploaded asset to ${parentDocName}${deduped ? ' (deduplicated — identical bytes already present)' : ''}.`,
    `Reference it in a doc with: ![${fileName}](${ref})`,
  ].join('\n');
  return textPlusStructured(text, {
    asset: {
      ok: true,
      ...(src ? { src } : {}),
      ...(path ? { path } : {}),
      ...(deduped ? { deduped } : {}),
    },
  });
}

/**
 * Write a skill bundle: SKILL.md (when `description` present) and/or any
 * `references/**`+`scripts/**` files. `body` is optional → an agent can write
 * one reference into an existing skill without resending SKILL.md. Each
 * `files` path is validated against the allowlist (`references/`/`scripts/`
 * only, no escape) before any network call. SKILL.md is written first so a
 * file write into a brand-new skill finds its dir.
 */
async function handleSkillWrite(
  skill: {
    name: string;
    scope?: 'project' | 'global';
    description?: string;
    body?: string;
    files?: Array<{ path: string; content: string }>;
  },
  summary: string | undefined,
  url: string | undefined,
  deps: WriteDeps,
  lockDir: string,
) {
  const identity = deps.identityRef?.current;
  const hasSkillMd = skill.description !== undefined;
  const files = skill.files ?? [];
  if (!hasSkillMd && files.length === 0) {
    return textResult(
      'Error: provide `description` (to author SKILL.md) and/or `files` (to write references/scripts) — a skill write with neither does nothing.',
      true,
    );
  }
  if (skill.body !== undefined && !hasSkillMd) {
    return textResult(
      'Error: `body` updates SKILL.md, so it needs a `description` too. To write a reference, use `files: [{ path: "references/...", content }]` instead.',
      true,
    );
  }
  // Validate every file path up front (no partial writes on a bad path).
  for (const f of files) {
    const resolved = resolveSkillFilePath(f.path);
    if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
  }

  const fileResults: Array<{
    path: string;
    ok: boolean;
    kind?: string;
    created?: boolean;
    error?: string;
  }> = [];

  // 1. SKILL.md first (so a fresh skill's dir exists before file writes).
  let skillMdResult: Awaited<ReturnType<typeof writeSkill>> | null = null;
  if (hasSkillMd) {
    skillMdResult = await writeSkill(url, {
      name: skill.name,
      scope: skill.scope,
      description: skill.description as string,
      body: skill.body,
      summary,
      identity,
      lockDir,
    });
    if (skillMdResult.isError) return skillMdResult;
  }

  // 2. Bundle files.
  for (const f of files) {
    const r = await writeSkillFile(url, {
      name: skill.name,
      scope: skill.scope,
      path: f.path,
      content: f.content,
      summary,
      identity,
    });
    const struct = (r as { structuredContent?: { skill?: { file?: Record<string, unknown> } } })
      .structuredContent;
    if (r.isError) {
      fileResults.push({ path: f.path, ok: false, error: r.content[0]?.text ?? 'write failed' });
    } else {
      const file = struct?.skill?.file ?? {};
      fileResults.push({
        path: f.path,
        ok: true,
        ...(typeof file.kind === 'string' ? { kind: file.kind } : {}),
        ...(typeof file.created === 'boolean' ? { created: file.created } : {}),
      });
    }
  }

  const fileOk = fileResults.filter((r) => r.ok).length;
  const anyFileFailed = fileResults.some((r) => !r.ok);
  // Reuse the SKILL.md result's structured envelope (preview + skill path) when
  // present; otherwise build a minimal one.
  const baseStructured =
    ((skillMdResult as { structuredContent?: Record<string, unknown> } | null)?.structuredContent as
      | Record<string, unknown>
      | undefined) ?? {};
  const baseSkill = (baseStructured.skill as Record<string, unknown> | undefined) ?? { ok: true };
  const structured: Record<string, unknown> = {
    ...baseStructured,
    skill: { ...baseSkill, ...(files.length > 0 ? { files: fileResults } : {}) },
  };

  const lines: string[] = [];
  if (hasSkillMd && skillMdResult) lines.push(skillMdResult.content[0]?.text ?? '');
  if (files.length > 0) {
    lines.push(`${fileOk}/${files.length} bundle file(s) written.`);
    for (const r of fileResults) {
      lines.push(r.ok ? `  ${r.path} (${r.kind ?? 'file'})` : `  Failed ${r.path}: ${r.error}`);
    }
  }
  return textPlusStructured(lines.filter(Boolean).join('\n'), structured, anyFileFailed);
}

// ─────────────────────────── batch / single doc ───────────────────────────

async function handleBatch(
  documents: DocSpec[],
  cwd: string,
  contentDir: string,
  url: string,
  deps: WriteDeps,
  lockDir: string,
  autoOpen: boolean,
) {
  const results: WriteOneResult[] = [];
  for (const spec of documents) {
    results.push(await writeOneDoc(spec, cwd, contentDir, url, deps));
  }
  const docOut = results.map((r) => {
    if (!r.ok) return { docName: r.docName, ok: false as const, error: r.error };
    const preview = resolvePreviewUrl(r.docName, { lockDir });
    const warnings = parseAdvisoryWarnings(r.raw.warnings);
    // Per-doc, always present (even `[]`) — batch writes need per-doc
    // attribution for which doc's links are broken.
    const brokenLinks = parseBrokenLinks(r.raw.brokenLinks);
    return {
      docName: r.docName,
      ok: true as const,
      position: r.position,
      ...(preview ? { previewUrl: preview.url } : {}),
      ...(warnings ? { warnings } : {}),
      ...(r.templateHint ? { templateHint: r.templateHint } : {}),
      brokenLinks,
    };
  });
  const okCount = docOut.filter((d) => d.ok).length;
  const allOk = okCount === docOut.length;
  const lines = documents.map((spec, i) => {
    const r = results[i];
    if (!r?.ok) return `Failed ${spec.path}: ${r?.error ?? 'unknown error'}`;
    if (emptyAppendNoOpNote(r.position, spec.content)) {
      return `No change to ${spec.path} — empty ${r.position}, document unchanged.`;
    }
    const d = docOut[i];
    const baseParts = [`Wrote ${spec.path} (${r.position}).`];
    if (d?.ok && d.warnings) {
      baseParts.push(...formatAdvisoryBriefs(d.warnings));
    }
    if (d?.ok) {
      const brokenBrief = formatBrokenLinkBrief(d.brokenLinks);
      if (brokenBrief) baseParts.push(brokenBrief);
    }
    if (r.ok && r.templateHint) {
      baseParts.push(
        `ℹ ${r.templateHint.length} template${r.templateHint.length === 1 ? '' : 's'} available here (pass \`template\`).`,
      );
    }
    return baseParts.join(' ');
  });
  const perDocNotes = documents.flatMap((spec, i) => {
    const r = results[i];
    if (!r?.ok) return [];
    const fmNote = frontmatterIgnoredNote(r.position, spec.content);
    const notes = [...(fmNote ? [fmNote] : []), ...(r.extensionNote ? [r.extensionNote] : [])];
    return notes.map((n) => `${spec.path} — ${n}`);
  });
  const text = [`${okCount}/${docOut.length} written.`, ...lines, ...perDocNotes].join('\n');
  // Batch result mirrors the `documents` input key: the per-doc results live
  // in the `documents` array; the preview-attach `warning` is the uniform
  // top-level envelope (not nested).
  const structured: Record<string, unknown> = { documents: docOut };
  const firstOk = results.find((r): r is Extract<WriteOneResult, { ok: true }> => r.ok);
  if (firstOk && firstOk.raw.systemSubscriberCount === 0) {
    const firstPreview = resolvePreviewUrl(firstOk.docName, { lockDir });
    structured.warning = buildPreviewAttachWarning(firstPreview, autoOpen);
  }
  return textPlusStructured(text, structured, !allOk);
}

async function handleSingleDoc(
  spec: DocSpec,
  cwd: string,
  contentDir: string,
  url: string,
  deps: WriteDeps,
  lockDir: string,
  autoOpen: boolean,
) {
  const w = await writeOneDoc(spec, cwd, contentDir, url, deps);
  if (!w.ok) return textResult(`Error: ${w.error}`, true);

  const result = w.raw;
  const preview = resolvePreviewUrl(w.docName, { lockDir });
  const systemSubscriberCount =
    typeof result.systemSubscriberCount === 'number' ? result.systemSubscriberCount : undefined;
  const noPreviewAnywhere = systemSubscriberCount === 0;
  const hints = Array.isArray(result.hints) ? result.hints : undefined;
  const summaryResult =
    result.summary && typeof result.summary === 'object'
      ? (result.summary as { value: string; truncatedFrom?: number; hint?: string })
      : undefined;
  const summaryHint = typeof summaryResult?.hint === 'string' ? summaryResult.hint : undefined;
  const advisoryWarnings = parseAdvisoryWarnings(result.warnings);
  // Always an array — `[]` is the positive "all links resolve" confirmation .
  const brokenLinks = parseBrokenLinks(result.brokenLinks);

  const noOpNote = emptyAppendNoOpNote(w.position, spec.content);
  const lines: string[] = [
    noOpNote ??
      (w.fromTemplate !== undefined
        ? `Written successfully (instantiated from template "${w.fromTemplate}").`
        : `Written successfully (${w.position}).`),
  ];
  const fmNote = frontmatterIgnoredNote(w.position, spec.content);
  if (fmNote) lines.push(fmNote);
  if (w.extensionNote) lines.push(w.extensionNote);
  if (noPreviewAnywhere && !preview) lines.push(START_UI_TEXT_HINT);
  if (summaryHint) lines.push(summaryHint);
  if (hints) {
    for (const hint of hints) {
      if (hint.message) lines.push(hint.message);
    }
  }
  if (advisoryWarnings) {
    lines.push(...formatAdvisoryLines(advisoryWarnings));
  }
  lines.push(...formatBrokenLinkLines(brokenLinks));
  if (w.templateHint) lines.push(formatTemplateHintLine(w.templateHint));
  const text = lines.join('\n');

  // Uniform preview envelope top-level; document-specific signals nest under
  // `document` (mirrors the input key). Shared with `edit` via `nestDocResult`.
  // `brokenLinks` is always present (even `[]`), so the doc result is always
  // assembled — no bare-text early-return.
  const document: Record<string, unknown> = {
    brokenLinks,
  };
  if (hints) document.hints = hints;
  if (summaryResult) document.summary = summaryResult;
  if (advisoryWarnings) document.warnings = advisoryWarnings;
  if (w.templateHint) document.templateHint = w.templateHint;
  const warning = noPreviewAnywhere ? buildPreviewAttachWarning(preview, autoOpen) : undefined;
  return textPlusStructured(text, nestDocResult(preview, warning, document));
}

// ─────────────────────────── registration ───────────────────────────

export function register(server: ServerInstance, deps: WriteDeps): void {
  const docTargetShape = {
    path: z
      .string()
      .describe(
        'Document path. The slashes are the folder it lands in; missing parent folders are created. ' +
          'Example: "meetings/2026-06-03-standup". An optional `.md`/`.mdx` suffix selects the file format ' +
          '(default `.md`); prefer the `extension` field for that. The docName itself is always extension-less.',
      ),
    content: z
      .string()
      .optional()
      .describe('The full Markdown body. Mutually exclusive with `template`.'),
    extension: DocExtensionArg.optional(),
    template: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Instantiate the new doc from a folder template (resolved against the parent folder's templates_available, leaf→root walk-up; closest-wins). Mutually exclusive with `content`. Inspect the menu with an `exec` listing of the folder.",
      ),
    frontmatter: FrontmatterArg.optional().describe(
      "The doc's OWN frontmatter (YAML). Written inline on create; for an existing doc prefer `edit`.",
    ),
    position: PositionArg.optional(),
  };

  server.registerTool(
    'write',
    {
      description: DESCRIPTION,
      inputSchema: {
        document: z
          .object(docTargetShape)
          .optional()
          .describe(
            'Create or overwrite a DOCUMENT. Example: { document: { path: "meetings/standup", content: "# Standup\\n..." } }',
          ),
        folder: z
          .object({
            path: z.string().describe('Folder path. Example: "meetings".'),
            frontmatter: FrontmatterArg.optional().describe(
              "The folder's OWN frontmatter (open-shape; `title`/`description`/`tags` are the conventional keys). Describes the folder only — does NOT flow into docs inside it.",
            ),
          })
          .optional()
          .describe(
            'Create a NEW folder (errors with 409 if it exists — use `edit` to change an existing folder). Example: { folder: { path: "ideas" } }',
          ),
        template: z
          .object({
            path: z.string().describe(TEMPLATE_PATH_DESCRIBE),
            content: z.string().describe(TEMPLATE_CONTENT_DESCRIBE),
            frontmatter: z
              .object({
                title: z
                  .string()
                  .min(1)
                  .describe('Required — the label shown when an agent picks this template.'),
                description: z
                  .string()
                  .optional()
                  .describe('Optional — shown beside the title in the template menu.'),
                tags: z.array(z.string()).optional().describe('Optional — tags for the template.'),
              })
              .describe(
                'Template metadata. Only `title` (required), `description`, and `tags` are persisted (unlike open-shape doc/folder frontmatter).',
              ),
          })
          .optional()
          .describe(
            'Create a TEMPLATE (a reusable starting shape for new docs in a folder). Example: { template: { path: "fishing-log/trip-log", content: "# {{date}}\\n", frontmatter: { title: "Trip Log" } } }',
          ),
        skill: z
          .object({
            name: z.string().describe(SKILL_NAME_DESCRIBE),
            description: z
              .string()
              .optional()
              .describe(
                `${SKILL_DESCRIPTION_DESCRIBE} Optional when writing ONLY \`files\` into an existing skill (omit to leave SKILL.md untouched).`,
              ),
            body: z.string().optional().describe(SKILL_BODY_DESCRIBE),
            files: z
              .array(
                z.object({
                  path: z
                    .string()
                    .describe('Skill-relative path under `references/` or `scripts/`.'),
                  content: z.string().describe('Full text of the bundle file.'),
                }),
              )
              .optional()
              .describe(SKILL_FILES_DESCRIBE),
            scope: SkillScopeArg.optional(),
          })
          .optional()
          .describe(
            'Create or overwrite an agent SKILL bundle (`.ok/skills/<name>/`). SKILL.md is authored via `description`+`body`; `references/**` and `scripts/**` via the `files` array. Example: { skill: { name: "trip-log", description: "Use when logging a fishing trip.", body: "# Steps\\n...", files: [{ path: "references/gear.md", content: "..." }] } }',
          ),
        asset: z
          .object({
            path: z
              .string()
              .describe(
                'Asset path incl. extension — the slashes are the folder. Example: "images/diagram.png".',
              ),
            content: z.string().optional().describe('Base64 of the binary. Use for small files.'),
            source: z
              .string()
              .optional()
              .describe('Local filesystem path the server reads. Use for large files.'),
          })
          .optional()
          .describe(
            'Upload a binary asset (image/file) via the media route. Exactly one of `content` | `source`.',
          ),
        documents: z
          .array(z.object({ ...docTargetShape, summary: summaryArgSchema }))
          .min(1)
          .optional()
          .describe(
            'Batch: documents to write in one call. Mutually exclusive with the single targets. Each entry may carry its own `summary`.',
          ),
        summary: summaryArgSchema,
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      // Output mirrors the Pattern-B input: the result nests under the target
      // key you wrote (`document` / `folder` / `template` / `asset`, or
      // `documents` for a batch). The uniform preview envelope
      // (`previewUrl` / `previewUrlSource` / `warning`) stays top-level — it is
      // the cross-tool contract agents handle the same way for every tool.
      outputSchema: outputSchemaWithText({
        document: z
          .object({
            hints: looseObjectArray.optional().describe('Server-provided write hints, when any.'),
            ...documentResultBaseShape,
          })
          .optional()
          .describe(
            'Single-document write result. Always present on a successful single-doc write — it carries `brokenLinks` (possibly `[]`) plus any `summary`/`hints`/`warnings`.',
          ),
        folder: z
          .object({
            ok: z.boolean(),
            path: z.string(),
            frontmatterError: z
              .string()
              .optional()
              .describe(
                'Present when the folder was created but its frontmatter write failed — retry only the properties via `edit({ folder: { frontmatter } })`.',
              ),
          })
          .optional()
          .describe('Folder-create result.'),
        template: z
          .object({
            ok: z.boolean(),
            path: z.string(),
            created: z
              .boolean()
              .describe('true if created, false if an existing template updated.'),
          })
          .optional()
          .describe('Template-create result.'),
        skill: z
          .object({
            ok: z.boolean(),
            path: z.string().optional(),
            created: z
              .boolean()
              .optional()
              .describe('true if created, false if an existing skill was overwritten.'),
            files: looseObjectArray
              .optional()
              .describe('Per-bundle-file results `{ path, kind, created, ok, error? }`.'),
          })
          .optional()
          .describe('Skill-create result (SKILL.md and/or bundle files).'),
        asset: z
          .object({
            ok: z.boolean(),
            src: z.string().optional().describe('The reference src to embed in a doc.'),
            path: z.string().optional(),
            deduped: z
              .boolean()
              .optional()
              .describe('true when identical bytes already existed (no new file written).'),
          })
          .optional()
          .describe('Asset-upload result.'),
        documents: looseObjectArray
          .optional()
          .describe(
            'Batch write: per-doc result `{ docName, ok, position?, previewUrl?, warnings?, brokenLinks, error? }`. `brokenLinks` (possibly `[]`) is present on each successful entry, same as a single-doc write.',
          ),
        previewUrl: previewUrlOutputField.optional(),
        previewUrlSource: previewUrlSourceField,
        warning: previewAttachWarningField,
      }),
    },
    async (args: {
      document?: Omit<DocSpec, 'summary'>;
      folder?: { path: string; frontmatter?: FrontmatterPatch };
      template?: {
        path: string;
        content: string;
        frontmatter: { title: string } & Record<string, unknown>;
      };
      skill?: {
        name: string;
        scope?: 'project' | 'global';
        description?: string;
        body?: string;
        files?: Array<{ path: string; content: string }>;
      };
      asset?: { path: string; content?: string; source?: string };
      documents?: DocSpec[];
      summary?: string;
      cwd?: string;
    }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { cwd, config, url } = context;
      const lockDir = resolveLockDir(cwd);
      const contentDir = resolveContentDir(config, cwd);
      const autoOpen = config.appearance.preview.autoOpen;

      // Batch documents.
      if (args.documents !== undefined) {
        const teaching = exactlyOneTargetError(args as Record<string, unknown>, [
          'document',
          'folder',
          'template',
          'skill',
          'asset',
          'documents',
        ]);
        if (teaching) return textResult(`Error: ${teaching}`, true);
        if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
        return handleBatch(args.documents, cwd, contentDir, url, deps, lockDir, autoOpen);
      }

      const teaching = exactlyOneTargetError(args as Record<string, unknown>, [
        'document',
        'folder',
        'template',
        'skill',
        'asset',
      ]);
      if (teaching) return textResult(`Error: ${teaching}`, true);

      if (args.document !== undefined) {
        if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
        return handleSingleDoc(
          { ...args.document, summary: args.summary },
          cwd,
          contentDir,
          url,
          deps,
          lockDir,
          autoOpen,
        );
      }
      if (args.folder !== undefined) return handleFolder(args.folder, args.summary, url, deps);
      if (args.template !== undefined)
        return handleTemplate(args.template, args.summary, url, deps);
      if (args.skill !== undefined)
        return handleSkillWrite(args.skill, args.summary, url, deps, lockDir);
      return handleAsset(args.asset as NonNullable<typeof args.asset>, cwd, url, deps);
    },
  );
}
