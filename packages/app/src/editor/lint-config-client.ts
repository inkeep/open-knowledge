/**
 * Client for the lint-config endpoints. The editor reads the doc's EFFECTIVE
 * config (project base + native `.markdownlint.*` rules) to lint with; the
 * Settings GUI reads the project config and writes native markdownlint rules.
 * A window event lets a config write re-lint the open editor live.
 */

import {
  type FrontmatterFieldConstraint,
  FrontmatterSchemasListSuccessSchema,
  type LintConfigResponse,
  LintConfigResponseSchema,
  type LinterConfig,
  type LintFixResult,
  LintFixResultSchema,
  type MarkdownlintRuleWriteValue,
  type SchemaParentPathSegment,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';

const LINT_CONFIG_CHANGED_EVENT = 'open-knowledge:lint-config-changed';

/** Signal that the lint config changed so open editors re-fetch + re-lint. */
export function emitLintConfigChanged(): void {
  window.dispatchEvent(new CustomEvent(LINT_CONFIG_CHANGED_EVENT));
}

/** Subscribe to lint-config changes (re-fetch + re-lint). */
export function subscribeToLintConfigChanged(onChange: () => void): () => void {
  const listener = () => onChange();
  window.addEventListener(LINT_CONFIG_CHANGED_EVENT, listener);
  return () => window.removeEventListener(LINT_CONFIG_CHANGED_EVENT, listener);
}

/** GET the effective lint config (optionally for a doc). null on any failure. */
async function fetchLintConfig(docName?: string): Promise<LintConfigResponse | null> {
  try {
    const query = docName !== undefined ? `?doc=${encodeURIComponent(docName)}` : '';
    const res = await fetch(`/api/lint/config${query}`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const parsed = LintConfigResponseSchema.safeParse(body);
    if (!parsed.success) {
      // Distinguish server/client schema drift from "server not running":
      // both fall back to defaults, but drift deserves a diagnostic.
      console.warn('[lint] lint-config response failed schema validation', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Fetch just the EFFECTIVE config for a doc — the config the WYSIWYG decoration
 * plugin lints with. null on any failure.
 */
export async function fetchEffectiveLintConfig(docName: string): Promise<LinterConfig | null> {
  const response = await fetchLintConfig(docName);
  return response?.effective ?? null;
}

/**
 * Per-request ceiling for one file's auto-fix, in milliseconds. A fix does real
 * server work (CRDT load, markdownlint apply, disk + git flush) but is a
 * localhost round trip, so it takes seconds at most. The project-scope sweep
 * runs these serially and can only cancel between files, so an in-flight request
 * that never returns would freeze the whole sweep with no recovery but a page
 * reload; this bounds a stalled request into a terminal failure the sweep moves
 * past. Generous enough that a legitimately slow fix still completes.
 */
export const LINT_FIX_TIMEOUT_MS = 30_000;

/**
 * POST a whole-doc auto-fix. The body carries no agent identity on purpose:
 * a UI-initiated deterministic fix is the principal's write (the human
 * clicked the button), and the server resolves a bare body to the loaded
 * principal. Used per-file by the project-scope Fix all sweep.
 *
 * The failure branch surfaces the HTTP `status` and the RFC 9457 problem-type
 * URN alongside the human-readable `errorDetail`, so a caller can tell a
 * retryable capacity refusal (503 / `urn:ok:error:too-many-agent-sessions`)
 * from a terminal failure. `status` is `null` when the request never reached
 * the server (network throw); `problemType` is `null` when the body carried no
 * URN (schema drift on a 2xx, or an unparseable error body).
 */
export async function fixLintDoc(
  docName: string,
): Promise<
  | { ok: true; result: LintFixResult }
  | { ok: false; errorDetail: string | null; status: number | null; problemType: string | null }
> {
  // Bound the request so a stalled fix resolves to a terminal failure the sweep
  // can move past, rather than hanging it. The abort surfaces through the catch
  // below as `{ status: null }` — a non-capacity failure, so it is not retried.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINT_FIX_TIMEOUT_MS);
  try {
    const res = await fetch('/api/lint/fix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docName }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as {
        title?: unknown;
        type?: unknown;
      } | null;
      return {
        ok: false,
        errorDetail: typeof errBody?.title === 'string' ? errBody.title : null,
        status: res.status,
        problemType: typeof errBody?.type === 'string' ? errBody.type : null,
      };
    }
    const body = await res.json().catch(() => null);
    const parsed = LintFixResultSchema.safeParse(body);
    if (!parsed.success) {
      // Mirror the sibling fetchLintConfig/runValidationAudit logging so a
      // client/server schema drift leaves a diagnostic trail instead of a
      // silent failure.
      console.warn('[lint] fix response failed schema validation', parsed.error.issues);
      return { ok: false, errorDetail: null, status: res.status, problemType: null };
    }
    return { ok: true, result: parsed.data };
  } catch (err) {
    // Network throw, or the AbortSignal firing on the per-request ceiling. The
    // sweep turns this into one line of a bulk failure toast, so without a log
    // there is nothing to distinguish a timeout from DNS from a server crash
    // across hundreds of files. Named per file so these lines correlate with the
    // sweep's bulk-failure summary rather than being N indistinguishable copies.
    console.warn('[lint] fix request failed', docName, err instanceof Error ? err.message : err);
    return { ok: false, errorDetail: null, status: null, problemType: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST one rule change to the project's native `.markdownlint.*` file (the
 * source of truth). `value: null` removes the rule (reverts to OK's default).
 * Returns the recomputed effective config. null on any failure.
 */
export async function writeMarkdownlintRule(
  ruleId: string,
  // The write vocabulary is narrower than the read-side setting: severity
  // strings are read-tolerated, never written (the server rejects them).
  value: MarkdownlintRuleWriteValue | null,
): Promise<{ ok: true; response: LintConfigResponse } | { ok: false; errorDetail: string | null }> {
  try {
    const res = await fetch('/api/lint/markdownlint-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleId, value }),
    });
    if (!res.ok) {
      // Surface the server's problem+json title when it carries actionable
      // guidance (e.g. the 409 for an executable .cjs/.mjs config the write
      // surface refuses to rewrite) instead of flattening every failure to
      // an indistinguishable generic toast.
      const errBody = (await res.json().catch(() => null)) as { title?: unknown } | null;
      return {
        ok: false,
        errorDetail: typeof errBody?.title === 'string' ? errBody.title : null,
      };
    }
    const body = await res.json().catch(() => null);
    const parsed = LintConfigResponseSchema.safeParse(body);
    return parsed.success ? { ok: true, response: parsed.data } : { ok: false, errorDetail: null };
  } catch {
    return { ok: false, errorDetail: null };
  }
}

/**
 * POST one request to the frontmatter schema write endpoint (the five shapes
 * the request schema refines: per-field edit, removeField, renameTo,
 * create-empty, delete). `undefined` members drop out of the JSON body.
 * Returns the recomputed effective config on success.
 */
async function postFrontmatterSchema(body: {
  file: string;
  delete?: true;
  field?: string;
  constraint?: FrontmatterFieldConstraint;
  removeField?: true;
  renameTo?: string;
  parentPath?: readonly SchemaParentPathSegment[];
}): Promise<
  { ok: true; response: LintConfigResponse } | { ok: false; errorDetail: string | null }
> {
  try {
    const res = await fetch('/api/lint/frontmatter-schema', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { title?: unknown } | null;
      return {
        ok: false,
        errorDetail: typeof errBody?.title === 'string' ? errBody.title : null,
      };
    }
    const parsed = LintConfigResponseSchema.safeParse(await res.json().catch(() => null));
    return parsed.success ? { ok: true, response: parsed.data } : { ok: false, errorDetail: null };
  } catch {
    return { ok: false, errorDetail: null };
  }
}

/** Empty parentPath drops off the wire (the schema treats absent as the root). */
function wireParentPath(
  parentPath: readonly SchemaParentPathSegment[],
): readonly SchemaParentPathSegment[] | undefined {
  return parentPath.length > 0 ? parentPath : undefined;
}

/**
 * POST one field-constraint change to a frontmatter schema file (create-on-
 * first-edit; non-destructive merge — advanced keywords survive). Returns the
 * recomputed effective config. Callers pair a success with
 * `emitLintConfigChanged()` so open editors re-lint.
 */
export async function writeFrontmatterSchemaField(
  file: string,
  field: string,
  constraint: FrontmatterFieldConstraint,
  parentPath: readonly SchemaParentPathSegment[] = [],
): Promise<{ ok: true; response: LintConfigResponse } | { ok: false; errorDetail: string | null }> {
  return postFrontmatterSchema({ file, field, constraint, parentPath: wireParentPath(parentPath) });
}

/**
 * GET the project's existing frontmatter schema files (`.ok/schemas/*.json`,
 * project-root-relative) for the mapping file-picker. Empty list on any
 * failure (server down, no `.ok/schemas/` yet) — the picker degrades to plain
 * free-text entry.
 */
async function listFrontmatterSchemas(): Promise<string[]> {
  try {
    const res = await fetch('/api/lint/frontmatter-schemas');
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    const parsed = FrontmatterSchemasListSuccessSchema.safeParse(body);
    if (!parsed.success) {
      console.warn(
        '[lint] frontmatter-schemas response failed schema validation',
        parsed.error.issues,
      );
      return [];
    }
    return parsed.data.schemas;
  } catch {
    return [];
  }
}

/**
 * POST a create-empty request to the schema write endpoint (no field) —
 * scaffolds `<file>` with the default-dialect skeleton if it doesn't exist yet, so
 * the picker's "create new schema" lands a real, valid file. Idempotent
 * server-side (an existing file is left untouched). Emits
 * `emitLintConfigChanged()` on success so the picker list + open editors refresh.
 */
export async function createEmptyFrontmatterSchema(
  file: string,
): Promise<{ ok: true } | { ok: false; errorDetail: string | null }> {
  const result = await postFrontmatterSchema({ file });
  if (result.ok) emitLintConfigChanged();
  return result;
}

/**
 * POST a remove-field request — drops the field's properties entry and
 * required membership from the schema file. Callers pair a success with
 * `emitLintConfigChanged()`.
 */
export async function removeFrontmatterSchemaField(
  file: string,
  field: string,
  parentPath: readonly SchemaParentPathSegment[] = [],
): Promise<{ ok: true } | { ok: false; errorDetail: string | null }> {
  return postFrontmatterSchema({
    file,
    field,
    removeField: true,
    parentPath: wireParentPath(parentPath),
  });
}

/**
 * POST a rename-field request — carries the field's full property object
 * (including keywords the GUI does not model) and its required membership to
 * the new name. The server refuses a rename onto an existing field. Callers
 * pair a success with `emitLintConfigChanged()`.
 */
export async function renameFrontmatterSchemaField(
  file: string,
  field: string,
  renameTo: string,
  parentPath: readonly SchemaParentPathSegment[] = [],
): Promise<{ ok: true } | { ok: false; errorDetail: string | null }> {
  return postFrontmatterSchema({ file, field, renameTo, parentPath: wireParentPath(parentPath) });
}

/**
 * POST a delete request to the schema write endpoint — removes a schema file
 * (`*.schema.json` anywhere, or `.ok/schemas/*.json`; the server refuses
 * anything else). Idempotent server-side. Emits `emitLintConfigChanged()` on
 * success so the browser list + open editors refresh.
 */
export async function deleteFrontmatterSchema(
  file: string,
): Promise<{ ok: true } | { ok: false; errorDetail: string | null }> {
  const result = await postFrontmatterSchema({ file, delete: true });
  if (result.ok) emitLintConfigChanged();
  return result;
}

/**
 * Live list of the project's `.ok/schemas/*.json` files for the mapping
 * picker. Refetches on mount and on any `lint-config-changed` event (e.g.
 * after `createEmptyFrontmatterSchema` writes a new file); `refresh` lets a
 * caller re-pull on demand (e.g. when the picker popover opens).
 */
export function useFrontmatterSchemaFiles(): { schemas: string[]; refresh: () => void } {
  const [schemas, setSchemas] = useState<string[]>([]);
  const refresh = () => {
    void listFrontmatterSchemas().then(setSchemas);
  };
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listFrontmatterSchemas().then((next) => {
        if (!cancelled) setSchemas(next);
      });
    };
    load();
    const unsub = subscribeToLintConfigChanged(load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return { schemas, refresh };
}

/**
 * Live per-doc lint config. Refetches when `docName` changes and on any
 * `lint-config-changed` event (e.g. after a native-rule write in Settings).
 */
export function useDocLintConfig(docName: string | null): {
  data: LintConfigResponse | null;
} {
  const [data, setData] = useState<LintConfigResponse | null>(null);
  useEffect(() => {
    if (!docName) {
      setData(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void fetchLintConfig(docName).then((next) => {
        if (!cancelled) setData(next);
      });
    };
    load();
    const unsub = subscribeToLintConfigChanged(load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [docName]);
  return { data };
}

/**
 * Live project-level lint config (the Settings rule editor — no doc needed).
 * Refetches on any `lint-config-changed` event.
 */
export function useProjectLintConfig(): { data: LintConfigResponse | null } {
  const [data, setData] = useState<LintConfigResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchLintConfig().then((next) => {
        if (!cancelled) setData(next);
      });
    };
    load();
    const unsub = subscribeToLintConfigChanged(load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return { data };
}
