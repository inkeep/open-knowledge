
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

function appendIdentityParams(params: URLSearchParams, identity: AgentIdentity | undefined): void {
  for (const [key, value] of Object.entries(agentIdentityFields(identity))) {
    if (typeof value === 'string' && value.length > 0) params.set(key, value);
  }
}

export async function writeSkill(
  url: string | undefined,
  input: {
    scope?: SkillScope;
    name: string;
    description: string;
    body?: string;
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
  const preview = input.lockDir
    ? resolveSkillPreviewUrl(input.scope ?? 'project', input.name, { lockDir: input.lockDir })
    : null;
  return textPlusStructured(lines.join('\n'), {
    skill: { ok: true, path, created },
    ...(preview ? { previewUrl: preview.url, previewUrlSource: preview.source } : {}),
  });
}

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
  if (!result.ok)
    return { ok: false, error: String(result.error), notFound: result.httpStatus === 404 };
  const skill = result.skill as
    | {
        frontmatter?: { description?: unknown };
        body?: unknown;
        files?: Array<{ path?: unknown }>;
      }
    | undefined;
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

  const src = await fetchSkill(url, input.fromScope, input.fromName);
  if (!src.ok) {
    return textPlusStructured(
      `Error: ${src.error}`,
      { ok: false, kind: 'skill', error: src.error },
      true,
    );
  }

  const dest = await fetchSkill(url, input.toScope, input.toName);
  if (dest.ok) {
    const label = input.toScope === 'global' ? 'Global' : 'Project';
    return textPlusStructured(
      `Error: a ${label} skill named "${input.toName}" already exists — delete or rename it first (cross-level move will not overwrite it).`,
      { ok: false, kind: 'skill', error: 'destination already exists' },
      true,
    );
  }
  if (!dest.notFound) {
    return textPlusStructured(
      `Error: could not verify the ${input.toScope} destination "${input.toName}" is free (${dest.error}); aborting before any write so an existing skill can't be overwritten. Retry once the server is reachable.`,
      { ok: false, kind: 'skill', error: dest.error },
      true,
    );
  }

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

  const skippedBinary: string[] = [];
  for (const file of src.files) {
    const read = await readSkillFile(url, input.fromScope, input.fromName, file.path);
    if (!read.ok) {
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
