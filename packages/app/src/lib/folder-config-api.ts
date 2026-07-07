/**
 * Imperative HTTP service for the folder frontmatter + templates editor.
 *
 * Separated from `hooks/use-folder-config.ts` so the boundary between
 * "data subscription" (the hook) and "side-effecting action" (these
 * functions) is explicit. The hook tells you what's THERE; these functions
 * change what's there. Components import both.
 *
 * Each function returns a discriminated `{ ok: true, ... } | { ok: false, error }`
 * union — never throws. Network failures become `{ ok: false }` results so
 * callers don't need try/catch around every call site.
 *
 * All three endpoints sit behind the loopback-Origin CSRF guard
 * (`isAllowedApiOrigin` in api-extension.ts) — fetches from a non-localhost
 * page get 403'd at the wire.
 *
 * Server contract: post-RFC-9457 the success bodies are flat
 * (`{ applied }` / `{ created, warnings }` / `{ existed }`), and errors
 * arrive as RFC 9457 problem+json with HTTP status as the discriminator.
 * The `parseApiError` helper extracts `body.title` from RFC 9457 errors;
 * the local `{ ok: true }` / `{ ok: false }` return shape is this module's
 * own caller-facing contract, not the server's wire shape.
 */

import { emitTemplatesChanged } from './documents-events.ts';
import { parseApiError } from './parse-api-error.ts';

/**
 * Folder frontmatter is open-shape, exactly like a doc's — any key about the
 * folder itself (`title` / `description` / `tags` are conventional keys the UI
 * surfaces). Self-only: it does not flow into child docs. Templates, by
 * contrast, use title (required at write-time) and description (optional).
 */
type FolderFrontmatterPatch = Record<string, unknown>;

interface TemplateFrontmatterFields {
  title?: string;
  description?: string;
}

async function readErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as unknown;
  return parseApiError(body) ?? `HTTP ${res.status}`;
}

/**
 * PUT `/api/folder-config` — upsert `<folder>/.ok/frontmatter.yml`.
 *
 * Pass `frontmatter: {}` to delete the file (auto-cleans empty `.ok/`).
 * Returned `{ ok: true }` means the on-disk state matches the request — the
 * UI should `refresh()` to pick up the new folder frontmatter.
 */
export async function saveFolderConfig(
  path: string,
  frontmatter: FolderFrontmatterPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/folder-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, frontmatter }),
    });
    if (!res.ok) {
      return { ok: false, error: await readErrorBody(res) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * PUT `/api/template` — create or update a template at
 * `<folder>/.ok/templates/<name>.md` in the current project.
 *
 * The server enforces the substitution allowlist (`{{date}}` / `{{user}}`
 * only) and the title-required contract. Validation failures come
 * back as RFC 9457 problem+json — the `title` is agent-readable and safe
 * to surface in a toast.
 */
export async function saveTemplate(input: {
  folder: string;
  name: string;
  frontmatter: TemplateFrontmatterFields;
  body: string;
}): Promise<{ ok: true; created: boolean; warnings: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/template', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      return { ok: false, error: await readErrorBody(res) };
    }
    const payload = (await res.json().catch(() => null)) as {
      created?: boolean;
      warnings?: string[];
    } | null;
    emitTemplatesChanged();
    return {
      ok: true,
      created: payload?.created ?? false,
      warnings: payload?.warnings ?? [],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * DELETE `/api/template` — remove a template at
 * `<folder>/.ok/templates/<name>.md`.
 *
 * Auto-cleans the parent `templates/` and `.ok/` directories if they become empty.
 */
export async function deleteTemplate(
  folder: string,
  name: string,
): Promise<{ ok: true; existed: boolean } | { ok: false; error: string }> {
  try {
    const qs = `?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`;
    const res = await fetch(`/api/template${qs}`, { method: 'DELETE' });
    if (!res.ok) {
      return { ok: false, error: await readErrorBody(res) };
    }
    const payload = (await res.json().catch(() => null)) as { existed?: boolean } | null;
    emitTemplatesChanged();
    return { ok: true, existed: payload?.existed ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * POST `/api/template` — move/rename a template from `(fromFolder, fromName)`
 * to `(toFolder, toName)`. A `git mv` (history-preserving) when the `.ok/` path
 * is tracked, a plain disk rename otherwise (`committed` reflects which).
 * Optional `frontmatter`/`body` rewrite the relocated template in the same
 * request — so a Save that changes the name/folder AND the body is one atomic
 * server op. Inherited templates are refused (move the owning copy instead).
 */
export async function moveTemplate(input: {
  fromFolder: string;
  fromName: string;
  toFolder: string;
  toName: string;
  frontmatter?: TemplateFrontmatterFields;
  body?: string;
}): Promise<{ ok: true; committed: boolean } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      return { ok: false, error: await readErrorBody(res) };
    }
    const payload = (await res.json().catch(() => null)) as { committed?: boolean } | null;
    emitTemplatesChanged();
    return { ok: true, committed: payload?.committed ?? false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
