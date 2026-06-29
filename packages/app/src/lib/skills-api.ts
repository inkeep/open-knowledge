import type {
  SkillFrontmatter,
  SkillInstallWarningCode,
  SkillScope,
} from '@inkeep/open-knowledge-core';
import { emitSkillsChanged } from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';


async function readErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as unknown;
  return parseApiError(body) ?? `HTTP ${res.status}`;
}

type WriteResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function saveSkill(input: {
  scope: SkillScope;
  name: string;
  frontmatter: SkillFrontmatter;
  body: string;
}): Promise<WriteResult<{ created: boolean; warnings: string[] }>> {
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
    } | null;
    emitSkillsChanged();
    return { ok: true, created: payload?.created ?? false, warnings: payload?.warnings ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function saveSkillFile(input: {
  scope: SkillScope;
  name: string;
  path: string;
  content: string;
}): Promise<WriteResult<{ created: boolean }>> {
  try {
    const res = await fetch('/api/skill-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { created?: boolean } | null;
    emitSkillsChanged();
    return { ok: true, created: payload?.created ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GET `/api/skills/management` — project-managed opt-in state + import count.
 *  `managed: null` = undecided. Returns null on any failure (caller hides UI). */
export async function getSkillsManagement(): Promise<{
  managed: boolean | null;
  importable: number;
} | null> {
  try {
    const res = await fetch('/api/skills/management');
    if (!res.ok) return null;
    return (await res.json()) as { managed: boolean | null; importable: number };
  } catch {
    return null;
  }
}

/** PUT `/api/skills/management` — record the opt-in; enabling imports editor
 *  skills server-side. Emits `skills-changed` so the list re-fetches. */
export async function setSkillsManagement(manageEditorSkills: boolean): Promise<boolean> {
  try {
    const res = await fetch('/api/skills/management', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manageEditorSkills }),
    });
    if (!res.ok) return false;
    emitSkillsChanged();
    return true;
  } catch {
    return false;
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
    const params = new URLSearchParams({ name: input.name, scope: input.scope });
    const getRes = await fetch(`/api/skill?${params.toString()}`);
    if (!getRes.ok) return { ok: false, error: await readErrorBody(getRes) };
    const detail = (await getRes.json().catch(() => null)) as {
      skill?: { frontmatter?: { description?: unknown }; body?: unknown };
    } | null;
    const description =
      typeof detail?.skill?.frontmatter?.description === 'string'
        ? detail.skill.frontmatter.description
        : '';
    const body = typeof detail?.skill?.body === 'string' ? detail.skill.body : '';
    const toName = nextCopyName(input.name, input.existingNames);
    const saved = await saveSkill({
      scope: input.scope,
      name: toName,
      frontmatter: { name: toName, description },
      body,
    });
    if (!saved.ok) return { ok: false, error: saved.error };
    return { ok: true, name: toName };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function moveSkillScope(input: {
  name: string;
  fromScope: SkillScope;
  toScope: SkillScope;
}): Promise<WriteResult<{ scope: SkillScope; skippedBinaryFiles?: string[] }>> {
  const { name, fromScope, toScope } = input;
  if (fromScope === toScope) return { ok: true, scope: toScope };
  try {
    const getRes = await fetch(`/api/skill?name=${encodeURIComponent(name)}&scope=${fromScope}`);
    if (!getRes.ok) return { ok: false, error: await readErrorBody(getRes) };
    const detail = (await getRes.json().catch(() => null)) as {
      skill?: { frontmatter?: { description?: unknown }; body?: unknown };
    } | null;
    const description =
      typeof detail?.skill?.frontmatter?.description === 'string'
        ? detail.skill.frontmatter.description
        : '';
    const body = typeof detail?.skill?.body === 'string' ? detail.skill.body : '';

    const destRes = await fetch(`/api/skill?name=${encodeURIComponent(name)}&scope=${toScope}`);
    if (destRes.ok) {
      return { ok: false, error: `A ${toScope} skill named "${name}" already exists.` };
    }
    if (destRes.status !== 404) {
      return {
        ok: false,
        error: `Couldn't verify the ${toScope} destination "${name}" is free (HTTP ${destRes.status}); aborting before any write so an existing skill can't be overwritten. Retry in a moment.`,
      };
    }

    const saved = await saveSkill({
      scope: toScope,
      name,
      frontmatter: { name, description },
      body,
    });
    if (!saved.ok) return saved;

    const bundled = await getSkillBundledFiles(fromScope, name);
    if (!bundled.ok) {
      return {
        ok: false,
        error: `Copied "${name}" to ${toScope}, but reading its bundle files failed (${bundled.error}); the ${fromScope} original is intact. Delete the partial ${toScope} copy and retry.`,
      };
    }
    const skippedBinaryFiles: string[] = [];
    for (const file of bundled.files) {
      if (file.text === null) {
        skippedBinaryFiles.push(file.path);
        continue;
      }
      const copied = await saveSkillFile({
        scope: toScope,
        name,
        path: file.path,
        content: file.text,
      });
      if (!copied.ok) {
        return {
          ok: false,
          error: `Copied "${name}" to ${toScope}, but copying its bundle file "${file.path}" failed (${copied.error}); the ${fromScope} original is intact. Delete the partial ${toScope} copy and retry.`,
        };
      }
    }

    const del = await deleteSkill(fromScope, name);
    if (!del.ok) {
      return {
        ok: false,
        error: `Copied to ${toScope}, but couldn't remove the ${fromScope} copy: ${del.error}`,
      };
    }
    emitSkillsChanged();
    return {
      ok: true,
      scope: toScope,
      ...(skippedBinaryFiles.length > 0 ? { skippedBinaryFiles } : {}),
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
}): Promise<WriteResult<{ committed: boolean }>> {
  try {
    const res = await fetch('/api/skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { committed?: boolean } | null;
    emitSkillsChanged();
    return { ok: true, committed: payload?.committed ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteSkill(
  scope: SkillScope,
  name: string,
): Promise<WriteResult<{ existed: boolean }>> {
  try {
    const qs = `?name=${encodeURIComponent(name)}&scope=${encodeURIComponent(scope)}`;
    const res = await fetch(`/api/skill${qs}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { existed?: boolean } | null;
    emitSkillsChanged();
    return { ok: true, existed: payload?.existed ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SkillBundledFile {
  path: string;
  text: string | null;
}

export async function getSkillBundledFiles(
  scope: SkillScope,
  name: string,
): Promise<WriteResult<{ files: SkillBundledFile[] }>> {
  try {
    const params = new URLSearchParams({ name, scope });
    const res = await fetch(`/api/skill?${params.toString()}`);
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const detail = (await res.json().catch(() => null)) as {
      skill?: { files?: SkillBundledFile[] };
    } | null;
    return { ok: true, files: detail?.skill?.files ?? [] };
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
  signal?: AbortSignal;
}): Promise<SkillFileReadResult> {
  try {
    const params = new URLSearchParams({
      name: input.name,
      scope: input.scope,
      path: input.path,
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

export async function uninstallSkill(input: {
  scope: SkillScope;
  name: string;
}): Promise<WriteResult<{ uninstalled: boolean }>> {
  try {
    const res = await fetch('/api/skill/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as { uninstalled?: boolean } | null;
    emitSkillsChanged();
    return { ok: true, uninstalled: payload?.uninstalled ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updatePackSkill(input: {
  scope: SkillScope;
  name: string;
}): Promise<WriteResult<{ version: string; previousVersion?: string; checkpointRef?: string }>> {
  try {
    const res = await fetch('/api/skill/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    const payload = (await res.json().catch(() => null)) as {
      version?: string;
      previousVersion?: string;
      checkpointRef?: string;
    } | null;
    emitSkillsChanged();
    return {
      ok: true,
      version: payload?.version ?? '',
      previousVersion: payload?.previousVersion,
      checkpointRef: payload?.checkpointRef,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
