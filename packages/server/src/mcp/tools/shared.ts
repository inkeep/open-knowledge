import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AdvisoryWarningSchema,
  BrokenLinkSchema,
  validateDocName,
} from '@inkeep/open-knowledge-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../../config/schema.ts';
import { SUPPORTED_DOC_EXTENSIONS } from '../../doc-extensions.ts';
import type { LocalApiDispatch } from '../../http/local-api-dispatch.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import { resolveWithinRoot } from './path-safety.ts';

export type ServerInstance = McpServer;
export type ConfigOrResolver = Config | ((cwd?: string) => Promise<Config>);

/**
 * The agent-identity fields every mutating route accepts for attribution
 * (precedent #24/#25). Spread into a POST body: `{ ...agentIdentityFields(id) }`.
 * Returns an empty object when no identity is bound, so anonymous writes stay
 * anonymous. Single source for the four CRUD verbs + any future write tool.
 */
export function agentIdentityFields(identity: AgentIdentity | undefined): Record<string, unknown> {
  return identity
    ? {
        agentId: identity.connectionId,
        agentName: identity.displayName,
        clientName: identity.clientInfo?.name,
        colorSeed: identity.colorSeed,
      }
    : {};
}
export const ROUTED_CWD_DESCRIPTION =
  'Absolute host path inside the target OpenKnowledge project. Required when the MCP server is registered globally (e.g. `npx @inkeep/open-knowledge mcp` once at the host level, routing per call), unless the MCP client advertises exactly one root via the `roots` capability — that single root is then used as the implicit `cwd`. Optional when the server is anchored to a single project (the per-project HTTP MCP server defaults to its configured project root).';

const SUMMARY_TRANSPORT_CAP = 200;

export const summaryArgSchema = z
  .string()
  .max(SUMMARY_TRANSPORT_CAP)
  .optional()
  .describe(
    'Optional one-line user-outcome description (≤80 chars). Appears as a bullet in the timeline.',
  );

export const VERSION_FIELD_DESCRIBE =
  'A 40-character commit SHA identifying a saved version. Produced by `checkpoint`, listed by `history` as `entries[].version`, and consumed here — the same `version` field name across all three.';

export const versionInputSchema = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]+$/i)
  .describe(VERSION_FIELD_DESCRIBE);

export const previewUrlOutputField = z
  .string()
  .nullable()
  .describe('Route-only preview URL (`/#/<doc>`, no host:port), or null when no UI is running.');

export const previewUrlSourceField = z
  .string()
  .optional()
  .describe('How the previewUrl was resolved (e.g. the UI lock).');

export const previousPreviewUrlField = z
  .string()
  .optional()
  .describe('Route of the prior/removed path, for closing a stale preview tab.');

export const summaryOutputSchema = z
  .object({
    value: z.string(),
    truncatedFrom: z.number().optional(),
    hint: z.string().optional(),
  })
  .describe('Normalized change-note summary, when one was recorded.');

export const looseObjectArray = z.array(z.record(z.string(), z.unknown()));

export const previewAttachWarningField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Preview-attach hint (`{ action, previewUrl?, message? }`) when relevant.');

const brokenLinksOutputField = z
  .array(BrokenLinkSchema)
  .describe(
    'Outbound internal links in the just-written doc that do not resolve. Always present — `[]` means every link resolves. Each: `{ href (as written), resolvedTo (the docName or content-root file path it pointed at, or null), reason: "no-such-doc" | "no-such-file" | "unresolvable" }`. Report-only — the write landed regardless; fix in a follow-up edit.',
  );

export function docExtensionOnDisk(
  contentDir: string,
  docName: string,
): (typeof SUPPORTED_DOC_EXTENSIONS)[number] | undefined {
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    const contained = resolveWithinRoot(contentDir, `${docName}${ext}`);
    if (contained.ok && existsSync(contained.abs)) return ext;
  }
  return undefined;
}

export const documentResultBaseShape = {
  summary: summaryOutputSchema.optional(),
  warnings: z
    .array(AdvisoryWarningSchema)
    .min(1)
    .optional()
    .describe(
      "Advisory entries discriminated by `kind`. Write-integrity kinds — `content-divergence` (converged Y.Text didn't byte-match what you composed) and `disk-edit-reconciled` (an out-of-band disk edit was folded in before your write) — mean re-read the doc. The renderability kind `mermaid-parse-error` means the write landed but that fence will not render — fix it and re-edit.",
    ),
  brokenLinks: brokenLinksOutputField,
  templateHint: z
    .array(z.object({ name: z.string(), description: z.string().optional() }))
    .min(1)
    .optional()
    .describe(
      "Templates the parent folder offers, present only when a create passed no `template`. A nudge — the write already landed; pass `template` next time to match the folder's shape.",
    ),
} as const;

export function nestDocResult(
  preview: { url: string; source: string } | null | undefined,
  warning: Record<string, unknown> | undefined,
  docFields: Record<string, unknown>,
): Record<string, unknown> {
  const structured: Record<string, unknown> = {};
  if (preview) {
    structured.previewUrl = preview.url;
    structured.previewUrlSource = preview.source;
  }
  if (warning) structured.warning = warning;
  if (Object.keys(docFields).length > 0) structured.document = docFields;
  return structured;
}

export function errorTextWithDetail(result: { [key: string]: unknown }): string {
  const detail = typeof result.detail === 'string' ? ` (${result.detail})` : '';
  const title = typeof result.error === 'string' ? result.error : 'request failed';
  return `Error: ${title}${detail}`;
}

export function textResult(text: string, isError?: boolean) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

export const TEXT_CHANNEL_FIELD = z
  .string()
  .optional()
  .describe(
    'Auto-duplicated body text. `textPlusStructured` mirrors the visible body here as a Claude / Claude Desktop client-quirk workaround (those clients hide `content[]` when `structuredContent` is present). Internal — programmatic consumers should prefer the `content[0].text` channel.',
  );

export function outputSchemaWithText<S extends z.ZodRawShape>(
  shape: S,
): Omit<{ text: typeof TEXT_CHANNEL_FIELD }, keyof S> & S {
  return {
    text: TEXT_CHANNEL_FIELD,
    ...shape,
  } as Omit<{ text: typeof TEXT_CHANNEL_FIELD }, keyof S> & S;
}

export function textPlusStructured<T>(text: string, structured: T, isError?: boolean) {
  const structuredContent: { text: string } & Record<string, unknown> = {
    text,
    ...(structured as unknown as Record<string, unknown>),
  };
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
    ...(isError ? { isError: true as const } : {}),
  };
}

export const HOCUSPOCUS_NOT_RUNNING_ERROR =
  'Error: Hocuspocus server is not running. Start it with `ok start`, then retry.\nDo not fall back to native file edits for in-scope markdown; route writes through OpenKnowledge so attribution and live sync stay intact.';

export type ServerUrlOrResolver =
  | string
  | undefined
  | ((cwd?: string) => Promise<string | undefined>);

export async function resolveServerUrl(
  x: ServerUrlOrResolver,
  cwd?: string,
): Promise<string | undefined> {
  return typeof x === 'function' ? await x(cwd) : x;
}

async function resolveConfig(x: ConfigOrResolver, cwd?: string): Promise<Config> {
  return typeof x === 'function' ? await x(cwd) : x;
}

export async function resolveProjectConfigContext(
  resolveCwd: (explicit?: string) => Promise<string>,
  config: ConfigOrResolver,
  explicitCwd?: string,
): Promise<
  { ok: true; cwd: string; executionCwd: string; config: Config } | { ok: false; error: string }
> {
  let cwd: string;
  try {
    cwd = await resolveCwd(explicitCwd);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const executionCwd = explicitCwd !== undefined ? resolve(explicitCwd) : cwd;
  try {
    const resolvedConfig = await resolveConfig(config, cwd);
    return { ok: true, cwd, executionCwd, config: resolvedConfig };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function requireProjectServer(
  resolveCwd: (explicit?: string) => Promise<string>,
  config: ConfigOrResolver,
  serverUrl: ServerUrlOrResolver,
  explicitCwd?: string,
): Promise<
  | { ok: true; cwd: string; executionCwd: string; config: Config; url: string }
  | { ok: false; result: ReturnType<typeof textResult> }
> {
  const context = await resolveProjectServerContext(resolveCwd, config, serverUrl, explicitCwd);
  if (!context.ok) return { ok: false, result: textResult(`Error: ${context.error}`, true) };
  if (!context.url) return { ok: false, result: textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true) };
  return {
    ok: true,
    cwd: context.cwd,
    executionCwd: context.executionCwd,
    config: context.config,
    url: context.url,
  };
}

export async function resolveProjectServerContext(
  resolveCwd: (explicit?: string) => Promise<string>,
  config: ConfigOrResolver,
  serverUrl: ServerUrlOrResolver,
  explicitCwd?: string,
): Promise<
  | { ok: true; cwd: string; executionCwd: string; config: Config; url: string | undefined }
  | { ok: false; error: string }
> {
  const configContext = await resolveProjectConfigContext(resolveCwd, config, explicitCwd);
  if (!configContext.ok) {
    return configContext;
  }
  const { cwd, executionCwd, config: resolvedConfig } = configContext;
  try {
    const url = await resolveServerUrl(serverUrl, cwd);
    return { ok: true, cwd, executionCwd, config: resolvedConfig, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function okReservedPathRedirect(path: string): string | null {
  const p = path.replace(/^\/+/, '');
  if (p !== '.ok' && !p.startsWith('.ok/')) return null;
  if (p.startsWith('.ok/skills/')) {
    return 'Skills are authored with the `skill` target, not a raw document path: `write({ skill: { name, description, body?, scope? } })` writes the SKILL.md wherever the skill lives (a NEW skill lands at the project default skill home, e.g. `.agents/skills/<name>/`). To author or improve a skill, use the `open-knowledge-write-skill` skill.';
  }
  if (p.startsWith('.ok/templates/')) {
    return 'Templates are authored with the `template` target (`write({ template: { … } })`), not a raw document path.';
  }
  return 'Paths under `.ok/` are not addressable as documents. Edit folder config/frontmatter via the `folder` target, skills via the `skill` target, and templates via the `template` target.';
}

export function normalizeDocName(
  raw: string,
): { ok: true; docName: string } | { ok: false; error: string } {
  const lower = raw.toLowerCase();
  if (lower.endsWith('.markdown')) {
    return {
      ok: false,
      error: `Error: "${raw}" ends in ".markdown", which is not a supported extension. Use ".md" or ".mdx", or strip the extension to let the server auto-detect.`,
    };
  }
  let candidate = raw;
  let lowerCandidate = lower;
  while (lowerCandidate.endsWith('.mdx') || lowerCandidate.endsWith('.md')) {
    candidate = candidate.slice(0, lowerCandidate.endsWith('.mdx') ? -4 : -3);
    lowerCandidate = candidate.toLowerCase();
  }
  const validation = validateDocName(candidate);
  if (!validation.ok) {
    return { ok: false, error: `Error: "${raw}" is invalid — ${validation.reason}.` };
  }
  return { ok: true, docName: candidate };
}

/**
 * Canonicalize a server response into the `{ ok: boolean, ...payload }` shape
 * MCP-tool consumers read against. The boundary canonicalizer pattern lets
 * tool handlers stay unaware of HTTP status semantics or the RFC 9457 wire
 * shape (precedent #38).
 *
 * Server contract:
 *   - 2xx: flat success body, e.g. `{ renamed, rewrittenDocs, summary? }`
 *     with `application/json`. No `ok` wrapper.
 *   - 4xx/5xx: RFC 9457 `{ type, title, status, instance, detail?, ...extensions }`
 *     with `application/problem+json`. Extensions (e.g. `colliding`) ride
 *     alongside the canonical fields.
 *
 * Body extension members are spread onto the top level so consumers
 * automatically pick up new typed extensions (e.g. `colliding[]`) without a
 * per-tool change.
 */
function normalizeResponse(
  res: { ok: boolean; status: number },
  body: unknown,
): { ok: boolean; [key: string]: unknown } {
  if (res.ok) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: true, data: body };
    }
    const { ok: _ok, ...rest } = body as Record<string, unknown>;
    return { ok: true, ...rest };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: `Server returned HTTP ${res.status} with non-object body`,
    };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.type === 'string' && typeof record.title === 'string') {
    const { type, title, status, instance, detail, ...extensions } = record;
    return {
      ...extensions,
      ok: false,
      error: title,
      type,
      ...(typeof status === 'number' ? { status } : {}),
      ...(typeof instance === 'string' ? { instance } : {}),
      ...(typeof detail === 'string' ? { detail } : {}),
    };
  }
  const { ok: _ok, error: bodyError, ...rest } = record;
  const fallbackError =
    typeof bodyError === 'string'
      ? bodyError
      : typeof record.message === 'string'
        ? record.message
        : `Server returned HTTP ${res.status}`;
  return { ...rest, ok: false, error: fallbackError };
}

export type ApiTarget = string | { url: string; local: LocalApiDispatch };

export function apiTarget(url: string, local: LocalApiDispatch | undefined): ApiTarget {
  return local ? { url, local } : url;
}

async function localApiCall(
  local: LocalApiDispatch,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  serializedBody: string | undefined,
  includeHttpStatus: boolean,
): Promise<{ ok: boolean; [key: string]: unknown } | null> {
  let raw: { status: number; bodyText: string } | null;
  try {
    raw = await local(
      method,
      path,
      serializedBody !== undefined
        ? { body: serializedBody, contentType: 'application/json' }
        : undefined,
    );
  } catch (err) {
    return { ok: false, error: `Server unreachable: ${err instanceof Error ? err.message : err}` };
  }
  if (raw === null) return null;
  const ok = raw.status >= 200 && raw.status <= 299;
  let body: unknown;
  try {
    body = JSON.parse(raw.bodyText);
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    const statusFields = includeHttpStatus ? { httpStatus: raw.status } : {};
    if (ok) {
      return {
        ok: false,
        ...statusFields,
        error: `Server returned 2xx response with non-JSON body: ${detail}`,
      };
    }
    return {
      ok: false,
      ...statusFields,
      error: `Server returned HTTP ${raw.status} with non-JSON body: ${detail}`,
    };
  }
  const normalized = normalizeResponse({ ok, status: raw.status }, body);
  return includeHttpStatus ? { ...normalized, httpStatus: raw.status } : normalized;
}

export async function httpGet(
  base: ApiTarget,
  path: string,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  if (typeof base !== 'string') {
    const local = await localApiCall(base.local, 'GET', path, undefined, true);
    if (local !== null) return local;
    base = base.url;
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return { ok: false, error: `Server unreachable: ${err instanceof Error ? err.message : err}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    if (res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: `Server returned 2xx response with non-JSON body: ${detail}`,
      };
    }
    return {
      ok: false,
      httpStatus: res.status,
      error: `Server returned HTTP ${res.status} with non-JSON body: ${detail}`,
    };
  }
  return { ...normalizeResponse(res, body), httpStatus: res.status };
}

export async function httpGetRows(
  base: ApiTarget,
  path: string,
  field: string,
): Promise<
  { error: string } | { rows: Array<Record<string, unknown>>; data: Record<string, unknown> }
> {
  const result = await httpGet(base, path);
  if (!result.ok) {
    return { error: typeof result.error === 'string' ? result.error : 'request failed' };
  }
  const { ok: _ok, ...data } = result;
  const raw = (data as Record<string, unknown>)[field];
  const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  return { rows, data };
}

async function httpSend(
  method: 'POST' | 'PUT' | 'DELETE',
  base: ApiTarget,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  let serializedBody: string | undefined;
  if (body !== undefined) {
    try {
      serializedBody = JSON.stringify(body);
    } catch (stringifyErr) {
      return {
        ok: false,
        error: `Request body is not JSON-serializable: ${stringifyErr instanceof Error ? stringifyErr.message : String(stringifyErr)}`,
      };
    }
  }
  if (typeof base !== 'string') {
    const local = await localApiCall(base.local, method, path, serializedBody, false);
    if (local !== null) return local;
    base = base.url;
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: serializedBody !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: serializedBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, error: `Server unreachable: ${err instanceof Error ? err.message : err}` };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    if (res.ok) {
      return {
        ok: false,
        error: `Server returned 2xx response with non-JSON body: ${detail}`,
      };
    }
    return {
      ok: false,
      error: `Server returned HTTP ${res.status} with non-JSON body: ${detail}`,
    };
  }
  return normalizeResponse(res, parsed);
}

export function httpPost(
  base: ApiTarget,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return httpSend('POST', base, path, body);
}

export function httpPut(
  base: ApiTarget,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return httpSend('PUT', base, path, body);
}

export function httpDelete(
  base: ApiTarget,
  path: string,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return httpSend('DELETE', base, path);
}

export interface RenameCollisionPair {
  existing: string;
  incoming: string;
  to: string;
}

export function parseRenameCollidingPairs(value: unknown): RenameCollisionPair[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { existing, incoming, to } = entry as Record<string, unknown>;
    return typeof existing === 'string' && typeof incoming === 'string' && typeof to === 'string'
      ? [{ existing, incoming, to }]
      : [];
  });
}

export const AUDIT_FILE_CAP = 10;
export const AUDIT_FILE_DIAGNOSTIC_CAP = 10;

export const AUDIT_WARNING_CAP = 10;

const ATTRIBUTED_VALIDATION_FAILURE = /^(?:source(?: family)?|validator) "/;

export function capAuditWarnings(warnings: readonly string[]): {
  shownWarnings: string[];
  omittedWarningCount: number;
} {
  const attributed: string[] = [];
  const generic: string[] = [];
  for (const warning of warnings) {
    (ATTRIBUTED_VALIDATION_FAILURE.test(warning) ? attributed : generic).push(warning);
  }
  const shownWarnings = [...attributed, ...generic].slice(0, AUDIT_WARNING_CAP);
  return {
    shownWarnings,
    omittedWarningCount: warnings.length - shownWarnings.length,
  };
}

export function degradationBlock(
  kind: 'Lint' | 'Audit',
  shown: readonly string[],
  omitted = 0,
): string[] {
  const total = shown.length + omitted;
  if (total === 0) return [];
  return [
    `${kind} incomplete — ${total} warning${total === 1 ? '' : 's'} (findings may be partial):`,
    ...shown.map((warning) => `  ⚠ ${warning}`),
    ...(omitted > 0 ? [`  … and ${omitted} more warning${omitted === 1 ? '' : 's'}`] : []),
  ];
}

export interface FormattableDiagnostic {
  severity?: string;
  range?: { start?: { line?: number } };
  source?: string;
  code?: string;
  message?: string;
}

export function formatDiagnosticLine(d: FormattableDiagnostic): string {
  const marker = d.severity === 'error' ? '✘' : '⚠';
  const startLine = d.range?.start?.line;
  const where = startLine !== undefined ? `line ${startLine + 1}` : 'line ?';
  const flatId = d.source !== undefined && d.code !== undefined ? `${d.source}/${d.code}` : '?';
  return `  ${marker} ${where} ${flatId}: ${d.message ?? ''}`.trimEnd();
}

export function countSummary(errorCount: number, warningCount: number): string {
  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  if (warningCount > 0) parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(', ') : 'no problems';
}
