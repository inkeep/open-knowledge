import type {
  SkillFrontmatter,
  SkillInstallWarningCode,
  SkillScope,
} from '@inkeep/open-knowledge-core';
import { emitSkillsChanged } from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';

/**
 * Imperative skill writes against `/api/skill*`. Read-only, refresh-aware data
 * sources live in `@/hooks/use-skills` + `@/hooks/use-skill-targets`; these are
 * the mutating counterparts. Every successful write emits `skills-changed` so
 * mounted `useSkills` instances re-fetch. Mirrors `@/lib/folder-config-api`'s
 * template writes, addressing skills by `scope` + `name` instead of folder.
 */

async function readErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as unknown;
  return parseApiError(body) ?? `HTTP ${res.status}`;
}

type WriteResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * PUT `/api/skill` — create or overwrite `<root>/.ok/skills/<name>/SKILL.md`.
 * `frontmatter.name` must equal `name` (server-enforced); the form keeps them
 * in lockstep.
 */
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

/**
 * PUT `/api/skill-file` — create or overwrite ONE bundle file (`references/**`
 * or `scripts/**`) beside a skill's `SKILL.md`. The server routes by scope×type
 * (project `.md` → CRDT content/index path so it joins the graph; global refs +
 * all scripts → fs-direct). Used to carry the full bundle on a cross-scope move.
 */
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

/** First free `<base>-copy[-N]` name not already present, for duplicate. */
function nextCopyName(base: string, existing: ReadonlySet<string>): string {
  const first = `${base}-copy`;
  if (!existing.has(first)) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-copy-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-copy-${existing.size + 1}`;
}

/**
 * Duplicate a skill within its scope. Reads the source `SKILL.md` (GET) and
 * writes a copy under a fresh `<name>-copy[-N]` name (PUT via `saveSkill`) — a
 * client-side compose over the existing endpoints, since skills are plain files
 * (no CRDT). `existingNames` is the scope's current name set, used to pick a
 * non-colliding name without overwriting.
 */
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

/**
 * Move a skill across scopes (project ↔ global). Each scope has its own store
 * (project = `<contentDir>/.ok/skills`, content-versioned; global =
 * `<home>/.ok/skills`, unversioned), so this composes the existing endpoints —
 * read the source `SKILL.md`, write it under the destination scope, then delete
 * the source (whose DELETE also tears down the open live doc + uninstalls the
 * old scope's editor-host projections).
 * Refuses if the destination scope already has a skill of that name (no
 * overwrite). Project → global drops version history (global is unversioned
 * by design); the moved skill lands as a Draft to (re)install for its new scope.
 * Not atomic: if the delete fails, the copy already exists in the destination —
 * surfaced in `error` so the caller can tell the user.
 */
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

    // Don't overwrite an existing destination-scope skill of the same name.
    // Only a clean 404 proves the destination is free: a transient failure
    // (5xx / network) is NOT "absent", and proceeding would overwrite a
    // destination that might exist and then delete the source (data loss).
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

    // Carry the full bundle: `saveSkill` only writes SKILL.md, so without this
    // the references + scripts are lost on a cross-scope move. Copy every
    // bundle file to the destination BEFORE deleting the source — abort on any
    // copy failure without deleting, so a partial copy never loses the original
    // (it stays intact at the source scope). Null-text entries are binary /
    // oversize files outside the text-only bundle contract; skip them.
    const bundled = await getSkillBundledFiles(fromScope, name);
    if (!bundled.ok) {
      return {
        ok: false,
        error: `Copied "${name}" to ${toScope}, but reading its bundle files failed (${bundled.error}); the ${fromScope} original is intact. Delete the partial ${toScope} copy and retry.`,
      };
    }
    const skippedBinaryFiles: string[] = [];
    for (const file of bundled.files) {
      // Binary / oversize files (null text) are outside the text-only bundle
      // contract — skip them, but collect so the move isn't a SILENT drop.
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

/**
 * POST `/api/skill` — rename `fromName` → `toName` within one scope. Optional
 * `frontmatter`/`body` rewrite the relocated `SKILL.md` in the same request, so
 * a Save that changes the name AND the body is one atomic server op (history-
 * preserving `git mv` when the `.ok/` path is tracked).
 */
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

/** DELETE `/api/skill` — remove `<root>/.ok/skills/<name>/`. */
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

/** One bundled file beside a skill's `SKILL.md`, with inline read-only text. */
export interface SkillBundledFile {
  path: string;
  /** Inline UTF-8 text, or `null` for a binary / oversize file. */
  text: string | null;
}

/**
 * GET `/api/skill` — read a skill's bundled files (`scripts/`, `reference/`,
 * assets) as read-only text. The skill is a folder, so this surfaces what it
 * ships beside `SKILL.md` for browsing; scripts come back as TEXT, never an
 * executable byte stream.
 */
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

/** Result of reading ONE skill bundle file: its text, or a failure with status. */
type SkillFileReadResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; error: string };

/**
 * GET `/api/skill-file` — read ONE bundle file (`references/**` or `scripts/**`)
 * by `scope` × `name` × `path`. This is the SCOPE-AWARE read: it resolves
 * against the right store (project = `<contentDir>/.ok/skills`, global =
 * `<home>/.ok/skills`), unlike the content-dir asset server which only knows the
 * project tree. The bundle-file viewer reads through here so a GLOBAL skill's
 * references + scripts (which live outside the content dir) open instead of
 * 404ing against `/api/asset-text`. Surfaces the HTTP status so the viewer can
 * map 404 / 415 (binary) to the right message.
 */
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

/**
 * Adapt `getSkillFile` to the shared `useViewerText` loader shape (`{ ok, text }`
 * / `{ ok: false, status }`). Both bundle-file render surfaces — the source
 * `TextViewer` branch and the rendered-markdown `SkillMarkdownLoader` — load
 * through this, so the read coordinates + result mapping live in one place.
 */
export function loadSkillFileText(
  input: {
    scope: SkillScope;
    name: string;
    path: string;
  },
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; status?: number }> {
  // Forward the viewer's AbortSignal so a rapid sidebar navigation aborts the
  // in-flight `/api/skill-file` fetch instead of leaking the connection.
  return getSkillFile({ ...input, signal }).then((result) =>
    result.ok ? { ok: true, text: result.text } : { ok: false, status: result.status },
  );
}

/**
 * POST `/api/skill/install` — project a skill's source into editor host dirs.
 * `targets` omitted → the project-configured editors (the committed
 * `.ok/skill-targets.json` set, else detected).
 */
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

/**
 * POST `/api/skill/uninstall` — remove a skill's editor-host projections + drop
 * its marker entry, leaving the source intact (the skill demotes to Draft). The
 * inverse of `installSkill`.
 */
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

/**
 * POST `/api/skill/update` — refresh an installed starter-pack skill from OK's
 * currently-bundled source. The server checkpoints the current doc first
 * (reversible via version history), then overwrites it. Opt-in: only called when
 * the skills list reports `updateAvailable`. Returns the now-installed `version`
 * (and the prior one + the pre-update checkpoint ref, when available).
 */
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
