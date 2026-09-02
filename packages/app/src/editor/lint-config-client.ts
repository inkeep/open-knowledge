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

export function emitLintConfigChanged(): void {
  window.dispatchEvent(new CustomEvent(LINT_CONFIG_CHANGED_EVENT));
}

export function subscribeToLintConfigChanged(onChange: () => void): () => void {
  const listener = () => onChange();
  window.addEventListener(LINT_CONFIG_CHANGED_EVENT, listener);
  return () => window.removeEventListener(LINT_CONFIG_CHANGED_EVENT, listener);
}

async function fetchLintConfig(docName?: string): Promise<LintConfigResponse | null> {
  try {
    const query = docName !== undefined ? `?doc=${encodeURIComponent(docName)}` : '';
    const res = await fetch(`/api/lint/config${query}`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const parsed = LintConfigResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.warn('[lint] lint-config response failed schema validation', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export async function fetchEffectiveLintConfig(docName: string): Promise<LinterConfig | null> {
  const response = await fetchLintConfig(docName);
  return response?.effective ?? null;
}

export const LINT_FIX_TIMEOUT_MS = 30_000;

export async function fixLintDoc(
  docName: string,
): Promise<
  | { ok: true; result: LintFixResult }
  | { ok: false; errorDetail: string | null; status: number | null; problemType: string | null }
> {
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
      console.warn('[lint] fix response failed schema validation', parsed.error.issues);
      return { ok: false, errorDetail: null, status: res.status, problemType: null };
    }
    return { ok: true, result: parsed.data };
  } catch (err) {
    console.warn('[lint] fix request failed', docName, err instanceof Error ? err.message : err);
    return { ok: false, errorDetail: null, status: null, problemType: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function writeMarkdownlintRule(
  ruleId: string,
  value: MarkdownlintRuleWriteValue | null,
): Promise<{ ok: true; response: LintConfigResponse } | { ok: false; errorDetail: string | null }> {
  try {
    const res = await fetch('/api/lint/markdownlint-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleId, value }),
    });
    if (!res.ok) {
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

function wireParentPath(
  parentPath: readonly SchemaParentPathSegment[],
): readonly SchemaParentPathSegment[] | undefined {
  return parentPath.length > 0 ? parentPath : undefined;
}

export async function writeFrontmatterSchemaField(
  file: string,
  field: string,
  constraint: FrontmatterFieldConstraint,
  parentPath: readonly SchemaParentPathSegment[] = [],
): Promise<{ ok: true; response: LintConfigResponse } | { ok: false; errorDetail: string | null }> {
  return postFrontmatterSchema({ file, field, constraint, parentPath: wireParentPath(parentPath) });
}

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

export async function createEmptyFrontmatterSchema(
  file: string,
): Promise<{ ok: true } | { ok: false; errorDetail: string | null }> {
  const result = await postFrontmatterSchema({ file });
  if (result.ok) emitLintConfigChanged();
  return result;
}

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

export async function renameFrontmatterSchemaField(
  file: string,
  field: string,
  renameTo: string,
  parentPath: readonly SchemaParentPathSegment[] = [],
): Promise<{ ok: true } | { ok: false; errorDetail: string | null }> {
  return postFrontmatterSchema({ file, field, renameTo, parentPath: wireParentPath(parentPath) });
}

export async function deleteFrontmatterSchema(
  file: string,
): Promise<{ ok: true } | { ok: false; errorDetail: string | null }> {
  const result = await postFrontmatterSchema({ file, delete: true });
  if (result.ok) emitLintConfigChanged();
  return result;
}

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
