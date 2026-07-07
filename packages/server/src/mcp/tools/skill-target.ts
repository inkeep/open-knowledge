/**
 * Shared skill-target operations for the CRUD verb tools
 * (`write` / `edit` / `delete` / `move`).
 *
 * One place owns the `/api/skill` HTTP shape + result formatting so each verb
 * file calls a single function rather than re-deriving the request body,
 * identity threading, and `{ skill: ... }` result envelope. `resolveSkillName`
 * (the name grammar) stays in `verb-schemas.ts` alongside the input describes;
 * this module is the HTTP/result layer that consumes it.
 *
 * Backends: `writeSkill` → `PUT /api/skill`; `deleteSkill` → `DELETE`;
 * `moveSkill` → `POST`; `fetchSkill` → `GET` (the read step `edit` needs).
 * All are server-routed so the mutation is attributed in the folder timeline
 * and shadow-committed, exactly like the template target.
 */

// Imported from core (the single source of the project/global union) and
// re-exported so the verb tools keep importing `SkillScope` from here.
import type { SkillScope } from '@inkeep/open-knowledge-core';
import type { AgentIdentity } from '../agent-identity.ts';
import { resolveSkillPreviewUrl } from './preview-url.ts';
import {
  agentIdentityFields,
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpDelete,
  httpGet,
  httpPost,
  httpPut,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { resolveSkillName } from './verb-schemas.ts';

export type { SkillScope };

interface SkillIdentity {
  summary?: string;
  identity?: AgentIdentity;
}

/** Append non-empty agent-identity fields to a query string (DELETE transport). */
function appendIdentityParams(params: URLSearchParams, identity: AgentIdentity | undefined): void {
  for (const [key, value] of Object.entries(agentIdentityFields(identity))) {
    if (typeof value === 'string' && value.length > 0) params.set(key, value);
  }
}

/**
 * Create or overwrite a skill via `PUT /api/skill`. Shared by `write` (literal
 * body) and `edit` (recomputed body/description). Returns the standard
 * `{ skill: { ok, path, created } }` MCP result.
 */
export async function writeSkill(
  url: string | undefined,
  input: {
    scope?: SkillScope;
    name: string;
    description: string;
    body?: string;
    /** Lock dir (project root `.ok/local`) for resolving the skill's previewUrl. */
    lockDir?: string;
  } & SkillIdentity,
) {
  const resolved = resolveSkillName(input.name);
  if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  const result = await httpPut(url, '/api/skill', {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    name: input.name,
    body: input.body ?? '',
    frontmatter: { name: input.name, description: input.description },
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...agentIdentityFields(input.identity),
  });
  if (!result.ok) return textResult(`Error: ${result.error}`, true);
  const created = result.created === true;
  const path = typeof result.path === 'string' ? result.path : undefined;
  const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
  const lines = [
    `${created ? 'Created' : 'Updated'} skill "${input.name}"${path ? ` (${path})` : ''}. Run \`install\` to (re)project it into your editors.`,
    ...warnings,
  ];
  // Skill scope mirrors the server's PUT default (`project`) when omitted; the
  // route-only previewUrl rides the response so the agent can open the skill in
  // the editor, the same contract documents have. Top-level (not nested under
  // `skill`) — the uniform preview envelope shared across every verb tool.
  const preview = input.lockDir
    ? resolveSkillPreviewUrl(input.scope ?? 'project', input.name, { lockDir: input.lockDir })
    : null;
  return textPlusStructured(lines.join('\n'), {
    skill: { ok: true, path, created },
    ...(preview ? { previewUrl: preview.url, previewUrlSource: preview.source } : {}),
  });
}

/**
 * Read a skill's current frontmatter description + body via `GET /api/skill`.
 * The read step `edit` needs before it computes the patched content. Returns a
 * plain result (no MCP wrapping) so the caller can branch.
 */
export async function fetchSkill(
  url: string,
  scope: SkillScope,
  name: string,
): Promise<
  | { ok: true; description: string; body: string; files: Array<{ path: string }> }
  | { ok: false; error: string; notFound: boolean }
> {
  const params = new URLSearchParams({ name, scope });
  const result = await httpGet(url, `/api/skill?${params.toString()}`);
  // `notFound` distinguishes a clean 404 (skill genuinely absent) from any
  // transient failure (timeout / 5xx / unreachable, where `httpStatus` is
  // undefined or non-404) so the collision guard never reads "absent" from
  // an error it couldn't interpret.
  if (!result.ok)
    return { ok: false, error: String(result.error), notFound: result.httpStatus === 404 };
  const skill = result.skill as
    | {
        frontmatter?: { description?: unknown };
        body?: unknown;
        files?: Array<{ path?: unknown }>;
      }
    | undefined;
  // `GET /api/skill` inlines bundle-file `text`; for the verb tools we only need
  // the path enumeration (the list response drops text), so project to
  // `{ path }` and let the caller derive `kind` + read text per-file.
  const files = Array.isArray(skill?.files)
    ? skill.files
        .map((f) => (typeof f?.path === 'string' ? { path: f.path } : null))
        .filter((f): f is { path: string } => f !== null)
    : [];
  return {
    ok: true,
    description:
      typeof skill?.frontmatter?.description === 'string' ? skill.frontmatter.description : '',
    body: typeof skill?.body === 'string' ? skill.body : '',
    files,
  };
}

// ─────────────────────────── skill bundle files ───────────────────────────
// One place owns the `/api/skill-file` HTTP shape (write / read / delete of a
// single `references/**` or `scripts/**` file) so `write`/`edit`/`delete`/
// `skills` call a single function each. The skill-relative path is validated
// at the verb layer (`resolveSkillFilePath`); these helpers just thread the
// HTTP transport + identity + `{ skill: ... }` result envelope.

/** Write ONE bundle file via `PUT /api/skill-file`. */
export async function writeSkillFile(
  url: string | undefined,
  input: { scope?: SkillScope; name: string; path: string; content: string } & SkillIdentity,
) {
  const resolved = resolveSkillName(input.name);
  if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  const result = await httpPut(url, '/api/skill-file', {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    name: input.name,
    path: input.path,
    content: input.content,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...agentIdentityFields(input.identity),
  });
  if (!result.ok) return textResult(`Error: ${result.error}`, true);
  const created = result.created === true;
  const path = typeof result.path === 'string' ? result.path : input.path;
  const kind = result.kind === 'script' ? 'script' : 'reference';
  return textPlusStructured(
    `${created ? 'Created' : 'Updated'} skill ${kind} "${input.path}" in "${input.name}". Run \`install\` if not yet projected.`,
    { skill: { ok: true, file: { path, kind, created } } },
  );
}

/**
 * Read ONE bundle file via `GET /api/skill-file`. Returns a plain result so the
 * caller (`edit`'s read-modify-write, `skills`' per-file read) can branch.
 */
export async function readSkillFile(
  url: string,
  scope: SkillScope,
  name: string,
  path: string,
): Promise<
  | { ok: true; path: string; kind: 'reference' | 'script'; text: string }
  | { ok: false; error: string; status: number | undefined }
> {
  const params = new URLSearchParams({ name, scope, path });
  const result = await httpGet(url, `/api/skill-file?${params.toString()}`);
  // `status` lets the cross-scope-move copier treat a 415 (binary / unsupported
  // bundle file, outside the text-only bundle contract) as a skip-with-warning
  // rather than a hard abort — matching the editor's `moveSkillScope`.
  if (!result.ok)
    return {
      ok: false,
      error: String(result.error),
      status: result.httpStatus as number | undefined,
    };
  return {
    ok: true,
    path: typeof result.path === 'string' ? result.path : path,
    kind: result.kind === 'script' ? 'script' : 'reference',
    text: typeof result.text === 'string' ? result.text : '',
  };
}

/** Delete ONE bundle file via `DELETE /api/skill-file`. */
export async function deleteSkillFile(
  url: string | undefined,
  input: { scope?: SkillScope; name: string; path: string } & SkillIdentity,
) {
  const resolved = resolveSkillName(input.name);
  if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  const params = new URLSearchParams({
    name: input.name,
    scope: input.scope ?? 'project',
    path: input.path,
  });
  if (input.summary !== undefined) params.set('summary', input.summary);
  appendIdentityParams(params, input.identity);
  const result = await httpDelete(url, `/api/skill-file?${params.toString()}`);
  if (!result.ok) return textResult(`Error: ${result.error}`, true);
  const existed = result.existed === true;
  return textPlusStructured(
    existed
      ? `Deleted skill file "${input.path}" from "${input.name}".`
      : `Skill file "${input.path}" did not exist in "${input.name}" — nothing to delete.`,
    { skill: { ok: true, file: { path: input.path, existed } } },
  );
}

/** Delete a skill via `DELETE /api/skill`. Returns `{ skill: { ok, existed } }`. */
export async function deleteSkill(
  url: string | undefined,
  input: { scope?: SkillScope; name: string } & SkillIdentity,
) {
  const resolved = resolveSkillName(input.name);
  if (!resolved.ok) return textResult(`Error: ${resolved.error}`, true);
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  const params = new URLSearchParams({ name: input.name, scope: input.scope ?? 'project' });
  if (input.summary !== undefined) params.set('summary', input.summary);
  appendIdentityParams(params, input.identity);
  const result = await httpDelete(url, `/api/skill?${params.toString()}`);
  if (!result.ok) return textResult(`Error: ${result.error}`, true);
  const existed = result.existed === true;
  return textPlusStructured(
    existed
      ? `Deleted skill "${input.name}".`
      : `Skill "${input.name}" did not exist — nothing to delete.`,
    { skill: { ok: true, existed } },
  );
}

/**
 * Rename a skill via `POST /api/skill`. Formatted for the `move` tool's flat
 * output (`{ ok, kind: 'skill', committed }`), matching the template branch.
 */
export async function moveSkill(
  url: string | undefined,
  input: { scope?: SkillScope; fromName: string; toName: string } & SkillIdentity,
) {
  const rf = resolveSkillName(input.fromName);
  if (!rf.ok) return textResult(`Error: ${rf.error}`, true);
  const rt = resolveSkillName(input.toName);
  if (!rt.ok) return textResult(`Error: ${rt.error}`, true);
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);
  const result = await httpPost(url, '/api/skill', {
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    fromName: input.fromName,
    toName: input.toName,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...agentIdentityFields(input.identity),
  });
  if (!result.ok) {
    const error = typeof result.error === 'string' ? result.error : 'Skill move failed';
    return textPlusStructured(`Error: ${error}`, { ok: false, kind: 'skill', error }, true);
  }
  const committed = result.committed === true;
  const from = typeof result.from === 'string' ? result.from : input.fromName;
  const to = typeof result.to === 'string' ? result.to : input.toName;
  return textPlusStructured(
    `${committed ? 'Renamed' : 'Moved'} skill ${from} → ${to}.${
      committed ? '' : ' (Untracked `.ok/` — moved on disk without git history.)'
    } Run \`install\` to re-project under the new name.`,
    { ok: true, kind: 'skill', committed },
  );
}

/**
 * Move a skill ACROSS scopes (project↔global) by composing the same two
 * server calls the editor's `moveSkillScope` uses: write the skill into the
 * destination scope, then delete it from the source. Destination-first so a
 * failed delete leaves the skill present in BOTH scopes rather than losing it.
 *
 * History is RESET, not transferred (by design): global skills are
 * unversioned, and a project↔global move re-creates the skill fresh in its
 * new scope — so a project→global move drops the timeline and a
 * global→project move starts a new one. History-preserving cross-scope move
 * is Future Work. The moved skill lands as an un-projected Draft in its new
 * scope (same as the editor), so the result prompts the agent to re-`install`.
 */
export async function moveSkillCrossScope(
  url: string | undefined,
  input: {
    fromScope: SkillScope;
    toScope: SkillScope;
    fromName: string;
    toName: string;
  } & SkillIdentity,
) {
  const rf = resolveSkillName(input.fromName);
  if (!rf.ok) return textResult(`Error: ${rf.error}`, true);
  const rt = resolveSkillName(input.toName);
  if (!rt.ok) return textResult(`Error: ${rt.error}`, true);
  if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

  // 1. Read the source skill's content.
  const src = await fetchSkill(url, input.fromScope, input.fromName);
  if (!src.ok) {
    return textPlusStructured(
      `Error: ${src.error}`,
      { ok: false, kind: 'skill', error: src.error },
      true,
    );
  }

  // 1b. Collision guard — `PUT /api/skill` is an upsert, so writing a name that
  // already exists in the destination scope would SILENTLY OVERWRITE it. The
  // editor's `moveSkillScope` (skills-api.ts) refuses in this case; mirror it so
  // an agent-initiated cross-scope move is no more destructive than the UI, and
  // so the `move` tool's documented "destination already exists" contract holds
  // across scopes too (within-scope rename gets this from `git mv`).
  const dest = await fetchSkill(url, input.toScope, input.toName);
  if (dest.ok) {
    const label = input.toScope === 'global' ? 'Global' : 'Project';
    return textPlusStructured(
      `Error: a ${label} skill named "${input.toName}" already exists — delete or rename it first (cross-level move will not overwrite it).`,
      { ok: false, kind: 'skill', error: 'destination already exists' },
      true,
    );
  }
  // Only a CLEAN 404 proves the destination is free. A transient read failure
  // (timeout / 5xx / unreachable) is NOT "absent" — proceeding would upsert over
  // a destination that might exist and then delete the source (data loss). Abort
  // before any write so an unverifiable destination can never be overwritten.
  if (!dest.notFound) {
    return textPlusStructured(
      `Error: could not verify the ${input.toScope} destination "${input.toName}" is free (${dest.error}); aborting before any write so an existing skill can't be overwritten. Retry once the server is reachable.`,
      { ok: false, kind: 'skill', error: dest.error },
      true,
    );
  }

  // 2. Write into the destination scope (fresh — history resets here).
  const put = await httpPut(url, '/api/skill', {
    scope: input.toScope,
    name: input.toName,
    body: src.body,
    frontmatter: { name: input.toName, description: src.description },
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...agentIdentityFields(input.identity),
  });
  if (!put.ok) {
    const error = typeof put.error === 'string' ? put.error : 'Skill move failed';
    return textPlusStructured(`Error: ${error}`, { ok: false, kind: 'skill', error }, true);
  }

  // 2b. Copy EVERY bundle file (references/** + scripts/**) to the destination
  // BEFORE deleting the source — `PUT /api/skill` only writes SKILL.md, so
  // without this the references + scripts are lost on a cross-scope move. Read
  // each file's bytes from the source and write them through `/api/skill-file`
  // PUT, which already routes by scope×type (project `.md` → content/index path
  // so it rejoins the graph; global refs + all scripts → fs-direct). Abort on
  // ANY copy failure WITHOUT deleting the source, so a partial copy never loses
  // the original (it still exists intact at the source scope).
  const skippedBinary: string[] = [];
  for (const file of src.files) {
    const read = await readSkillFile(url, input.fromScope, input.fromName, file.path);
    if (!read.ok) {
      // 415 = binary / oversize file, outside the text-only bundle contract.
      // Skip it (matching the editor's `moveSkillScope`, which drops null-text
      // entries) and surface it in the result instead of aborting — but DON'T
      // silently drop: the user is told what didn't travel.
      if (read.status === 415) {
        skippedBinary.push(file.path);
        continue;
      }
      return textPlusStructured(
        `Error: copied skill "${input.toName}" into ${input.toScope} scope, but reading its bundle file "${file.path}" from the source failed (${read.error}); aborting before deleting the source. The original ${input.fromScope} skill is intact — retry or fix the file, then move again. (A partial ${input.toScope} copy may exist; delete it first.)`,
        { ok: false, kind: 'skill', error: read.error },
        true,
      );
    }
    const copy = await httpPut(url, '/api/skill-file', {
      scope: input.toScope,
      name: input.toName,
      path: file.path,
      content: read.text,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...agentIdentityFields(input.identity),
    });
    if (!copy.ok) {
      const error = typeof copy.error === 'string' ? copy.error : 'bundle-file copy failed';
      return textPlusStructured(
        `Error: copied skill "${input.toName}" into ${input.toScope} scope, but copying its bundle file "${file.path}" failed (${error}); aborting before deleting the source. The original ${input.fromScope} skill is intact — retry. (A partial ${input.toScope} copy may exist; delete it first.)`,
        { ok: false, kind: 'skill', error },
        true,
      );
    }
  }

  // 3. Delete the source — only AFTER the destination write + full bundle copy
  //    succeeded, so a failure never loses the skill (it exists in both scopes).
  const params = new URLSearchParams({ name: input.fromName, scope: input.fromScope });
  if (input.summary !== undefined) params.set('summary', input.summary);
  appendIdentityParams(params, input.identity);
  const del = await httpDelete(url, `/api/skill?${params.toString()}`);
  if (!del.ok) {
    const error = typeof del.error === 'string' ? del.error : 'source delete failed';
    return textPlusStructured(
      `Partially moved skill "${input.fromName}" → ${input.toScope} scope as "${input.toName}", but deleting the ${input.fromScope}-scope original failed (${error}). The skill now exists in BOTH scopes — delete the ${input.fromScope} copy manually. Run \`install\` to project the new ${input.toScope} skill.`,
      { ok: false, kind: 'skill', error, bothScopes: true },
      true,
    );
  }

  const fromLabel = input.fromScope === 'global' ? 'Global' : 'Project';
  const toLabel = input.toScope === 'global' ? 'Global' : 'Project';
  const skippedNote =
    skippedBinary.length > 0
      ? ` ${skippedBinary.length} binary/oversize bundle file(s) were NOT copied (outside the text-only bundle contract): ${skippedBinary.join(', ')}.`
      : '';
  return textPlusStructured(
    `Moved skill "${input.fromName}" (${fromLabel}) → "${input.toName}" (${toLabel}) with its references and scripts. History did not transfer — it lands as a fresh Draft in the ${toLabel} level. Run \`install\` to project it for the new level.${skippedNote}`,
    {
      ok: true,
      kind: 'skill',
      committed: false,
      crossScope: true,
      ...(skippedBinary.length > 0 ? { skippedBinaryFiles: skippedBinary } : {}),
    },
  );
}
