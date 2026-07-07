import { z } from 'zod';
import { DEFAULT_ATTACHMENT_FOLDER_PATH } from '../constants/upload.ts';
import { fieldRegistry } from './field-registry.ts';

// Credential attribute key denylist for the local telemetry file sink. The
// `ScrubbingSpanProcessor` reads the resolved `telemetry.localSink.attributeDenylist`
// at runtime, which defaults to this list (see the `.default(...)` chain below).
// Exported so the resolver and bundle collector consume the same source — the
// cascade fallback would otherwise diverge silently if a maintainer bumped the
// schema default without touching every caller.
export const DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST: readonly string[] = Object.freeze([
  'authorization',
  'auth.token',
  'auth.bearer',
  'cookie',
  'set-cookie',
  'x-api-key',
  'password',
  'secret',
]);

export const DEFAULT_SPANS_MAX_BYTES = 52_428_800;
export const DEFAULT_LOGS_MAX_BYTES = 26_214_400;

// Non-secret embeddings-provider defaults. Shared with the server so the live
// layered config read and the schema `.default()` below cannot drift. The API
// key is NEVER a config value — it lives only in the OS keyring.
export const DEFAULT_EMBEDDINGS_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';

export function normalizeAttachmentFolderPath(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? DEFAULT_ATTACHMENT_FOLDER_PATH : trimmed;
}

export function isValidAttachmentFolderPath(value: string): boolean {
  const normalized = normalizeAttachmentFolderPath(value);
  if (normalized.includes('\0')) return false;
  if (normalized.includes('\\')) return false;
  // The exact '/' sentinel means "content root" — the only allowed absolute path.
  if (normalized === '/') return true;
  if (normalized.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) return false;
  return true;
}

export const ConfigSchema = z.looseObject({
  // `content.dir` is PROJECT-scope — names the root of the project's
  // knowledge graph. `content.include` / `content.exclude` were removed:
  // path rules now live in `.okignore` files (gitignore syntax) at the
  // project root and at any folder depth. The YAML loader rejects the
  // removed keys with a source-located REMOVED_KEY error directing the
  // user to `.okignore`.
  //
  // `content.attachmentFolderPath` is PROJECT-scope — where pasted and
  // editor-dropped assets land relative to the content root. Default './'
  // preserves the historical colocated-with-doc behavior; the exact '/'
  // sentinel means the content root itself.
  content: z
    .looseObject({
      dir: z
        .string()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          defaultScope: 'project',
          description:
            'Folder OpenKnowledge reads and writes documents under, relative to the project root (the folder that contains .ok/). Defaults to the project root. Exclude paths with .okignore.',
        })
        .default('.'),
      attachmentFolderPath: z
        .string()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          defaultScope: 'project',
          description:
            "Where pasted and dropped assets are stored, relative to the content root. './' colocates beside the current document (default); '/' targets the content root; './subdir' targets a subfolder under the current document folder; 'folder' targets a fixed folder under the content root. Whitespace-only values are treated as './'.",
        })
        // Field metadata still resolves through this validation wrapper.
        .refine(isValidAttachmentFolderPath, {
          message:
            "Invalid attachment folder path: must not contain '..' segments, NUL bytes, backslashes, or OS absolute paths (use '/' for the content root).",
        })
        .default(DEFAULT_ATTACHMENT_FOLDER_PATH),
    })
    .default({
      dir: '.',
      attachmentFolderPath: DEFAULT_ATTACHMENT_FOLDER_PATH,
    }),
  // `preview.*` is no longer a schema section. The code-block preview iframe
  // now runs a fixed open network CSP (see the app's `preview-iframe-header.ts`),
  // so there is no `preview.networkPolicy` / `preview.scriptSrc` to configure;
  // `preview.baseUrl` (deployed-wiki URL) was likewise removed — the
  // `preview-url` MCP resolver collapses to electron-protocol → lock. All are in
  // REMOVED_KEYS so a stale `preview.*` key is rejected loudly, never a silent
  // no-op. A future multi-tenant deployment that needs to lock the preview
  // network down will reintroduce an operator-level control (an env / build flag
  // the tenant can't edit), not a content-editable config field.
  //
  // `folders` is not a top-level field. A folder's own frontmatter lives in
  // nested `<folder>/.ok/frontmatter.yml` files — sparse, opt-in, lazy-create
  // (open-shape, exactly like a doc's). Edit via the `write` / `edit` MCP verbs
  // (folder target) or by hand.
  //
  // `github.oauthAppClientId`, `server.host`, `server.openOnAgentEdit`,
  // `mcp.autoStart`, `mcp.tools.read_document.historyDepth`,
  // `mcp.tools.grep.maxResults` (formerly `mcp.tools.search.maxResults`
  // before the search→grep rename), and
  // `appearance.editorModeDefault` were removed — none were actually
  // user-configurable in practice (or in the case of editorModeDefault,
  // never read at all; new docs always open in WYSIWYG and users toggle
  // mode via the editor mode button). Their values now live as
  // constants in `packages/core/src/constants/{github,server,mcp}.ts`,
  // or are simply hardcoded behavior. Loose-mode silently passes any
  // stale keys through schema validation.
  //
  // `appearance.theme` defaults to UNSET in config.yml (no `'system'`
  // default). The chrome FOUC scripts read localStorage as the cache;
  // the first explicit Settings-pane write of `appearance.theme`
  // canonicalizes the value into config.yml.
  //
  // USER-scope: theme is a personal preference, not a project-shared
  // setting. A project `appearance.theme` would force every
  // collaborator into the project owner's mode, which is a misuse
  // pattern and not what users expect from the chrome toggle.
  // SchemaStore validation flags it in project YAML; chrome toggle
  // always writes via `userBinding.patch()`.
  // `appearance.sidebar.showHiddenFiles` is a per-machine, per-project
  // visibility toggle. Project scope would
  // bleed one teammate's "show hidden files" choice across collaborators via
  // git; user scope would force a single global setting for every OK
  // project. `project-local` (gitignored `<projectDir>/.ok/local/config.yml`)
  // is the only correct home — each teammate chooses independently for
  // their machine.
  //
  // `appearance.preview.autoOpen` is USER-scope: whether the agent
  // auto-opens or refreshes the OK preview UI on edits is a personal
  // workflow preference (multi-monitor setups, browser-extension
  // dependents, accessibility flows where the user manages their own
  // view). Default `true` preserves the capability-based routing
  // behavior — when false, the agent honors `response.autoOpen` from
  // every preview-related tool call and leaves the user's existing
  // view alone. (This is a per-user UX choice — unrelated to the preview
  // iframe's network CSP, which is no longer configurable; see the `preview.*`
  // note above.)
  appearance: z
    .looseObject({
      theme: z
        .enum(['light', 'dark', 'system'])
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          defaultScope: 'user',
          description:
            "Editor color theme: 'light', 'dark', or 'system' (follow the OS). A personal preference (user scope) — not shared with the project.",
        })
        .optional(),
      preview: z
        .looseObject({
          autoOpen: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'user',
              agentSettable: false,
              defaultScope: 'user',
              description:
                'When on, the agent opens or refreshes the live preview after each edit. Turn off if you manage your own preview window. A personal preference (user scope).',
            })
            .default(true),
        })
        .default({ autoOpen: true }),
      sidebar: z
        .looseObject({
          showHiddenFiles: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              defaultScope: 'project-local',
              description:
                'Show dot-prefixed entries (e.g. .ok/, .okignore) in the file tree. Per-machine (project-local) — not shared with collaborators.',
            })
            .default(false),
        })
        .optional(),
    })
    .default({ preview: { autoOpen: true } }),
  // USER-scope: source-editor word wrap is a personal reading/editing
  // preference, not project content. Default true preserves the historical
  // CodeMirror behavior until a user explicitly disables it.
  editor: z
    .looseObject({
      wordWrap: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          defaultScope: 'user',
          description:
            'Soft-wrap long lines in the source (CodeMirror) editor. A personal preference (user scope).',
        })
        .default(true),
    })
    .default({ wordWrap: true }),
  // `autoSync.enabled` is a per-machine, per-project preference: each
  // teammate decides independently whether their machine should auto-pull /
  // auto-push commits for *this* project. Project scope would bleed across
  // teammates via git; user scope would force one global toggle for every
  // OK project. The new `'project-local'` layer at
  // `<projectDir>/.ok/local/config.yml` (gitignored) is the only correct
  // home. SettingsPane SyncSection, the SyncStatusBadge popover Switch, and
  // the AutoSyncOnboardingDialog all write here via the project-local
  // binding — no special HTTP endpoint.
  //
  // `null` is the canonical "unanswered" sentinel: the onboarding modal
  // gates on `enabled === null`, distinguishing "user has not chosen" from
  // `true` / `false` (chosen). `looseObject` is retained so legacy
  // `onboardingResolvedAt` keys still on disk parse without error.
  autoSync: z
    .looseObject({
      enabled: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          defaultScope: 'project-local',
          description:
            'Whether this machine auto-pulls and auto-pushes git commits for this project. null = not chosen yet (onboarding asks). Per-machine (project-local) — not shared.',
        })
        .nullable()
        .default(null),
      // `autoSync.default` is the COMMITTED (project-scope) seed for a
      // machine's `autoSync.enabled` on first open: `true` = default auto-sync
      // on, `false` = default off, `null` = ask (show the onboarding modal). It
      // travels with the repo via git so a maintainer can pre-answer the prompt
      // for everyone who clones the project. It is a soft default — a
      // per-machine `autoSync.enabled` (above) always overrides it, in both the
      // server's `readProjectAutoSyncEnabled` resolution and the onboarding
      // gate. Sharing `enabled`'s `boolean | null` value space is deliberate:
      // `null` reuses the same "unanswered → ask" sentinel; the only difference
      // between the two leaves is scope (committed vs per-machine).
      default: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          defaultScope: 'project',
          description:
            "Committed project default for a machine's autoSync.enabled on first open: true = auto-sync on, false = off, null = ask (show the onboarding prompt). Shared via git. A per-machine autoSync.enabled choice overrides it.",
        })
        .nullable()
        .default(null),
    })
    .default({ enabled: null, default: null }),
  // `terminal.enabled` is the per-project, per-machine opt-out for the in-app
  // terminal's real OS shell. The terminal is available by default; only an
  // explicit `false` disables it (`null`/absent both read as the default-on
  // state). Enabling a real shell is a full-privilege capability, but OK Desktop
  // is a local-first app the user installed and launched themselves and the
  // embedded shell runs at the same privilege as the app process they already
  // trust, so the default is on and the opt-out exists for locked-down setups.
  //
  // The opt-out is per-machine: project scope would let one teammate's choice
  // cross the git boundary to collaborators; user scope would span every project
  // at once. The gitignored `project-local` layer at
  // `<projectDir>/.ok/local/config.yml` is the only correct home — the opt-out is
  // never inherited via a clone, sync, or share.
  //
  // `agentSettable: false` keeps the shell human-only: an agent can neither opt
  // out (silencing a human who wants the terminal) nor re-enable one a human
  // turned off.
  terminal: z
    .looseObject({
      enabled: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          defaultScope: 'project-local',
          description:
            'Opt-out for the in-app terminal (a real OS shell at full user privilege). The terminal is on by default; set false to disable it for this project on this machine. Per-machine (project-local) — never shared via git, clone, or sync.',
        })
        .nullable()
        .default(null),
    })
    .default({ enabled: null }),
  // PROJECT-scope: the local telemetry file sink writes spans + logs to
  // `<contentDir>/.ok/local/{telemetry,logs}/*.jsonl` for `ok diagnose bundle`
  // to harvest. The data is local-only — it never leaves the machine until
  // the user explicitly runs `bundle`. Default-on follows the universal
  // production-tooling pattern (macOS DiagnosticReports, systemd journals,
  // Docker container logs); users with sensitive workspaces set
  // `enabled: false`. Independent of the OTLP push gate (`OTEL_SDK_DISABLED`).
  //
  // `attributeDenylist` is the credential key denylist enforced at write
  // time by the `ScrubbingSpanProcessor` — keys whose lowercase form matches
  // any entry have their values replaced with `[REDACTED]` before any file
  // exporter sees them. Extensible per project; the built-in default is
  // shared via `DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST`.
  telemetry: z
    .looseObject({
      localSink: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              defaultScope: 'project',
              description:
                'Write local diagnostic spans + logs under .ok/local/ for `ok diagnose bundle`. Local-only — never leaves the machine until you run bundle. Set false for sensitive workspaces. Shared across collaborators.',
            })
            .default(true),
          spans: z
            .looseObject({
              maxBytes: z
                .number()
                .register(fieldRegistry, {
                  scope: 'project',
                  agentSettable: false,
                  defaultScope: 'project',
                  description:
                    'Maximum size, in bytes, of the local diagnostic spans file before it rotates (default ~50 MB).',
                })
                .default(DEFAULT_SPANS_MAX_BYTES),
            })
            .default({ maxBytes: DEFAULT_SPANS_MAX_BYTES }),
          logs: z
            .looseObject({
              maxBytes: z
                .number()
                .register(fieldRegistry, {
                  scope: 'project',
                  agentSettable: false,
                  defaultScope: 'project',
                  description:
                    'Maximum size, in bytes, of the local diagnostic logs file before it rotates (default ~25 MB).',
                })
                .default(DEFAULT_LOGS_MAX_BYTES),
            })
            .default({ maxBytes: DEFAULT_LOGS_MAX_BYTES }),
          attributeDenylist: z
            .array(z.string())
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              defaultScope: 'project',
              description:
                'Telemetry attribute keys whose values are redacted before any local span/log is written (credential / secret guard). Extends the built-in denylist.',
            })
            .default([...DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST]),
        })
        .default({
          enabled: true,
          spans: { maxBytes: DEFAULT_SPANS_MAX_BYTES },
          logs: { maxBytes: DEFAULT_LOGS_MAX_BYTES },
          attributeDenylist: [...DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST],
        }),
    })
    .default({
      localSink: {
        enabled: true,
        spans: { maxBytes: DEFAULT_SPANS_MAX_BYTES },
        logs: { maxBytes: DEFAULT_LOGS_MAX_BYTES },
        attributeDenylist: [...DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST],
      },
    }),
  // PROJECT-LOCAL scope: semantic search is an additive embeddings signal fused
  // into the MCP `search` tool's lexical ranking. It is per-machine, not
  // project-shared, because enabling it sends content to a third-party
  // embeddings provider (egress) and needs an API key in the local OS keyring —
  // each teammate opts in deliberately for their own machine. Project scope
  // would force one teammate's egress choice across collaborators via git; user
  // scope would force it for every project. Default OFF — the feature ships dark.
  //
  // The non-secret provider knobs (baseUrl / model / dimensions) live here; the
  // API key NEVER does — it lives only in the OS keyring (`ok embeddings set-key`).
  search: z
    .looseObject({
      semantic: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              defaultScope: 'project-local',
              description:
                'Add semantic (embeddings) ranking to the MCP search tool, fused with the lexical engine so conceptually-related pages surface even with no shared keywords. When ON and an API key is set (`ok embeddings set-key`), the search query and matching document content are sent to the configured embeddings provider — content egress. Default OFF. Per-machine (project-local) — not shared with collaborators.',
            })
            .default(false),
          baseUrl: z
            .string()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              defaultScope: 'project-local',
              description:
                'Base URL of the OpenAI-compatible embeddings API (default https://api.openai.com/v1). Override for Azure / self-hosted / other providers. The API key is NOT stored here — set it with `ok embeddings set-key` (OS keyring).',
            })
            .default(DEFAULT_EMBEDDINGS_BASE_URL),
          model: z
            .string()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              defaultScope: 'project-local',
              description:
                'Embeddings model id (default text-embedding-3-small). Must be served by the provider at baseUrl. Changing it re-embeds the corpus (the cache is keyed by provider + model + dimensions).',
            })
            .default(DEFAULT_EMBEDDINGS_MODEL),
          dimensions: z
            .number()
            .int()
            .positive()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              defaultScope: 'project-local',
              description:
                "Optional output vector dimensions. Omit to use the model's native size (1536 for text-embedding-3-small). Set a smaller value (text-embedding-3 supports e.g. 512 / 1024) to shrink the on-disk cache, trading a little retrieval quality. Changing it re-embeds the corpus.",
            })
            .optional(),
          similarityFloor: z
            .number()
            .min(0)
            .max(1)
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              defaultScope: 'project-local',
              description:
                'Optional hard cutoff: drop any "by meaning" match whose cosine similarity is below this value. Off by default (0) because retrieval is rank-based (the closest pages are returned regardless of absolute score) and the right cutoff is model-specific. Set it only to suppress weak matches for a specific provider/model whose cosine scale you know. Most setups should leave it unset and rely on the result-count cap.',
            })
            .optional(),
        })
        .default({
          enabled: false,
          baseUrl: DEFAULT_EMBEDDINGS_BASE_URL,
          model: DEFAULT_EMBEDDINGS_MODEL,
        }),
    })
    .default({
      semantic: {
        enabled: false,
        baseUrl: DEFAULT_EMBEDDINGS_BASE_URL,
        model: DEFAULT_EMBEDDINGS_MODEL,
      },
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Deep-partial input shape for patch operations against `ConfigSchema`.
 *
 * Used by `writeConfigPatch` / `ConfigBinding.patch` callers (MCP tools,
 * Settings pane, CLI) to describe partial updates. Null at any path means
 * "clear this field" (RFC 7396 spirit, TypeScript-only — no wire format).
 */
export type ConfigPatch = DeepPartial<Config>;

type DeepPartial<T> =
  T extends Array<infer U>
    ? Array<U>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> | null }
      : T;
