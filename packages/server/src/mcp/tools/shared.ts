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
import type { AgentIdentity } from '../agent-identity.ts';
import { resolveWithinRoot } from './path-safety.ts';

export type ServerInstance = McpServer;
export type ConfigOrResolver = Config | ((cwd?: string) => Promise<Config>);

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
  'Error: Hocuspocus server is not running. Start it with `ok start`, then retry.\nFor disk-only writes without real-time sync, use your native Edit tool directly.';

type WorkflowRole = 'ingest' | 'research' | 'consolidate';

const ROLE_LABEL: Record<WorkflowRole, string> = {
  ingest: 'raw-sources layer (preserve external material, no analysis)',
  research: 'wiki layer, provisional (synthesize findings that can still change)',
  consolidate: 'wiki layer, canonical (promote stabilized research to source-of-truth)',
};

const ROLE_BEFORE: Record<WorkflowRole, string> = {
  ingest: 'user shares a URL or file they want preserved, or `research` needs raw sources',
  research: '`ingest` has captured the relevant sources (or the user points at one)',
  consolidate:
    '`research` has produced a provisional article AND a decision has actually been made',
};

const ROLE_AFTER: Record<WorkflowRole, string> = {
  ingest:
    'often `research` on the same topic — or just stop; raw preservation is frequently enough on its own',
  research:
    'usually stop (research lives as provisional indefinitely) or `consolidate` once a decision lands',
  consolidate:
    'update 2–3 neighbor docs to link the new canonical article; research articles it supersedes gain a `superseded_by` pointer',
};

function buildWorkflowFrame(role: WorkflowRole): string {
  return `## Where this fits

OpenKnowledge accretes a persistent wiki through three workflow tools, mapped to [Karpathy's three-layer knowledge-base pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

- **Raw sources** (immutable) — \`ingest\`
- **Wiki, provisional** — \`research\`
- **Wiki, canonical** — \`consolidate\`

(Project-level folder structure: \`ok seed\` for fresh repos with the Karpathy three-layer; \`workflow({ kind: "discover" })\` for existing-content repos that need conventions extracted from siblings. Neither is required — these three tools work against any folder structure the project already uses.)

**This tool operates in the ${ROLE_LABEL[role]}.**

- **Before this:** ${ROLE_BEFORE[role]}
- **After this:** ${ROLE_AFTER[role]}

Karpathy's insight: "The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping." Humans abandon wikis because maintenance costs exceed perceived value. These tools exist so an agent can do the bookkeeping (fetching, summarizing, cross-linking, superseding) without fatigue. Follow the steps below faithfully — skipping the cross-linking, supersedes chains, or raw-source preservation is what turns a useful wiki back into an abandoned one.

`;
}

export interface WorkflowToolDeps {
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

export function buildWorkflowHandler(
  role: WorkflowRole,
  deps: WorkflowToolDeps,
  argName: string,
  buildBody: (argValue: string, contentDir: string) => string,
) {
  return async (args: Record<string, unknown>) => {
    const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
    const context = await resolveProjectConfigContext(deps.resolveCwd, deps.config, cwd);
    if (!context.ok) return textResult(`Error: ${context.error}`, true);
    const rawArg = args[argName];
    const argValue = typeof rawArg === 'string' ? rawArg : '';
    const body = `${buildWorkflowFrame(role)}${buildBody(argValue, context.config.content.dir)}`;
    return textPlusStructured(body, { previewUrl: null });
  };
}

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
    return 'Skills are authored with the `skill` target, not a raw document path: `write({ skill: { name, description, body?, scope? } })` writes `.ok/skills/<name>/SKILL.md`. To author or improve a skill, use the `open-knowledge-write-skill` skill.';
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

function normalizeResponse(res: Response, body: unknown): { ok: boolean; [key: string]: unknown } {
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

export async function httpGet(
  baseUrl: string,
  path: string,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(30_000) });
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

async function httpSend(
  method: 'POST' | 'PUT' | 'DELETE',
  baseUrl: string,
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
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
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
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return httpSend('POST', baseUrl, path, body);
}

export function httpPut(
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return httpSend('PUT', baseUrl, path, body);
}

export function httpDelete(
  baseUrl: string,
  path: string,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  return httpSend('DELETE', baseUrl, path);
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
