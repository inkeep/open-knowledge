/**
 * Shared helpers for MCP tool registration.
 *
 * Each tool file in this directory exports a `register(server)` function
 * that calls `server.registerTool(...)` with its name, description/input
 * schema, optional output schema/annotations, and handler. `index.ts`
 * aggregates the registrations into a single `registerAllTools` function
 * that `server.ts` calls during startup.
 */

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

// ─── Agent-write summary schema (shared across the MCP write tools) ─────
//
// The 200-char Zod cap (transport-safety bound) and the "≤80 chars"
// render-cap description (render bound, enforced server-side by
// `MAX_SUMMARY_LENGTH` in packages/server/src/agent-write-summary.ts) live
// here so the two bounds stay in sync across write, edit, move, and checkpoint
// with one place to re-tune.

/**
 * Transport-safety upper bound for `summary` at the MCP layer.
 * Rejects payloads > 200 chars BEFORE they hit the HTTP boundary. Separate
 * from the server-side render cap (80) — see `MAX_SUMMARY_LENGTH`.
 */
const SUMMARY_TRANSPORT_CAP = 200;

/**
 * Shared Zod schema for the `summary` param on write, edit, move, and
 * checkpoint. Includes the description that
 * surfaces in tool introspection for agents — keep the "(≤80 chars)" phrasing
 * here as the single source of truth (matches the API-side `MAX_SUMMARY_LENGTH`
 * constant).
 */
export const summaryArgSchema = z
  .string()
  .max(SUMMARY_TRANSPORT_CAP)
  .optional()
  .describe(
    'Optional one-line user-outcome description (≤80 chars). Appears as a bullet in the timeline.',
  );

/**
 * `version` — the single cross-tool vocabulary for a saved restore point. A
 * 40-char commit SHA, produced by `checkpoint` (output `version`), listed by
 * `history` (output `entries[].version`), and consumed by `restore_version`
 * (input `version`). One name, all three sides, so the handoff is copy-paste.
 * The underlying git/shadow-repo field is `sha` — the rename to `version`
 * happens at the MCP tool layer only; the HTTP routes + editor UI keep `sha`.
 */
export const VERSION_FIELD_DESCRIBE =
  'A 40-character commit SHA identifying a saved version. Produced by `checkpoint`, listed by `history` as `entries[].version`, and consumed here — the same `version` field name across all three.';

/** Validated `version` INPUT leaf (40-char lowercase-hex SHA). */
export const versionInputSchema = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]+$/i)
  .describe(VERSION_FIELD_DESCRIBE);

// ── Shared OUTPUT-schema leaves ──────────────────────────────────────────────
// Reused across every tool that returns the common envelope, so the preview /
// summary / error shapes stay identical (and stay in sync with what the
// handlers actually emit). `.describe(...)` at a call site overrides the default
// where a tool wants tool-specific wording without re-declaring the type.

/** Route-only preview URL (`/#/<doc>`), or null when no UI is running. */
export const previewUrlOutputField = z
  .string()
  .nullable()
  .describe('Route-only preview URL (`/#/<doc>`, no host:port), or null when no UI is running.');

/** How a `previewUrl` was resolved (e.g. from the UI lock). */
export const previewUrlSourceField = z
  .string()
  .optional()
  .describe('How the previewUrl was resolved (e.g. the UI lock).');

/** Route of a now-removed/old path, so a client can close a stale preview tab. */
export const previousPreviewUrlField = z
  .string()
  .optional()
  .describe('Route of the prior/removed path, for closing a stale preview tab.');

/** Normalized change-note summary as emitted by the write-spine handlers. */
export const summaryOutputSchema = z
  .object({
    value: z.string(),
    truncatedFrom: z.number().optional(),
    hint: z.string().optional(),
  })
  .describe('Normalized change-note summary, when one was recorded.');

/** An array of loose objects (records with arbitrary keys) — for pass-through row sets. */
export const looseObjectArray = z.array(z.record(z.string(), z.unknown()));

/**
 * Preview-attach hint envelope field — the uniform top-level `warning` that
 * write/edit emit (`{ action: 'attach-preview-once' | 'start-ui', previewUrl?,
 * message? }`). Part of the cross-tool preview contract, so it stays top-level
 * (not nested under a target key).
 */
export const previewAttachWarningField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Preview-attach hint (`{ action, previewUrl?, message? }`) when relevant.');

/**
 * Base output fields of a single-document write/edit result, nested under the
 * `document` target key. `write` extends this with `hints`; `edit` uses it as
 * is. Keeps the two verbs' `document` result shape in sync.
 */
/**
 * `brokenLinks` output field for write/edit. Always present — `[]` is the
 * positive "every outbound link resolves" confirmation, replacing the separate
 * `links({ kind: 'dead' })` round-trip. Report-only: the write always landed.
 * Consumed only by `documentResultBaseShape` below (write + edit share it).
 */
const brokenLinksOutputField = z
  .array(BrokenLinkSchema)
  .describe(
    'Outbound internal links in the just-written doc that do not resolve. Always present — `[]` means every link resolves. Each: `{ href (as written), resolvedTo (the docName or content-root file path it pointed at, or null), reason: "no-such-doc" | "no-such-file" | "unresolvable" }`. Report-only — the write landed regardless; fix in a follow-up edit.',
  );

/**
 * The actual on-disk extension for an extension-less `docName` (`.mdx` wins
 * over `.md`, matching `SUPPORTED_DOC_EXTENSIONS` precedence), or `undefined`
 * when neither file exists. Lets a tool that knows only the docName resolve the
 * target's real extension instead of assuming `.md` — correct-by-construction
 * for an `.mdx` workspace.
 */
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

/**
 * Assemble a document write/edit `structuredContent`: the uniform preview
 * envelope (`previewUrl` / `previewUrlSource` / `warning`) stays top-level; the
 * document-specific fields nest under `document`. Shared by `write` + `edit` so
 * both produce the identical nesting. `preview` is typed structurally to avoid
 * a `preview-url.ts` import cycle; `docFields` is omitted when empty.
 */
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

/**
 * Wrap a single string into the content shape MCP tools require for text results.
 * Pass `isError: true` to signal a tool-level error to the caller.
 */
export function textResult(text: string, isError?: boolean) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/**
 * `text` is the auto-duplicated body channel `textPlusStructured` mirrors
 * into `structuredContent`. See the helper below for why we duplicate.
 *
 * MCP clients that strictly validate `structuredContent` against the tool's
 * declared JSON-schema (Claude does, via AJV) reject ANY field absent
 * from the schema — `text` included. Every tool that returns via
 * `textPlusStructured` AND registers with `server.registerTool({outputSchema:
 * ...})` MUST declare `text: optional()` so the emitted JSON-schema admits
 * the mirror field. `outputSchemaWithText(...)` is the single-source helper
 * that augments a raw shape with this field; use it instead of inlining the
 * declaration so the description stays in sync.
 *
 * Tools registered through the legacy `server.tool(...)` API bypass the
 * strict output-schema check and do not need this — but migrating to
 * `registerTool` requires routing the outputSchema through this helper or
 * the client rejects every call with `data must NOT have additional
 * properties`.
 */
export const TEXT_CHANNEL_FIELD = z
  .string()
  .optional()
  .describe(
    'Auto-duplicated body text. `textPlusStructured` mirrors the visible body here as a Claude / Claude Desktop client-quirk workaround (those clients hide `content[]` when `structuredContent` is present). Internal — programmatic consumers should prefer the `content[0].text` channel.',
  );

/**
 * Wrap a raw outputSchema shape with the optional `text` field that
 * `textPlusStructured` injects into every `structuredContent` payload. See
 * `TEXT_CHANNEL_FIELD` above for the why — without this, strict clients
 * reject the mirror field with `data must NOT have additional properties`.
 *
 * The default `text` declaration is laid down BEFORE the caller's shape, so
 * a caller that intentionally overrides `text` with a richer schema (e.g.
 * a literal type, a different description) wins on both the data side AND
 * the schema side. This mirrors the spread order in `textPlusStructured`:
 * the runtime structuredContent lets the caller override the mirror, so the
 * schema declaration honors the same contract.
 *
 * The return type uses `Omit<..., keyof S>` so when `S` contains `text` the
 * default is dropped from the intersection and the caller's type alone wins
 * — preserving the documented override semantics at the type level, not just
 * at runtime.
 */
export function outputSchemaWithText<S extends z.ZodRawShape>(
  shape: S,
): Omit<{ text: typeof TEXT_CHANNEL_FIELD }, keyof S> & S {
  return {
    text: TEXT_CHANNEL_FIELD,
    ...shape,
  } as Omit<{ text: typeof TEXT_CHANNEL_FIELD }, keyof S> & S;
}

/**
 * Dual-channel result (text `content` + machine-readable `structuredContent`).
 * Used by every tool that returns enriched metadata in structured form
 * alongside human-visible body text.
 *
 * **Client-quirk workaround (single-source).** Claude and Claude Desktop
 * (and some other MCP clients) hide the text `content` stream when
 * `structuredContent` is present — the agent sees only the structured payload
 * and the visible body silently vanishes
 * ([anthropics/claude-code#55677](https://github.com/anthropics/claude-code/issues/55677)).
 * Without a structured mirror of the body, `exec` arrives at the
 * model as `{previewUrl: null}` (file contents dropped),
 * the `workflow` tool (any `kind`: ingest/research/consolidate/discover)
 * arrives as `{previewUrl: null}` (the workflow prompt dropped), etc.
 *
 * Mitigation: every result built by this helper carries the same visible body
 * under `structuredContent.text`. The key MUST NOT carry a leading underscore
 * — MCP-spec reserves `_meta` for host-only metadata, and Claude-class
 * clients generalize the convention to strip ALL `_`-prefixed keys from
 * `structuredContent` before the model sees it (see also Cursor: strips
 * `_meta` from `ui/notifications/tool-result` before forwarding). A tool that
 * genuinely needs a semantically distinct channel can add its own field
 * alongside rather than reusing `text` — but don't re-emit the visible body
 * under a second key just to have a "raw" copy: that is pure wire duplication. The
 * caller's `structured` keys merge on top of `text`, so a caller that wants to
 * override (none do today) still can.
 *
 * The mirror field MUST be declared on every tool's outputSchema via
 * `outputSchemaWithText(...)` above; strict JSON-schema clients (Claude)
 * reject any undeclared key with `data must NOT have additional properties`.
 */
export function textPlusStructured<T>(text: string, structured: T, isError?: boolean) {
  // Annotate as `{ text: string } & Record<string, unknown>` so the index
  // signature survives the spread. A plain object-literal spread of
  // `Record<string, unknown>` collapses to `{ text: string }` and breaks
  // callers + tests that read other keys off `structuredContent`.
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

/** Error message for tools that require Hocuspocus to be running. */
export const HOCUSPOCUS_NOT_RUNNING_ERROR =
  'Error: Hocuspocus server is not running. Start it with `ok start`, then retry.\nFor disk-only writes without real-time sync, use your native Edit tool directly.';

// ─── Karpathy three-layer wiki frame (shared by the three Karpathy-layer tools) ───
//
// The three Karpathy-layer workflow tools — `ingest`, `research`, `consolidate`
// — accrete a persistent knowledge base over time, following the pattern
// described in Karpathy's "LLM Wiki: Personal Knowledge Bases" gist:
//
//   https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
//
// A fourth instructional workflow tool — `discover` — sits alongside these
// at the project-metadata layer (brownfield onboarding) but does NOT use
// this Karpathy frame. `discover` ships its own self-contained body via
// `discover-body.ts` and does not use `buildWorkflowHandler` below.
//
// Project-level scaffolding for fresh repos lives OUTSIDE this MCP surface
// — users run `ok seed` once from a terminal to populate the
// `external-sources/`, `research/`, `articles/` layout plus matching
// per-folder `.ok/` frontmatter + templates.
//
// Each Karpathy-layer tool body prepends a common "Where this fits" section
// so the agent orients on the layer + sibling tools + typical flow before
// diving into step-by-step instructions. One definition, three consumers.

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

/**
 * Prepend a "Where this fits" orientation block to a workflow tool body.
 * Names Karpathy's three-layer pattern, the tool's role, and the typical
 * Before/After flow. Keep this short — the bulk of instructional depth lives
 * in each tool's own step-by-step body that follows.
 *
 * Internal helper for `buildWorkflowHandler` below; tool files don't import
 * it directly any more.
 */
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

/**
 * Dependency shape shared by the three Karpathy-layer workflow tools
 * (`ingest`, `research`, `consolidate`). Each needs the same two resolvers
 * (config + cwd) so they collapse into one named contract.
 *
 * `discover` is a fourth instructional workflow tool but operates at the
 * project-metadata layer rather than the Karpathy three-layer, so it does
 * NOT use this dependency shape or `buildWorkflowHandler` below — it
 * defines its own `DiscoverDeps` interface and uses `registerTool` directly
 * (matching the convention of `registerTool`-based config tools like
 * `config`).
 */
export interface WorkflowToolDeps {
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

/**
 * Build the async callback shared by the three Karpathy-layer workflow tools
 * — `ingest` / `research` / `consolidate`. Not used by `discover`, which
 * ships its own handler (it lives at the project-metadata layer and does NOT
 * prepend the Karpathy frame).
 *
 * Hoists the four behaviors that were copy-pasted across the three workflow
 * tool files:
 *
 *   1. resolve the project's config + cwd context (consistent error path)
 *   2. read the primary arg by name out of the validated zod input
 *   3. prepend `buildWorkflowFrame(role)` to the tool-specific body
 *   4. return `{ previewUrl: null }` in structuredContent — workflow tools
 *      are primers keyed on a single argument; the target document path is
 *      chosen by the agent during the prompt's later steps, so there is no
 *      single canonical document to preview at call time, uniform with
 *      `checkpoint`
 *
 * Each workflow tool registers with its own literal-typed zod input schema
 * so MCP's callback-arg inference stays precise — only the schema literal
 * (one tool-specific arg + optional `cwd`) and `DESCRIPTION` remain per-tool.
 * The schema's `cwd` field uses the shared `ROUTED_CWD_DESCRIPTION` string.
 */
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

/**
 * Either an eagerly-known server URL, an absent URL, or a lazy resolver that
 * computes the URL per-call. The lazy resolver receives the effective cwd of
 * the current tool invocation when available so one MCP process can route
 * different tool calls to different OpenKnowledge project servers.
 *
 * See `packages/cli/src/mcp/server.ts` for the resolver wired in at startup.
 */
export type ServerUrlOrResolver =
  | string
  | undefined
  | ((cwd?: string) => Promise<string | undefined>);

/**
 * Normalize a `ServerUrlOrResolver` to a concrete URL (or `undefined` when the
 * server is not reachable). Call this at the top of every tool handler that
 * hits the Hocuspocus HTTP API. Exported for handlers that need the raw
 * resolver error rather than the flattened `resolveProjectServerContext`
 * shape (`preview_url` branches on the error's type).
 */
export async function resolveServerUrl(
  x: ServerUrlOrResolver,
  cwd?: string,
): Promise<string | undefined> {
  return typeof x === 'function' ? await x(cwd) : x;
}

/** Normalize a `ConfigOrResolver` to a concrete config for the current cwd. */
async function resolveConfig(x: ConfigOrResolver, cwd?: string): Promise<Config> {
  return typeof x === 'function' ? await x(cwd) : x;
}

/** Resolve the effective project cwd plus the matching config for this call. */
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
  // `cwd` is the project root: `resolveCwd` walks UP from the passed path to the
  // enclosing `.ok/config.yml`, and that root anchors config, server URL, lock
  // dir, and content addressing for every tool. `executionCwd` is the literal
  // path the caller passed, before the walk-up — the directory a command should
  // actually run in. The two diverge only when the caller targets a
  // subdirectory of the project; `executionCwd` is then a descendant of `cwd`
  // (the walk-up started from it). Only `exec` consumes `executionCwd`; the
  // doc-keyed tools address content server-side and need just the root.
  const executionCwd = explicitCwd !== undefined ? resolve(explicitCwd) : cwd;
  try {
    const resolvedConfig = await resolveConfig(config, cwd);
    return { ok: true, cwd, executionCwd, config: resolvedConfig };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the effective project cwd/config for this tool call, then resolve
 * the matching project server URL. Returns a structured error instead of
 * throwing so tool handlers can surface config-load or auto-start failures as
 * normal tool errors.
 *
 * Handlers that need typed error discrimination (e.g. `AutoStartDisabledError`)
 * should call `resolveServerUrl` directly instead — this wrapper flattens the
 * error to a string. Reference pattern: `get-preview-url.ts`.
 */
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

/**
 * Normalize a user-supplied `docName`. The server keys documents by the
 * extension-less docName, so a caller that passes `"notes/meeting.md"` would
 * otherwise produce `meeting.md.md`. The server auto-detects the extension
 * (`.md` vs `.mdx`) from what it finds on disk.
 *
 * Policy:
 * - Trailing `.md` / `.mdx` is stripped silently (case-insensitive). Repeated
 *   supported extensions collapse fully — `foo.md.md` → `foo` — so a single
 *   strip can't leave an embedded `.md` in the key that the create would turn
 *   into a doubled `foo.md.md` on disk.
 * - Trailing `.markdown` returns an error — unsupported extension.
 * - Any other trailing `.x` is left alone; a dotted docName is valid
 *   (e.g. `releases/v1.0`).
 * - The extension-less result is then checked against the structural docName
 *   contract (`validateDocName`): empty / blank, leading-or-trailing
 *   whitespace, control characters, path traversal, empty or hidden-dot path
 *   segments are rejected with a clear error rather than producing junk,
 *   hidden, or unaddressable files (or a 500 deep in the doc layer).
 *
 * Note: this strips the extension for keying; the caller's explicit suffix is
 * recovered separately. On a create, `write` forwards an explicit
 * `.mdx` (or `.md`) to the server so the new file lands with that extension;
 * for an existing doc the recorded on-disk extension wins.
 */
/**
 * A `document` write/edit aimed at a reserved `.ok/` path is almost always an
 * agent reaching for the wrong target — skills, templates, and folder config
 * are authored via their own targets, never as a raw document under `.ok/`.
 * Map the rejected path to a path-aware teaching redirect so the agent retries
 * with the right shape instead of fighting the generic hidden-file rejection
 * (and falling back to native file tools — the real failure this prevents).
 * Returns null for non-`.ok/` paths so the normal docName error stands.
 */
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
  // Strip EVERY trailing supported extension, not just one. A single strip
  // turned `foo.md.md` into the key `foo.md`, which the create then wrote to
  // disk as `foo.md.md` (the embedded `.md` survived). Loop until no supported
  // extension remains so `foo.md.md` → `foo` (and `foo.mdx.md` → `foo`). A
  // `.mdx` suffix never matches the `.md` check (it ends in `x`), so the two
  // branches stay mutually exclusive per iteration.
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
function normalizeResponse(res: Response, body: unknown): { ok: boolean; [key: string]: unknown } {
  // 2xx success path takes precedence over body-shape inspection.
  // `res.ok` is the wire-level success/error discriminator; the
  // problem+json shape and the non-object reject are only consulted on
  // 4xx/5xx. Two shapes are admitted on 2xx:
  //   - Object body: spread its fields onto the canonical record after
  //     stripping a stray `ok` (boundary defense against an intermediary
  //     that wraps a 2xx response with `{ok: false, ...}` — without the
  //     strip the body's `ok` would win the spread).
  //   - Array / null / primitive body: surface under a `data` field so
  //     a future list-all endpoint returning `[…]` reaches consumers as
  //     `result.data`. No destructuring on non-records — that produced
  //     `{0: item, 1: item, ..., length: N}` wire garbage in the prior
  //     order and the `null` body would have been misclassified as a
  //     non-object error.
  if (res.ok) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: true, data: body };
    }
    const { ok: _ok, ...rest } = body as Record<string, unknown>;
    return { ok: true, ...rest };
  }
  // 4xx/5xx with non-object body: nothing structured to canonicalize.
  // Surface the HTTP status as a generic error string.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: `Server returned HTTP ${res.status} with non-object body`,
    };
  }
  const record = body as Record<string, unknown>;
  // RFC 9457 problem+json detection by field heuristic
  // (`type`+`title` strings). Per §3, `Content-Type:
  // application/problem+json` is the canonical signal, but consulting it
  // adds no information to extraction logic: when both header and fields
  // agree we extract; when only the header is set but fields are missing
  // (malformed problem+json — server bug), extraction would produce
  // `error: undefined` so we MUST fall through to generic-passthrough
  // anyway. The field check is the load-bearing one. Intermediaries that
  // strip headers but pass through bodies are also covered.
  //
  // Surface `title` as `error` (the human-readable diagnostic), pass
  // through `type` (the closed `ProblemType` URN — RFC 9457 §4
  // programmatic-dispatch handle for consumers that want to branch on
  // the kind of error rather than parse `title` strings), preserve
  // `instance` (correlation ID — grep handle between HTTP response and
  // Pino log) and `detail`, and spread extensions (e.g. `colliding`)
  // so structured fields remain accessible. Spread extensions FIRST so
  // canonical fields (`ok`/`error`/`type`/`instance`/`detail`) win on
  // key collision — RFC 9457 §3.2 doesn't reserve those names so a
  // future server extension named `ok` or `error` would otherwise
  // silently override the canonicalizer's contract.
  if (typeof record.type === 'string' && typeof record.title === 'string') {
    const { type, title, status, instance, detail, ...extensions } = record;
    return {
      ...extensions,
      ok: false,
      error: title,
      type,
      // Preserve `status` for retry-class branching by SDK + MCP-tool consumers
      // (4xx → fix-and-retry; 5xx → backoff-retry). Information destruction at
      // the canonicalizer is the wrong default — `type` is the load-bearing
      // handle for branching by error class, but `status` is the load-bearing
      // handle for retry strategy. Cost is ~10 bytes per error response.
      ...(typeof status === 'number' ? { status } : {}),
      ...(typeof instance === 'string' ? { instance } : {}),
      ...(typeof detail === 'string' ? { detail } : {}),
    };
  }
  // 4xx/5xx with non-RFC-9457 body (rare — test mocks or a non-server
  // intermediary like a reverse proxy). Preserve whatever the body
  // carries, force `ok: false`, AND guarantee an `error` string is
  // present so MCP-tool consumers that do `'Error: ' + result.error`
  // never surface `'Error: undefined'` on these intermediary responses.
  // Source priority: body's own `error` → body's `message` (common
  // alt-name for proxy/upstream error shapes) → generic HTTP-status
  // sentence. The canonicalizer doesn't invent diagnostic content the
  // body didn't carry — every fallback comes from somewhere the
  // intermediary wrote.
  const { ok: _ok, error: bodyError, ...rest } = record;
  const fallbackError =
    typeof bodyError === 'string'
      ? bodyError
      : typeof record.message === 'string'
        ? record.message
        : `Server returned HTTP ${res.status}`;
  return { ...rest, ok: false, error: fallbackError };
}

/**
 * HTTP GET helper for Hocuspocus API calls.
 * Returns `{ ok: false, error }` on network failure or non-JSON response.
 * Translates RFC 9457 problem+json + flat-success bodies into the
 * `{ ok, ...payload }` shape MCP-tool consumers expect — see
 * `normalizeResponse` above.
 */
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
    // 2xx-non-JSON on a JSON shim is always a contract violation, not a
    // success. Surface as `ok: false` so the consumer's existing
    // `if (!result.ok) return textResult(...)` guard catches it and
    // surfaces the diagnostic to the user. The earlier `ok: true,
    // warning: ...` shape produced silent-failure UX: consumers fell
    // through the `!result.ok` guard, then `data.documents` was
    // undefined, then `(data.documents ?? []).map(...)` produced an
    // empty list with no error indication.
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
  // `httpStatus` is the wire-level HTTP status (distinct from any body-derived
  // `status` field). Dedicated key so callers can distinguish a clean 404 from
  // a transient 5xx/timeout — load-bearing for the cross-scope-move collision
  // guard, which must NOT treat a transient destination-read failure as "free".
  // The network-error catch above has no Response, so it omits httpStatus.
  return { ...normalizeResponse(res, body), httpStatus: res.status };
}

/**
 * Shared HTTP helper for mutating Hocuspocus API calls (POST / PUT / DELETE).
 * Returns `{ ok: false, error }` on network failure or non-JSON response.
 * Translates RFC 9457 problem+json + flat-success bodies into the
 * `{ ok, ...payload }` shape MCP-tool consumers expect — see
 * `normalizeResponse` above. DELETE callers pass the query string in `path`
 * and omit `body`.
 */
async function httpSend(
  method: 'POST' | 'PUT' | 'DELETE',
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  // Pre-stringify with a typed fallback so an unserializable body (circular
  // ref, BigInt, Error cause-chain cycle) doesn't crash the MCP tool process
  // mid-fetch. Mirrors successResponse's pre-stringify guard precedent.
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
    // See httpGet — 2xx-non-JSON on a JSON shim is a contract violation,
    // surfaced as `ok: false` so the consumer's `!result.ok` guard
    // catches it. Symmetric branch.
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

/**
 * Structured collision pair returned by `POST /api/rename-path` when two
 * affected docs would resolve to the same destination. The `move` tool
 * surfaces this in its error response so callers can render the offending
 * pairs without re-parsing the human-readable error message.
 */
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
