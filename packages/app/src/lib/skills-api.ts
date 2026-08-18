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
  SkillsSearchSuccess,
} from '@inkeep/open-knowledge-core';
import { SkillFolderLinkPreviewSchema, SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
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
 * Shared GET → `WriteResult<T>` wrapper for the read-only skill endpoints. Every
 * `/api/skills/*` GET degrades identically: a non-`ok` response surfaces the
 * server error body; a thrown fetch/JSON error (network failure, abort, non-JSON
 * body) becomes `{ ok: false }` so the caller's `.then` still runs and the pane
 * degrades instead of spinning forever. `T` is spread into the success result.
 */
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

/**
 * Write-side counterpart to `getJson`: the POST/PUT/DELETE shape every mutating
 * wrapper below repeated verbatim — send, surface the server's error body on a
 * non-`ok` response, tolerate an empty or non-JSON success body, and turn a
 * thrown fetch into `{ ok: false }` rather than letting it escape into a click
 * handler.
 *
 * Deliberately does NOT emit `skills-changed` or apply per-endpoint defaults:
 * which writes invalidate the list is a per-endpoint decision (one of them
 * deliberately does not emit), and burying that here would hide the exception.
 */
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

/**
 * GET `/api/skills/search?q=` — proxy skill discovery over skills.sh (with a
 * degraded GitHub-topic fallback). `degraded` true = the fallback answered, so
 * the caller should drop the install-count sort. Sub-2-char queries short-circuit
 * to an empty result (mirrors the server's minimum-length guard).
 */
export async function searchSkills(query: string): Promise<WriteResult<SkillsSearchSuccess>> {
  const q = query.trim();
  if (q.length < 2) return { ok: true, results: [], backend: 'skills.sh', degraded: false };
  return getJson<SkillsSearchSuccess>(`/api/skills/search?q=${encodeURIComponent(q)}`);
}

/**
 * POST `/api/seed/install-pack-skill` — explicitly install the companion
 * skills shipped by one starter pack, without applying the pack's content
 * scaffold or changing plugin configuration.
 */
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

/**
 * GET `/api/skills/popular` — the Discover blank-state list (server-scraped from
 * the skills.sh front page, cached + best-effort). A non-`ok` result OR an empty
 * `results` means the caller should fall back to the topic chips.
 */
export async function fetchPopularSkills(): Promise<WriteResult<SkillsSearchSuccess>> {
  return getJson<SkillsSearchSuccess>('/api/skills/popular?limit=24');
}

/**
 * `GET /api/skills` — the managed-skill list, schema-validated.
 *
 * The one wrapper for this endpoint. Call sites used to `fetch` it directly and
 * cast the body with `as { skills?: SkillsListEntry[] }`, which silently accepts
 * a response the `.strict()` schema would reject — so server field drift was
 * loud in one path and invisible in the others.
 */
export async function listSkills(
  scope?: SkillScope,
  signal?: AbortSignal,
): Promise<{ ok: true; skills: SkillsListEntry[] } | { ok: false; error: string }> {
  const res = await getJson<Record<string, unknown>>(
    scope ? `/api/skills?scope=${scope}` : '/api/skills',
    signal,
  );
  if (!res.ok) return res;
  // `getJson` merges its own `ok: true` into the body, which the `.strict()`
  // schema rejects — validate the server's fields, not the envelope.
  const { ok: _envelope, ...body } = res;
  const parsed = SkillsListSuccessSchema.safeParse(body);
  return parsed.success
    ? { ok: true, skills: parsed.data.skills }
    : { ok: false, error: t`The skills list did not match its schema.` };
}

/**
 * GET `/api/skills/detail?source=&name=` — enrich one discovery result for the
 * info modal (skills.sh Open Graph preview + repo/skills.sh links). The server
 * degrades to a repo-link-only payload when the skills.sh page is unreachable,
 * so a non-`ok` result here means the request itself failed, not "no preview".
 */
export async function fetchSkillDetail(input: {
  source: string;
  name: string;
}): Promise<WriteResult<SkillDetail>> {
  const params = new URLSearchParams({ source: input.source, name: input.name });
  return getJson<SkillDetail>(`/api/skills/detail?${params.toString()}`);
}

/**
 * GET `/api/skills/preview?source=&name=` — fetch an un-imported skill's full
 * `SKILL.md` text so the Explore modal can render it through the read-only
 * markdown viewer before importing. The server shallow-clones the source (same
 * machinery as import), so this is slower than `fetchSkillDetail` and can fail
 * on network / rate limits; a non-`ok` result means the caller should fall back
 * to the Open Graph card rather than block the modal.
 */
export async function fetchSkillPreview(
  input: { source: string; name: string },
  signal?: AbortSignal,
): Promise<WriteResult<SkillPreview>> {
  const params = new URLSearchParams({ source: input.source, name: input.name });
  return getJson<SkillPreview>(`/api/skills/preview?${params.toString()}`, signal);
}

/**
 * GET `/api/skills/resolve-ref` — resolve a skill's `/other-skill` reference by
 * trusted-provenance precedence (local install / same-source sibling / same-
 * publisher exact match). Never a marketplace-wide fuzzy search. `from` is the
 * referencing skill's name (for its origin lookup); `scope` its scope.
 */
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

/**
 * GET `/api/skills/publisher?source=` — one publisher's skills.sh listing,
 * most-installed first. The ranking source for a list assembled elsewhere: a
 * non-`ok` or empty result means the caller shows its list unranked rather than
 * showing nothing.
 */
export async function fetchPublisherSkills(
  source: string,
): Promise<WriteResult<SkillsSearchSuccess>> {
  return getJson<SkillsSearchSuccess>(`/api/skills/publisher?source=${encodeURIComponent(source)}`);
}

/**
 * GET `/api/skills/discover?source=` — enumerate every skill in a remote/local
 * import source so the Import modal can offer a picker of what to ingest instead
 * of a blind free-text "which skill" box. Same shallow-clone machinery as
 * import, so it's slow and can fail on network / a bad source; a non-`ok` result
 * means the caller should let the user import blind (the server still errors with
 * the skill list if the source turns out to hold several).
 */
export async function discoverSkillsInSource(
  source: string,
  signal?: AbortSignal,
): Promise<WriteResult<SkillDiscover>> {
  return getJson<SkillDiscover>(
    `/api/skills/discover?source=${encodeURIComponent(source)}`,
    signal,
  );
}

/**
 * GET `/api/skills/installed` — enumerate skills OK detected across your other
 * tools (Claude/Codex/Cursor plugins, `~/.ok/skills`), deduped across homes.
 * Backs the Import modal's Detected tab. Read-only; scripts are surfaced here,
 * never run. A non-`ok` result means the request failed (the caller shows the
 * error), distinct from an `ok` result with an empty `skills` (nothing detected).
 */
export async function listDetectedSkills(): Promise<WriteResult<SkillsInstalledSuccess>> {
  return getJson<SkillsInstalledSuccess>('/api/skills/installed');
}

/**
 * POST `/api/skill/edit-external` — register a detected (unmanaged) skill for
 * in-place editing and get back the synthetic editable doc name
 * (`__extskill__/<name>`). `home` is the skill's own on-disk dir
 * (`CatalogSkill.home`). The doc autosaves back to the real harness file with no
 * copy/symlink/`.ok`.
 */
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

/**
 * PUT `/api/skill` — create or overwrite a skill. A NEW skill is born
 * IN-PLACE at the scope's default skill home (store retirement); an existing
 * one is edited at its real dir. `path` is the base-relative SKILL.md path
 * the server wrote — pass it to `openSkill` so a fresh create opens its REAL
 * doc before the skills list catches up.
 */
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

/**
 * POST `/api/skill/import` — acquire a skill from a remote/local source into
 * `.ok/skills/<name>` as versioned content. The server
 * fetches, writes via the content spine, records upstream provenance, and never
 * executes scripts. A name collision lands under `<name>-imported`; an identical
 * re-import is a no-op (`alreadyImported`).
 */
export async function importSkill(input: {
  source: string;
  skill?: string;
  scope?: SkillScope;
  /** false = import only, no default-editor auto-projection (the caller
   *  installs explicitly afterwards). */
  install?: boolean;
  /** The source is a skills.sh listing the user chose (Explore), so the install
   *  is reported to skills.sh and counts toward that listing. Never set for a
   *  hand-entered source. */
  marketplace?: boolean;
}): Promise<
  | {
      ok: true;
      name: string;
      alreadyImported: boolean;
      collisionRenamedFrom?: string;
      warnings: string[];
    }
  // `skills` rides the failure branch only for the multi-skill guard, so the
  // Import form can recover into the picker instead of dead-ending.
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
      // The multi-skill guard rejects a blind import of a bundle and returns the
      // choosable names in `detail` (comma-joined; skill names are comma-free
      // kebab identifiers). Surface them so the caller can offer the picker even
      // when pre-import discovery flaked but import's own clone saw the bundle.
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
      alreadyImported?: boolean;
      collisionRenamedFrom?: string;
      warnings?: string[];
    } | null;
    // A successful import always returns a JSON body with a real `name`. A null
    // payload (e.g. a proxy returned HTML on a 200) is a failure, not a success
    // we paper over by echoing the raw source as the skill name.
    if (!payload || typeof payload.name !== 'string') {
      return { ok: false, error: t`Server returned a malformed import response.` };
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

/**
 * POST `/api/skills/import-bulk` — acquire SEVERAL named skills from one source
 * in a single server-side clone (the plugin case). Always resolves `ok` when the
 * source itself was reachable: per-skill outcomes ride `results`, so a caller
 * reports counts and lists what failed rather than treating one bad bundle as a
 * failed request.
 */
export async function importSkillsBulk(input: {
  source: string;
  skills: string[];
  scope: SkillScope;
  /** false = import only, no default-editor auto-projection. */
  install?: boolean;
  /** The source is a skills.sh listing the user chose (a marketplace plugin
   *  bundle), so the import is reported to skills.sh as one batched install
   *  event. Never set for a hand-entered source. */
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

/**
 * POST `/api/skill-upload` — acquire a skill from UPLOADED BYTES (a `.zip` of a
 * skill dir, or a folder's files via `webkitdirectory`) instead of a fetched
 * source. Multipart: `scope` rides the query string, the file parts are the
 * body. Mirrors the import result shape (same server spine); the server unpacks
 * to a temp dir and never runs scripts.
 */
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
 * Duplicate a complete skill bundle within its scope. The server copies the
 * directory recursively so references, scripts, and binary assets stay intact.
 * `existingNames` picks a friendly non-colliding name before the server performs
 * its authoritative destination check.
 */
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

/**
 * Move a skill across scopes (project ↔ global) via the server-side atomic
 * `POST /api/skill/move-scope`. The server copies the whole bundle verbatim
 * (binaries included), removes the source, and transfers install projections in
 * ONE request — no client-orchestrated copy+delete, so nothing can race the
 * live-doc bridge and double the skill's content on a round-trip. Refuses (409)
 * if the destination scope already has a skill of that name — no overwrite.
 * Project → global drops version history (global is unversioned by design).
 */
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

/**
 * `POST /api/skill/track-in-git`. A gitignored bundle is listed but never
 * indexed, so it cannot be opened — this offers the one `.gitignore` line that
 * changes that. Call with `apply: false` first: every caller shows the user the
 * literal line before writing to their repo.
 */
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

/** POST `/api/skill/install` fork op — resolve a same-name divergence: align
 *  the fork to the source, make the fork the source, or keep both by renaming
 *  the fork. Every path stashes the discarded bytes out-of-tree first. */
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

/** PUT `/api/skill-file` — write/create ONE bundle file. Nested paths create
 *  their folders implicitly (the server mkdirs parents). */
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

/** POST `/api/skill-file/rename` — rename/move ONE bundle file inside a skill.
 *  For a project `.md` reference the response carries the old + new live doc
 *  names so an open tab can retarget. */
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

/** DELETE `/api/skill-file` — remove ONE bundle file inside a skill. The server
 *  closes a project `.md` reference's live doc before unlinking, so the caller
 *  only has to evict the tab. */
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
  /** Which same-named bundle to list. Omitted = the by-name default. */
  host?: string,
): Promise<WriteResult<{ files: SkillBundledFile[] }>> {
  try {
    const params = new URLSearchParams({ name, scope, ...(host ? { host } : {}) });
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
  /** Which same-named bundle owns this file. Omitted = the by-name default. */
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
    /** Which same-named bundle owns this file; omitted = by-name default. */
    host?: string;
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
  /** Persist + apply the per-skill symlink-installs preference. */
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

/**
 * POST `/api/skill/install` with a one-shot custom placement: copy or symlink
 * the skill bundle under an arbitrary project-relative dir. Never overwrites.
 */
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

/** POST `/api/skill/install` with a one-shot placement REMOVAL (inverse of
 *  `placeSkill`). Lossless-only — a hand-edited copy is refused server-side. */
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

/** POST `/api/skill/install` with a one-shot SOURCE move: make one host's
 *  location the skill's real folder; every other installed location becomes a
 *  symlink to it (sticky). */
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

/** POST `/api/skill/install` converting ONE location between an independent
 *  copy and a symlink to the source. Sibling locations and the skill-wide
 *  preference are untouched; a hand-edited copy is refused server-side. */
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

/**
 * POST `/api/skill/reimport` — refresh an IMPORTED skill from its recorded
 * upstream (`.ok/skills-lock.json`). `updated` is false when the source content
 * was unchanged (already up to date). Project scope only.
 */
/**
 * One folder-topology verb (link / unlink / add-root) — the same
 * `PUT /api/skill-targets` the Settings Folders surface uses, callable from
 * any surface without the settings hook. `unlink` + `exclude` is the
 * "stop this agent reading that skill" remedy: the folder keeps every other
 * skill it sees (as per-skill links) and stops following its target root.
 */
export async function putSkillFolderAction(action: {
  scope: SkillScope;
  root: string;
  action: 'link' | 'unlink' | 'add-root';
  target?: string;
  exclude?: string[];
  /** `link` only — classify the merge and return it, writing nothing. */
  preview?: boolean;
}): Promise<{ ok: true; preview?: SkillFolderLinkPreview } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/skill-targets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderAction: action }),
    });
    if (!res.ok) return { ok: false, error: await readErrorBody(res) };
    // Non-preview verbs carry no body worth reading — the 2xx is the receipt.
    if (!action.preview) return { ok: true };
    // A preview asked for the plan; if none comes back (unreadable body, or a
    // response missing it) fail CLOSED. The caller merges only on a plan it has
    // seen — never on the strength of an absent one, which would run the
    // destructive link with nothing disclosed.
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
  /** Preview only — fetch upstream and return the diff bodies WITHOUT writing. */
  dryRun?: boolean;
  /** Toggle-persist mode: only flips the lockfile's per-skill `autoUpdate`
   *  flag (no fetch, nothing rewritten). */
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
    // A dry run writes nothing — don't invalidate the skills list on a preview.
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

/**
 * POST `/api/skill/revert` — discard local edits and restore an imported skill to
 * the exact bytes recorded when it was installed/last updated. Project scope only.
 */
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
