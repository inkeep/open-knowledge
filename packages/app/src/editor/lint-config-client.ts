/**
 * Client for the lint-config endpoints. The editor reads the doc's EFFECTIVE
 * config (project base + native `.markdownlint.*` rules) to lint with; the
 * Settings GUI reads the project config and writes native markdownlint rules.
 * A window event lets a config write re-lint the open editor live.
 */

import {
  type LintAuditResponse,
  LintAuditResponseSchema,
  type LintConfigResponse,
  LintConfigResponseSchema,
  type LinterConfig,
  type LintFixResult,
  LintFixResultSchema,
  type MarkdownlintRuleWriteValue,
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
 * GET a project-wide (or sub-path) lint audit. Returns every in-scope doc that
 * has at least one diagnostic, plus file/error/warning counts. null on failure.
 */
export async function runLintAudit(targetPath?: string): Promise<LintAuditResponse | null> {
  try {
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    const res = await fetch(`/api/lint/audit${query}`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const parsed = LintAuditResponseSchema.safeParse(body);
    if (!parsed.success) {
      // Mirror the sibling `fetchLintConfig` logging so a client/server schema
      // drift window leaves a diagnostic trail instead of a silent null.
      console.warn('[lint] audit response failed schema validation', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * POST a whole-doc auto-fix. The body carries no agent identity on purpose:
 * a UI-initiated deterministic fix is the principal's write (the human
 * clicked the button), and the server resolves a bare body to the loaded
 * principal. Used per-file by the project-scope Fix all sweep.
 */
export async function fixLintDoc(
  docName: string,
): Promise<{ ok: true; result: LintFixResult } | { ok: false; errorDetail: string | null }> {
  try {
    const res = await fetch('/api/lint/fix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docName }),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { title?: unknown } | null;
      return {
        ok: false,
        errorDetail: typeof errBody?.title === 'string' ? errBody.title : null,
      };
    }
    const body = await res.json().catch(() => null);
    const parsed = LintFixResultSchema.safeParse(body);
    if (!parsed.success) {
      // Mirror the sibling fetchLintConfig/runLintAudit logging so a
      // client/server schema drift leaves a diagnostic trail instead of a
      // silent failure.
      console.warn('[lint] fix response failed schema validation', parsed.error.issues);
      return { ok: false, errorDetail: null };
    }
    return { ok: true, result: parsed.data };
  } catch {
    return { ok: false, errorDetail: null };
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
