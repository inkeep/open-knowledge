import type {
  SeedInstallPackSkillSuccess,
  SkillDetail,
  SkillDiscover,
  SkillFolderLinkPreview,
  SkillFrontmatter,
  SkillInstallWarningCode,
  SkillPreview,
  SkillRefResolution,
  SkillScope,
  SkillsImportBulkSuccess,
  SkillsInstalledSuccess,
  SkillsListEntry,
  SkillsReimportBulkSuccess,
  SkillsSearchSuccess,
} from '@inkeep/open-knowledge-core';
import { SkillFolderLinkPreviewSchema, SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { emitSkillScopeMoved, emitSkillsChanged } from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';

async function readErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as unknown;
  return parseApiError(body) ?? `HTTP ${res.status}`;
}

type WriteResult<T> = ({ ok: true } & T) | { ok: false; error: string };

async function getJson<T extends object>(
  url: string,
  signal?: AbortSignal,
): Promise<WriteResult<T>> {
  try {
    const res = await fetch(url, signal ? { signal } : undefined);
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const body = (await res.json()) as T;
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendJson<T extends object>(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<WriteResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as T | null;
    return { ok: true, ...((payload ?? {}) as T) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function searchSkills(query: string): Promise<WriteResult<SkillsSearchSuccess>> {
  const q = query.trim();
  if (q.length < 2) return { ok: true, results: [], backend: 'skills.sh', degraded: false };
  return getJson<SkillsSearchSuccess>(`/api/skills/search?q=${encodeURIComponent(q)}`);
}

export async function installPackSkill(
  packId: string,
): Promise<WriteResult<SeedInstallPackSkillSuccess>> {
  const result = await sendJson<SeedInstallPackSkillSuccess>(
    '/api/seed/install-pack-skill',
    'POST',
    { packId },
  );
  if (result.ok) emitSkillsChanged();
  return result;
}

export async function fetchPopularSkills(): Promise<WriteResult<SkillsSearchSuccess>> {
  return getJson<SkillsSearchSuccess>('/api/skills/popular?limit=24');
}

export async function listSkills(
  scope?: SkillScope,
  signal?: AbortSignal,
): Promise<{ ok: true; skills: SkillsListEntry[] } | { ok: false; error: string }> {
  const res = await getJson<Record<string, unknown>>(
    scope ? `/api/skills?scope=${scope}` : '/api/skills',
    signal,
  );
  if (!res.ok) return res;
  const { ok: _envelope, ...body } = res;
  const parsed = SkillsListSuccessSchema.safeParse(body);
  return parsed.success
    ? { ok: true, skills: parsed.data.skills }
    : { ok: false, error: t`The skills list did not match its schema.` };
}

export async function fetchSkillDetail(input: {
  source: string;
  name: string;
}): Promise<WriteResult<SkillDetail>> {
  const params = new URLSearchParams({ source: input.source, name: input.name });
  return getJson<SkillDetail>(`/api/skills/detail?${params.toString()}`);
}

export async function fetchSkillPreview(
  input: { source: string; name: string },
  signal?: AbortSignal,
): Promise<WriteResult<SkillPreview>> {
  const params = new URLSearchParams({ source: input.source, name: input.name });
  return getJson<SkillPreview>(`/api/skills/preview?${params.toString()}`, signal);
}

export async function resolveSkillRef(
  input: { ref: string; scope: SkillScope; from: string },
  signal?: AbortSignal,
): Promise<WriteResult<SkillRefResolution>> {
  const params = new URLSearchParams({
    ref: input.ref,
    scope: input.scope,
    from: input.from,
  });
  return getJson<SkillRefResolution>(`/api/skills/resolve-ref?${params.toString()}`, signal);
}

export async function fetchPublisherSkills(
  source: string,
): Promise<WriteResult<SkillsSearchSuccess>> {
  return getJson<SkillsSearchSuccess>(`/api/skills/publisher?source=${encodeURIComponent(source)}`);
}

export async function discoverSkillsInSource(
  source: string,
  signal?: AbortSignal,
): Promise<WriteResult<SkillDiscover>> {
  return getJson<SkillDiscover>(
    `/api/skills/discover?source=${encodeURIComponent(source)}`,
    signal,
  );
}

export async function listDetectedSkills(): Promise<WriteResult<SkillsInstalledSuccess>> {
  return getJson<SkillsInstalledSuccess>('/api/skills/installed');
}

export async function editExternalSkill(input: {
  name: string;
  home: string;
}): Promise<WriteResult<{ docName: string }>> {
  try {
    const res = await fetch('/api/skill/edit-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const body = (await res.json().catch(() => null)) as { docName?: unknown } | null;
    if (!body || typeof body.docName !== 'string') {
      return { ok: false, error: t`Server returned a malformed response.` };
    }
    return { ok: true, docName: body.docName };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function saveSkill(input: {
  scope: SkillScope;
  name: string;
  frontmatter: SkillFrontmatter;
  body: string;
}): Promise<WriteResult<{ created: boolean; warnings: string[]; path?: string }>> {
  try {
    const res = await fetch('/api/skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      created?: boolean;
      warnings?: string[];
      path?: string;
    } | null;
    emitSkillsChanged();
    return {
      ok: true,
      created: payload?.created ?? false,
      warnings: payload?.warnings ?? [],
      ...(typeof payload?.path === 'string' ? { path: payload.path } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importSkill(input: {
  source: string;
  skill?: string;
  scope?: SkillScope;
  install?: boolean;
  marketplace?: boolean;
}): Promise<
  | {
      ok: true;
      name: string;
      path?: string;
      alreadyImported: boolean;
      collisionRenamedFrom?: string;
      warnings: string[];
    }
  | { ok: false; error: string; skills?: string[] }
> {
  try {
    const res = await fetch('/api/skill/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        title?: unknown;
        detail?: unknown;
      } | null;
      const error = parseApiError(body) ?? `HTTP ${res.status}`;
      const skills =
        typeof body?.detail === 'string' && /multiple skills/i.test(String(body?.title ?? ''))
          ? String(body.detail)
              .split(', ')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      return skills ? { ok: false, error, skills } : { ok: false, error };
    }
    const payload = (await res.json().catch(() => null)) as {
      name?: string;
      path?: string;
      alreadyImported?: boolean;
      collisionRenamedFrom?: string;
      warnings?: string[];
    } | null;
    if (!payload || typeof payload.name !== 'string') {
      return { ok: false, error: t`Server returned a malformed import response.` };
    }
    emitSkillsChanged();
    return {
      ok: true,
      name: payload.name,
      ...(typeof payload.path === 'string' && payload.alreadyImported !== true
        ? { path: payload.path }
        : {}),
      alreadyImported: payload?.alreadyImported ?? false,
      collisionRenamedFrom: payload?.collisionRenamedFrom,
      warnings: payload?.warnings ?? [],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importSkillsBulk(input: {
  source: string;
  skills: string[];
  scope: SkillScope;
  install?: boolean;
  marketplace?: boolean;
}): Promise<WriteResult<SkillsImportBulkSuccess>> {
  try {
    const res = await fetch('/api/skills/import-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as SkillsImportBulkSuccess | null;
    if (!payload || !Array.isArray(payload.results)) {
      return { ok: false, error: t`Server returned a malformed import response.` };
    }
    emitSkillsChanged();
    return { ok: true, ...payload };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uploadSkill(
  formData: FormData,
  scope: SkillScope,
): Promise<
  WriteResult<{
    name: string;
    alreadyImported: boolean;
    collisionRenamedFrom?: string;
    warnings: string[];
  }>
> {
  try {
    const res = await fetch(`/api/skill-upload?scope=${encodeURIComponent(scope)}`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      name?: string;
      alreadyImported?: boolean;
      collisionRenamedFrom?: string;
      warnings?: string[];
    } | null;
    if (!payload || typeof payload.name !== 'string') {
      return { ok: false, error: t`Server returned a malformed upload response.` };
    }
    emitSkillsChanged();
    return {
      ok: true,
      name: payload.name,
      alreadyImported: payload?.alreadyImported ?? false,
      collisionRenamedFrom: payload?.collisionRenamedFrom,
      warnings: payload?.warnings ?? [],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function nextCopyName(base: string, existing: ReadonlySet<string>): string {
  const first = `${base}-copy`;
  if (!existing.has(first)) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-copy-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-copy-${existing.size + 1}`;
}

export async function duplicateSkill(input: {
  scope: SkillScope;
  name: string;
  existingNames: ReadonlySet<string>;
}): Promise<WriteResult<{ name: string }>> {
  try {
    const toName = nextCopyName(input.name, input.existingNames);
    const res = await fetch('/api/skill/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: input.scope,
        name: input.name,
        toName,
      }),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { name?: unknown } | null;
    if (typeof payload?.name !== 'string') {
      return { ok: false, error: t`Server returned a malformed duplicate response.` };
    }
    emitSkillsChanged();
    return { ok: true, name: payload.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function moveSkillScope(input: {
  name: string;
  fromScope: SkillScope;
  toScope: SkillScope;
}): Promise<WriteResult<{ scope: SkillScope; path?: string }>> {
  const { name, fromScope, toScope } = input;
  if (fromScope === toScope) return { ok: true, scope: toScope };
  try {
    const res = await fetch('/api/skill/move-scope', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, fromScope, toScope }),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { path?: string } | null;
    emitSkillScopeMoved({ name, fromScope, toScope });
    emitSkillsChanged();
    return {
      ok: true,
      scope: toScope,
      ...(typeof payload?.path === 'string' ? { path: payload.path } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function trackSkillInGit(input: {
  name: string;
  scope: SkillScope;
  apply?: boolean;
}): Promise<WriteResult<{ line: string; gitignorePath: string; applied: boolean }>> {
  try {
    const res = await fetch('/api/skill/track-in-git', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      line?: string;
      gitignorePath?: string;
      applied?: boolean;
    } | null;
    if (input.apply === true) emitSkillsChanged();
    return {
      ok: true,
      line: payload?.line ?? '',
      gitignorePath: payload?.gitignorePath ?? '.gitignore',
      applied: payload?.applied === true,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function moveSkill(input: {
  scope: SkillScope;
  fromName: string;
  toName: string;
  frontmatter?: SkillFrontmatter;
  body?: string;
}): Promise<WriteResult<{ committed: boolean; to?: string }>> {
  try {
    const res = await fetch('/api/skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      committed?: boolean;
      to?: string;
    } | null;
    emitSkillsChanged();
    return {
      ok: true,
      committed: payload?.committed ?? false,
      ...(typeof payload?.to === 'string' ? { to: payload.to } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getSkillCurrentPath(scope: SkillScope, name: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ name, scope });
    const res = await fetch(`/api/skill?${params.toString()}`);
    if (!res.ok) return null;
    const detail = (await res.json().catch(() => null)) as { skill?: { path?: string } } | null;
    return typeof detail?.skill?.path === 'string' ? detail.skill.path : null;
  } catch {
    return null;
  }
}

export async function deleteSkill(
  scope: SkillScope,
  name: string,
  host?: string,
): Promise<WriteResult<{ existed: boolean }>> {
  try {
    const qs = `?name=${encodeURIComponent(name)}&scope=${encodeURIComponent(scope)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
    const res = await fetch(`/api/skill${qs}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { existed?: boolean } | null;
    emitSkillsChanged();
    return { ok: true, existed: payload?.existed ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveSkillFork(input: {
  scope: SkillScope;
  name: string;
  editor: string;
  action: 'align' | 'make-source' | 'rename';
  toName?: string;
}): Promise<WriteResult<Record<never, never>>> {
  const res = await sendJson('/api/skill/install', 'POST', {
    scope: input.scope,
    name: input.name,
    fork: {
      editor: input.editor,
      action: input.action,
      ...(input.toName !== undefined ? { toName: input.toName } : {}),
    },
  });
  if (!res.ok) return res;
  emitSkillsChanged();
  return { ok: true };
}

export async function writeSkillFile(input: {
  scope: SkillScope;
  name: string;
  path: string;
  content: string;
}): Promise<WriteResult<{ path: string }>> {
  try {
    const res = await fetch('/api/skill-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { path?: string } | null;
    emitSkillsChanged();
    return { ok: true, path: payload?.path ?? input.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function renameSkillFile(input: {
  scope: SkillScope;
  name: string;
  from: string;
  to: string;
}): Promise<WriteResult<{ from: string; to: string; fromDocName?: string; toDocName?: string }>> {
  try {
    const res = await fetch('/api/skill-file/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      from?: string;
      to?: string;
      fromDocName?: string;
      toDocName?: string;
    } | null;
    emitSkillsChanged();
    return {
      ok: true,
      from: payload?.from ?? input.from,
      to: payload?.to ?? input.to,
      ...(payload?.fromDocName !== undefined ? { fromDocName: payload.fromDocName } : {}),
      ...(payload?.toDocName !== undefined ? { toDocName: payload.toDocName } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteSkillFile(input: {
  scope: SkillScope;
  name: string;
  path: string;
}): Promise<WriteResult<{ existed: boolean }>> {
  try {
    const params = new URLSearchParams({
      scope: input.scope,
      name: input.name,
      path: input.path,
    });
    const res = await fetch(`/api/skill-file?${params.toString()}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { existed?: boolean } | null;
    emitSkillsChanged();
    return { ok: true, existed: payload?.existed ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type SkillFileReadResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; error: string };

async function getSkillFile(input: {
  scope: SkillScope;
  name: string;
  path: string;
  host?: string;
  signal?: AbortSignal;
}): Promise<SkillFileReadResult> {
  try {
    const params = new URLSearchParams({
      name: input.name,
      scope: input.scope,
      path: input.path,
      ...(input.host ? { host: input.host } : {}),
    });
    const res = await fetch(`/api/skill-file?${params.toString()}`, { signal: input.signal });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await readErrorBody(res) };
    }
    const detail = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof detail?.text !== 'string') {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, text: detail.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function loadSkillFileText(
  input: {
    scope: SkillScope;
    name: string;
    path: string;
    host?: string;
  },
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; status?: number }> {
  return getSkillFile({ ...input, signal }).then((result) =>
    result.ok ? { ok: true, text: result.text } : { ok: false, status: result.status },
  );
}

export async function installSkill(input: {
  scope: SkillScope;
  name: string;
  targets?: string[];
  linkMode?: boolean;
}): Promise<
  WriteResult<{
    hosts: string[];
    scripts: boolean;
    warnings: string[];
    warningCodes: SkillInstallWarningCode[];
  }>
> {
  try {
    const res = await fetch('/api/skill/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      hosts?: string[];
      scripts?: boolean;
      warnings?: string[];
      warningCodes?: SkillInstallWarningCode[];
    } | null;
    emitSkillsChanged();
    return {
      ok: true,
      hosts: payload?.hosts ?? [],
      scripts: payload?.scripts ?? false,
      warnings: payload?.warnings ?? [],
      warningCodes: payload?.warningCodes ?? [],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function placeSkill(input: {
  scope: SkillScope;
  name: string;
  dir: string;
  mode: 'copy' | 'link';
}): Promise<WriteResult<{ placedAt: string }>> {
  try {
    const res = await fetch('/api/skill/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: input.scope,
        name: input.name,
        place: { dir: input.dir, mode: input.mode },
      }),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const body = (await res.json().catch(() => null)) as { placedAt?: string } | null;
    emitSkillsChanged();
    return { ok: true, placedAt: body?.placedAt ?? input.dir };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function unplaceSkill(input: {
  scope: SkillScope;
  name: string;
  path: string;
}): Promise<WriteResult<Record<never, never>>> {
  const res = await sendJson('/api/skill/install', 'POST', {
    scope: input.scope,
    name: input.name,
    unplace: { path: input.path },
  });
  if (!res.ok) return res;
  emitSkillsChanged();
  return { ok: true };
}

export async function setSkillSource(input: {
  scope: SkillScope;
  name: string;
  target: string;
}): Promise<WriteResult<Record<never, never>>> {
  const res = await sendJson('/api/skill/install', 'POST', {
    scope: input.scope,
    name: input.name,
    setSource: input.target,
  });
  if (!res.ok) return res;
  emitSkillsChanged();
  return { ok: true };
}

export async function convertSkillLocation(input: {
  scope: SkillScope;
  name: string;
  target: string;
  mode: 'copy' | 'link';
}): Promise<WriteResult<Record<never, never>>> {
  const res = await sendJson('/api/skill/install', 'POST', {
    scope: input.scope,
    name: input.name,
    convert: { target: input.target, mode: input.mode },
  });
  if (!res.ok) return res;
  emitSkillsChanged();
  return { ok: true };
}

export async function putSkillFolderAction(action: {
  scope: SkillScope;
  root: string;
  action: 'link' | 'unlink' | 'add-root';
  target?: string;
  exclude?: string[];
  preview?: boolean;
}): Promise<{ ok: true; preview?: SkillFolderLinkPreview } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/skill-targets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderAction: action }),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    if (!action.preview) return { ok: true };
    const payload: unknown = await res.json().catch(() => null);
    const preview =
      typeof payload === 'object' && payload !== null && 'preview' in payload
        ? payload.preview
        : undefined;
    const parsed = SkillFolderLinkPreviewSchema.safeParse(preview);
    if (!parsed.success) return { ok: false, error: t`Server returned a malformed response.` };
    return { ok: true, preview: parsed.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function reimportSkill(input: {
  name: string;
  scope: SkillScope;
  dryRun?: boolean;
  setAutoUpdate?: boolean;
}): Promise<
  WriteResult<{
    updated: boolean;
    source: string;
    localBody?: string;
    upstreamBody?: string;
    gitTracked?: boolean;
    warnings: string[];
  }>
> {
  try {
    const res = await fetch('/api/skill/reimport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      updated?: boolean;
      source?: string;
      localBody?: string;
      upstreamBody?: string;
      gitTracked?: boolean;
      warnings?: string[];
    } | null;
    if (!input.dryRun) emitSkillsChanged();
    return {
      ok: true,
      updated: payload?.updated ?? false,
      source: payload?.source ?? '',
      localBody: payload?.localBody,
      upstreamBody: payload?.upstreamBody,
      ...(payload?.gitTracked !== undefined ? { gitTracked: payload.gitTracked } : {}),
      warnings: payload?.warnings ?? [],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function reimportSkillsBulk(input: {
  names: string[];
  scope: SkillScope;
}): Promise<WriteResult<SkillsReimportBulkSuccess>> {
  try {
    const res = await fetch('/api/skills/reimport-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as SkillsReimportBulkSuccess | null;
    if (!payload || !Array.isArray(payload.results)) {
      return { ok: false, error: t`Server returned a malformed update response.` };
    }
    emitSkillsChanged();
    return { ok: true, ...payload };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function revertSkill(input: {
  name: string;
}): Promise<WriteResult<{ warnings: string[] }>> {
  try {
    const res = await fetch('/api/skill/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      warnings?: string[];
    } | null;
    emitSkillsChanged();
    return {
      ok: true,
      warnings: payload?.warnings ?? [],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
