import {
  ALL_EDITOR_IDS,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  type EditorId,
  HUB_READER_EDITORS,
  interpretSkillMoveFailure,
  normalizeApiWarnings,
  SKILL_AUTHORING_WARNING_CODES,
  type SkillScope,
} from '@inkeep/open-knowledge-core';
import type { AgentIdentity } from '../agent-identity.ts';
import { resolveSkillPreviewUrl } from './preview-url.ts';
import {
  agentIdentityFields,
  alignWarningCodes,
  errorTextWithDetail,
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

const KNOWN_AUTHORING_WARNING_CODES: ReadonlySet<string> = new Set(SKILL_AUTHORING_WARNING_CODES);

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
  const aligned = alignWarningCodes(
    result.warnings,
    result.warningCodes,
    KNOWN_AUTHORING_WARNING_CODES,
  );
  const lines = [
    `${created ? 'Created' : 'Updated'} skill "${input.name}"${path ? ` (${path})` : ''} — live for that folder's agent. Use \`install\` with \`add\` to put it in your other editors.`,
    ...aligned.warnings,
  ];
  const preview = input.lockDir
    ? resolveSkillPreviewUrl(input.scope ?? 'project', input.name, { lockDir: input.lockDir })
    : null;
  return textPlusStructured(lines.join('\n'), {
    skill: { ok: true, path, created, ...aligned },
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
    `${created ? 'Created' : 'Updated'} skill ${kind} "${input.path}" in "${input.name}".`,
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
  const warnings = normalizeApiWarnings(result.warnings);
  const lines = [
    existed
      ? `Deleted skill "${input.name}".`
      : `Skill "${input.name}" did not exist — nothing to delete.`,
    ...warnings,
  ];
  return textPlusStructured(lines.join('\n'), {
    skill: { ok: true, existed, ...(warnings.length > 0 ? { warnings } : {}) },
  });
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
    return textPlusStructured(
      errorTextWithDetail({ ...result, error }),
      { ok: false, kind: 'skill', error },
      true,
    );
  }
  const committed = result.committed === true;
  const from = typeof result.from === 'string' ? result.from : input.fromName;
  const to = typeof result.to === 'string' ? result.to : input.toName;
  return textPlusStructured(
    `${committed ? 'Renamed' : 'Moved'} skill ${from} → ${to}.${
      committed ? '' : ' (Untracked `.ok/` — moved on disk without git history.)'
    } Every location it occupied now holds the new name.`,
    { ok: true, kind: 'skill', committed },
  );
}

function destinationSkillRoot(entry: string, scope: SkillScope): string | null | undefined {
  if (!(ALL_EDITOR_IDS as readonly string[]).includes(entry)) return undefined;
  const roots = scope === 'global' ? EDITOR_USER_SKILL_ROOT : EDITOR_PROJECT_SKILL_ROOT;
  return roots[entry as EditorId];
}

function readsHubAt(entry: string, scope: SkillScope): boolean {
  return HUB_READER_EDITORS.some((reader) => reader.editorId === entry && reader.scope === scope);
}

export function crossScopeMoveSuccessText(input: {
  fromName: string;
  toName: string;
  fromScope: SkillScope;
  toScope: SkillScope;
  droppedLocations: readonly string[];
}): string {
  const fromLabel = input.fromScope === 'global' ? 'Global' : 'Project';
  const toLabel = input.toScope === 'global' ? 'Global' : 'Project';
  const unhostable = input.droppedLocations.filter(
    (entry) => destinationSkillRoot(entry, input.toScope) === null,
  );
  const hubEquivalent = unhostable.filter((entry) => readsHubAt(entry, input.toScope));
  const noPlacement = unhostable.filter((entry) => !readsHubAt(entry, input.toScope));
  const reinstallable = input.droppedLocations.filter((entry) => !unhostable.includes(entry));
  const list = (entries: readonly string[]) => entries.join(', ');
  const verb = (entries: readonly string[]) => (entries.length === 1 ? 'has' : 'have');

  const lead = `Moved skill "${input.fromName}" (${fromLabel}) → "${input.toName}" (${toLabel}) with its references, scripts, and bundle files, and re-projected it into the editor locations the ${toLabel} level can host. History did not transfer; it starts fresh at the ${toLabel} level.`;
  if (input.droppedLocations.length === 0) return lead;

  const parts = [
    `${lead} It also occupied ${list(input.droppedLocations)}; those were removed at the source and not re-created at the destination.`,
  ];
  if (reinstallable.length > 0) {
    const add = reinstallable.map((entry) => `"${entry}"`).join(', ');
    parts.push(
      `Re-add ${list(reinstallable)} with \`install({ name: "${input.toName}", scope: "${input.toScope}", add: [${add}] })\`.`,
    );
    if (reinstallable.some((entry) => entry.includes('/'))) {
      const destinationBase =
        input.toScope === 'global' ? 'your home directory' : 'the project directory';
      parts.push(
        `Custom roots resolve against the destination base — ${destinationBase} — not wherever the root lived before the move.`,
      );
    }
  }
  if (hubEquivalent.length > 0) {
    parts.push(
      `${list(hubEquivalent)} ${verb(hubEquivalent)} no ${toLabel}-level skills root, so \`install\` cannot place the skill there; ${hubEquivalent.length === 1 ? 'it reads' : 'they read'} the \`agents\` hub at that level, so \`install({ name: "${input.toName}", scope: "${input.toScope}", add: ["agents"] })\` is the equivalent.`,
    );
  }
  if (noPlacement.length > 0) {
    parts.push(
      `${list(noPlacement)} ${verb(noPlacement)} no ${toLabel}-level skills root and ${noPlacement.length === 1 ? 'does' : 'do'} not read the \`agents\` hub there, so no ${toLabel}-level placement exists — \`install\` would accept the id and project nothing.`,
    );
  }
  return parts.join(' ');
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
  const refuse = (error: string) =>
    textPlusStructured(
      error,
      { ok: false, kind: 'skill', error, moveState: 'nothing-written' as const },
      true,
    );
  const rf = resolveSkillName(input.fromName);
  if (!rf.ok) return refuse(`Error: ${rf.error}`);
  const rt = resolveSkillName(input.toName);
  if (!rt.ok) return refuse(`Error: ${rt.error}`);
  if (!url) return refuse(HOCUSPOCUS_NOT_RUNNING_ERROR);

  const moved = await httpPost(url, '/api/skill/move-scope', {
    name: input.fromName,
    ...(input.toName !== input.fromName ? { toName: input.toName } : {}),
    fromScope: input.fromScope,
    toScope: input.toScope,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...agentIdentityFields(input.identity),
  });
  const readDroppedLocations = (raw: unknown): string[] =>
    Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
  if (!moved.ok) {
    const error = typeof moved.error === 'string' ? moved.error : 'Skill move failed';
    const outcome = interpretSkillMoveFailure(moved);
    const detail = errorTextWithDetail({ ...moved, error });
    return textPlusStructured(
      outcome.kind === 'unverified'
        ? `${detail}\nThe server returned an unrecognized or inconsistent move outcome. Do not remove either copy before comparing the source and destination.`
        : detail,
      {
        ok: false,
        kind: 'skill',
        error,
        droppedLocations: readDroppedLocations(moved.droppedLocations),
        ...(outcome.kind === 'coherent'
          ? {
              ...(outcome.moveState ? { moveState: outcome.moveState } : {}),
              ...(outcome.sourceState ? { sourceState: outcome.sourceState } : {}),
              ...(outcome.retentionLedger ? { retentionLedger: outcome.retentionLedger } : {}),
            }
          : {}),
      },
      true,
    );
  }
  const droppedLocations = readDroppedLocations(moved.droppedLocations);
  return textPlusStructured(
    crossScopeMoveSuccessText({
      fromName: input.fromName,
      toName: input.toName,
      fromScope: input.fromScope,
      toScope: input.toScope,
      droppedLocations,
    }),
    {
      ok: true,
      kind: 'skill',
      committed: false,
      crossScope: true,
      droppedLocations,
    },
  );
}
