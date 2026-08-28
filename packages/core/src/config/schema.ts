import { z } from 'zod';
import { DEFAULT_ATTACHMENT_FOLDER_PATH } from '../constants/upload.ts';
import { SUPPORTED_LOCALES } from '../i18n/locales.ts';
import { DEFAULT_LINKS_VALIDATION, LINKS_VALIDATION_SETTINGS } from '../markdown/lint/types.ts';
import { BASE16_SLOT_ROLES, BASE16_SLOTS } from '../theme/base16.ts';
import { THEME_ID_PATTERN, THEME_PLUGIN_IDS } from '../theme/theme-plugins.ts';
import {
  MAX_SYNC_INTERVAL_SECONDS,
  MIN_SYNC_INTERVAL_SECONDS,
  STORED_SYNC_ACTIVE_MODES,
  STORED_SYNC_MODES,
} from './auto-sync-mode.ts';
import { fieldRegistry } from './field-registry.ts';

/**
 * The sixteen `appearance.customTheme` slot fields. Built from the slot list so
 * the config surface can't drift from the format, and so each field's
 * description carries the slot's role rather than repeating "a hex string".
 */
function base16SlotFields() {
  return Object.fromEntries(
    BASE16_SLOTS.map((slot) => [
      slot,
      z
        .string()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description: `Custom theme: base16 ${slot} — ${BASE16_SLOT_ROLES[slot]}, as a #rrggbb hex string.`,
        })
        .optional(),
    ]),
  );
}

/**
 * The self-contained palettes, quoted for prose — every theme id except the two
 * that defer to something else (`default` → the light/dark mode, `custom` → the
 * user's own scheme). Derived so the palette-field descriptions can't fall
 * out of step with the registry the enums themselves come from.
 */
function namedThemeIds() {
  return THEME_PLUGIN_IDS.filter((id) => id !== 'default' && id !== 'custom')
    .map((id) => `'${id}'`)
    .join(', ');
}

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

// The loss-capture ring is a small, dedicated diagnostic sink (bridge
// loss-class events, content-free); ~12 MB/generation keeps its two-generation
// footprint bounded well under the span/log rings it must never compete with.
const DEFAULT_LOSS_CAPTURE_MAX_BYTES = 12_582_912;

// Non-secret embeddings-provider defaults. Shared with the server so the live
// layered config read and the schema `.default()` below cannot drift. The API
// key is NEVER a config value — it lives only in `~/.ok/secrets.yml` (0600).
export const DEFAULT_EMBEDDINGS_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';

/**
 * Loopback-only default bind: nothing off this machine can connect until
 * `server.bind` says otherwise (and `server.allowExternal` consents to it).
 */
export const DEFAULT_SERVER_BIND: readonly string[] = Object.freeze(['127.0.0.1']);

/**
 * Accepted `server.idleShutdown` duration strings: a positive integer with an
 * `s` / `m` / `h` unit (e.g. `90s`, `30m`, `2h`). `'off'` is the union's other
 * arm, not part of this pattern. Kept alongside the schema so the published
 * JSON schema's `pattern` and the runtime validator cannot drift.
 */
export const IDLE_SHUTDOWN_DURATION_RE = /^[1-9]\d*(s|m|h)$/;

/**
 * `server.externalUrl` scheme guard, paired with the runtime `z.url({ protocol })`
 * check. Zod's URL `protocol` option validates at runtime but does NOT
 * serialize through `z.toJSONSchema` (which emits only `format: "uri"`, a
 * scheme it would accept `ftp:`/`javascript:` under). Attaching this as a
 * `.regex()` makes the constraint round-trip as a JSON Schema `pattern`, so a
 * `$schema`-aware editor rejects a non-http(s) origin instead of green-lighting
 * one that fails at boot. Same round-trip technique as the idle-shutdown grammar.
 *
 * Module-local (not exported): unlike `IDLE_SHUTDOWN_DURATION_RE`, the resolver
 * has no need for it — the scheme constraint lives entirely in the schema leaf.
 */
const HTTP_URL_SCHEME_RE = /^https?:\/\//;

/**
 * The conventional fixed port for a tunneled/exposed deployment, offered as the
 * placeholder default in the Network Access settings pane when `server.port` is
 * unset. Not a zod `.default()` on `server.port` — a schema-baked default would
 * make "unset" (dynamic free-port selection for a local start) undetectable in a
 * parsed config.
 */
export const DEFAULT_TUNNEL_PORT = 24550;

/** Why an embeddings base URL is rejected: unparseable, or a plaintext scheme. */
export type EmbeddingsBaseUrlProblem = 'invalid-url' | 'insecure-scheme';

/**
 * Validate an embeddings base URL against the SAME rule the server enforces
 * before it will send the Bearer API key (`assertSafeEmbeddingsBaseUrl` in the
 * embedder): a parseable URL that is `https:`, or `http:` only for a loopback
 * host (a local dev gateway, where the key never leaves the machine). Returns
 * `null` when acceptable, else the problem. Shared so the app's inline
 * validation and the `ok embeddings set-url` CLI reject a guaranteed-to-fail
 * endpoint at entry instead of letting it surface later as a provider-rejected
 * status. Whitespace is the caller's to trim.
 */
/**
 * True when the URL targets the local machine's loopback interface. Checked on
 * the PARSED hostname (never a substring of the raw URL) so an attacker host
 * like `http://localhost.evil.com` or `http://127.0.0.1.evil.com` can't pass —
 * their `hostname` is the full foreign name, not `localhost`/`127.0.0.1`.
 * The single source of truth for "may be keyless" and "http:// is permitted":
 * a keyless or plaintext request is only ever allowed to a host that stays on
 * this machine. Non-URLs are not loopback.
 */
export function isLoopbackEmbeddingsUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  // `URL.hostname` returns IPv6 hosts bracketed (`[::1]`), never bare `::1`.
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function checkEmbeddingsBaseUrl(baseUrl: string): EmbeddingsBaseUrlProblem | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'invalid-url';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackEmbeddingsUrl(baseUrl)) return null;
  return 'insecure-scheme';
}

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
          // Boot-only: re-rooting the content dir live would re-root the whole
          // index (watcher, Y.Doc registry, link graph) under a running server.
          reload: 'boot',
          defaultScope: 'project',
          description:
            'Folder OpenKnowledge reads and writes documents under, relative to the project root (the folder that contains .ok/). Defaults to the project root. Exclude paths with .okignore. Read at server start; changing it requires a restart.',
        })
        .default('.'),
      attachmentFolderPath: z
        .string()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'live',
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
  // The `appearance.sidebar.*` VIEW TOGGLES are per-machine, per-project
  // (hidden files, only-markdown filter, Skills section, .ok reveal,
  // grouping). Project scope would bleed one teammate's view choice across
  // collaborators via git; user scope would force a single global setting
  // for every OK project. `project-local` (gitignored
  // `<projectDir>/.ok/local/config.yml`) is their home — each teammate
  // chooses independently for their machine.
  //
  // ONE deliberate exception lives in the same block: `pinnedGlobalSkills`
  // is USER scope, because a pin follows the SKILL's scope. Pinning a global
  // skill is a statement about your toolkit, which should travel to the next
  // project rather than be re-pinned there; its project-scope sibling
  // `pinnedProjectSkills` stays project-local like the toggles above. The
  // full rationale sits on the fields themselves.
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
          reload: 'live',
          defaultScope: 'user',
          description:
            "Editor color theme: 'light', 'dark', or 'system' (follow the OS). A personal preference (user scope) — not shared with the project.",
        })
        .optional(),
      // Stored UNRESOLVED: 'system' persists as 'system', never as whatever the
      // OS reported when it was picked — resolving before storing turns a
      // preference that follows the OS into one frozen to a single language.
      // USER-scope for the same reason as `theme`: a project value would force
      // one collaborator's reading language onto everyone. The tag list is
      // DERIVED from `SUPPORTED_LOCALES` (`packages/core/src/i18n/locales.ts`)
      // so a config value can never name a language with no catalog behind it.
      // Chrome only — document bodies, titles, filenames and frontmatter stay
      // in whatever language the user wrote them in.
      language: z
        .enum(['system', ...SUPPORTED_LOCALES])
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            "Interface language. 'system' follows the operating system. A personal preference (user scope) — not shared with the project, and never applied to document content.",
        })
        .optional(),
      // The IDE color palette layered on top of the light/dark `theme` mode
      // above. There is one palette per mode: `colorThemeLight` applies while
      // the resolved mode is light, `colorThemeDark` while it is dark, so the
      // palette follows the OS as `theme: 'system'` flips. `default` carries no
      // palette (the base stylesheet shows through); `custom` applies the user's
      // own `appearance.customTheme` scheme below; a built-in name selects a
      // bundled palette; any other id names a saved theme resolved at read time.
      // Any palette may sit in either slot — a dark scheme chosen as the
      // light-mode palette still forces its own variant, so the app renders it
      // dark. Personal preferences (user scope).
      //
      // These are shape-constrained strings (THEME_ID_PATTERN), NOT a closed
      // enum: an id the built-in registry doesn't know resolves to `default` for
      // that one slot rather than failing whole-config validation and discarding
      // every other user preference. The grammar is shared verbatim with the
      // FOUC pre-paint validator in `packages/app/index.html`, so config and
      // pre-paint can never disagree on what a valid id is.
      colorThemeLight: z
        .string()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description: `IDE color palette applied in light mode: 'default' (no palette), 'custom' (your own colors from appearance.customTheme), one of ${namedThemeIds()}, or the id of a saved theme. A short id of lowercase letters, digits, and hyphens (max 32 characters); an id no palette matches falls back to 'default' for this mode only, leaving the rest of your config untouched. A personal preference (user scope) — not shared with the project.`,
        })
        .regex(THEME_ID_PATTERN, {
          message:
            "Theme id must be lowercase letters, digits, and hyphens, 1–32 characters (e.g. 'dracula', 'custom', or a saved theme id).",
        })
        .optional(),
      colorThemeDark: z
        .string()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description: `IDE color palette applied in dark mode: 'default' (no palette), 'custom' (your own colors from appearance.customTheme), one of ${namedThemeIds()}, or the id of a saved theme. A short id of lowercase letters, digits, and hyphens (max 32 characters); an id no palette matches falls back to 'default' for this mode only, leaving the rest of your config untouched. A personal preference (user scope) — not shared with the project.`,
        })
        .regex(THEME_ID_PATTERN, {
          message:
            "Theme id must be lowercase letters, digits, and hyphens, 1–32 characters (e.g. 'dracula', 'custom', or a saved theme id).",
        })
        .optional(),
      // The single palette written before the light/dark pair existed. Read only
      // as the seed for BOTH slots when neither is set, so an older config keeps
      // rendering what it always did; the first pick in the Themes pane writes
      // the pair and retires this key. Opened to the same string shape as the
      // pair above: it too must tolerate a saved-theme id without invalidating
      // the whole config.
      colorTheme: z
        .string()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            "Superseded by appearance.colorThemeLight / appearance.colorThemeDark. Read as the palette for both modes while neither of those is set. A short theme id (lowercase letters, digits, and hyphens; max 32 characters); an id no palette matches falls back to 'default'. A personal preference (user scope) — not shared with the project.",
        })
        .regex(THEME_ID_PATTERN, {
          message:
            "Theme id must be lowercase letters, digits, and hyphens, 1–32 characters (e.g. 'dracula', 'custom', or a saved theme id).",
        })
        .optional(),
      // Whether the Themes plugin appears under Settings → Plugins. The theme is
      // a user-scope plugin (personal, not shared via git), toggled on the Plugins
      // management page like the lint plugins. Default on (absent → enabled).
      colorThemeEnabled: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            'Whether the Themes plugin appears in Settings → Plugins. A personal preference (user scope). Default on.',
        })
        .optional(),
      // The `custom` color theme's base16 scheme — the same sixteen-slot format
      // the built-ins are authored in, so a scheme copied from the base16
      // ecosystem can be pasted in and used as-is. Each slot is a `#rrggbb` hex
      // string; `variant` is auto-detected from the tonal ramp when absent.
      // Config written before base16 carried six semantic seed colors instead
      // (`background`/`surface`/`foreground`/`primary`/`accent`/`border`); the
      // object stays loose so that shape still parses, and the app upgrades it
      // on read (`resolveCustomScheme`). A personal preference (user scope).
      customTheme: z
        .looseObject({
          name: z
            .string()
            .register(fieldRegistry, {
              scope: 'user',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'user',
              description: "Custom theme: the scheme's display name.",
            })
            .optional(),
          author: z
            .string()
            .register(fieldRegistry, {
              scope: 'user',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'user',
              description:
                "Custom theme: the scheme's author credit, carried through from an imported base16 scheme.",
            })
            .optional(),
          variant: z
            .enum(['dark', 'light'])
            .register(fieldRegistry, {
              scope: 'user',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'user',
              description:
                "Custom theme: whether the scheme is 'dark' or 'light'. Auto-detected from the palette when omitted.",
            })
            .optional(),
          ...base16SlotFields(),
        })
        .optional(),
      preview: z
        .looseObject({
          autoOpen: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'user',
              agentSettable: false,
              reload: 'live',
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
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Show dot-prefixed entries (e.g. .ok/, .okignore) in the file tree. Per-machine (project-local) — not shared with collaborators.',
            })
            .default(false),
          showOnlyMarkdownFiles: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Show only markdown documents (.md/.mdx) and folders in the file tree, hiding other file types from view. View-only: hidden files stay on disk and remain reachable via links and search. Per-machine (project-local) — not shared with collaborators.',
            })
            .default(false),
          showSkillsSection: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Show the Skills section in the sidebar. Skill documents remain reachable via links and search while the section is hidden. Per-machine (project-local) — not shared with collaborators.',
            })
            .default(true),
          showOkFolders: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Show .ok folders (skills, templates, and other OpenKnowledge-managed state) in the file tree as read-only entries. .ok/worktrees and .ok/local never appear. Per-machine (project-local) — not shared with collaborators.',
            })
            .default(false),
          showSkillGroups: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Group skills in the sidebar by where they came from — the publisher they were imported from, or the plugin that ships them. Skills you authored stay ungrouped at the top of their scope. Per-machine (project-local) — not shared with collaborators.',
            })
            .default(true),
          // Two lists, not one, because pin scope follows SKILL scope: a project
          // pin is about this repo and stays with it, a global pin is about your
          // toolkit and should follow you into the next repo rather than being
          // re-pinned there. Skills are identified by NAME — the directory
          // basename is a skill's identity on every harness, and it survives a
          // re-import or a scope move that a path would not.
          pinnedProjectSkills: z
            .array(z.string())
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Project-scope skills pinned to the top of the Skills sidebar, by name. A pinned skill also keeps its normal row, so a provenance group still lists everything from its source. Per-machine (project-local) — not shared with collaborators.',
            })
            .default([]),
          pinnedGlobalSkills: z
            .array(z.string())
            .register(fieldRegistry, {
              scope: 'user',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'user',
              description:
                'Global-scope skills pinned to the top of the Skills sidebar, by name. Stored per USER rather than per project, so a pinned global skill follows you into every project.',
            })
            .default([]),
        })
        .optional(),
    })
    .default({ preview: { autoOpen: true } }),
  // USER-scope throughout: how someone reads and navigates their own editor is a
  // personal preference, not project content, so nothing in this group is
  // committed or agent-settable. Both leaves default true to preserve the
  // behavior each one replaced — CodeMirror's historical soft wrap, and the
  // single reused preview tab — so an existing install notices no change until
  // it opts out.
  editor: z
    .looseObject({
      wordWrap: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            'Soft-wrap long lines in the source (CodeMirror) editor. A personal preference (user scope).',
        })
        .default(true),
      previewTabs: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            'Reuse one tab when clicking through the Files and Skills sidebars, the way an editor preview tab works. Turn off to open every click in its own tab. Pinned tabs keep their own tab either way. A personal preference (user scope).',
        })
        .default(true),
    })
    .default({ wordWrap: true, previewTabs: true }),
  // USER-scope: auto-approve OpenKnowledge's OWN MCP tools (and, on Claude, the
  // `ok open` verb) for agents launched from the docked terminal, so the KB
  // read/write loop runs without a per-call approval wall. Destructive/exfil OK
  // tools stay gated (Claude deny-list); other shell + non-OK edits are
  // untouched. A per-machine personal preference (user scope); default on.
  //
  // Deliberate namespace: every sibling here names a feature area, `agents` names
  // the execution domain instead. Agent-facing policy is not the terminal's — the
  // deep-link GUI handoff dispatches the same agents to the same tools and will
  // reuse this leaf, so `terminal.*` would have been the wrong home the moment
  // that lands. Keys under `agents.*` are the user's cross-surface agent policy;
  // config paths are a user-facing `~/.ok/global.yml` contract and hard to rename.
  agents: z
    .looseObject({
      autoApproveOkTools: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            "Auto-approve OpenKnowledge's own tools (and `ok open` on Claude) for agents launched from the built-in terminal. Destructive tools (delete/move/share/install) still prompt. Per-machine personal preference (user scope).",
        })
        .default(true),
    })
    .default({ autoApproveOkTools: true }),
  // `autoSync.mode` is a per-machine, per-project preference: each teammate
  // decides independently whether their machine syncs *this* project, and in
  // which direction. Project scope would bleed across teammates via git; user
  // scope would force one global choice for every OK project. The
  // `'project-local'` layer at `<projectDir>/.ok/local/config.yml` (gitignored)
  // is the only correct home. SettingsPane SyncSection, the SyncStatusBadge
  // popover, and the AutoSyncOnboardingDialog all write here via the
  // project-local binding — no special HTTP endpoint.
  //
  // `mode` is the single knob the engine reads to decide whether to push ON A
  // SCHEDULE: only `'full'` schedules pushes, so a follower's machine never
  // publishes commits the user did not ask it to. It is NOT a capability gate —
  // the explicit Push action runs in every mode, including `'off'`, because a
  // button the user pressed is itself the consent this key exists to secure.
  // Read the field `description` below as the user-facing contract; the two must
  // not drift. It supersedes the legacy `enabled` boolean, which stays readable for configs
  // written before `mode` existed — `resolveLocalAutoSyncMode` derives a mode
  // from `enabled` when no `mode` key is present, so the two shapes coexist with
  // no migration.
  //
  // `null` is the canonical "unanswered" sentinel: the onboarding modal gates on
  // the resolved mode being `null`, distinguishing "user has not chosen" from a
  // chosen mode. `looseObject` is retained so legacy keys (e.g.
  // `onboardingResolvedAt`) and a newer version's extra keys still round-trip.
  autoSync: z
    .looseObject({
      mode: z
        .enum(STORED_SYNC_MODES)
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            "What this machine syncs on a schedule for this project: 'off' (Manual — nothing scheduled; the manual pull/push actions still work), 'follow' (Auto, pull only — scheduled pulls, never a scheduled push; 'pull' is accepted as a legacy alias), or 'full' (Auto, pull and push — bidirectional). Explicit user-triggered pushes work in every mode. null = not chosen yet (onboarding asks). Per-machine (project-local) — not shared. Supersedes the legacy autoSync.enabled boolean.",
        })
        .nullable()
        .default(null),
      // Legacy per-machine toggle, superseded by `autoSync.mode`. Read only when
      // `mode` is absent (`true` → full, `false` → off); new writes set `mode`.
      enabled: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            'Legacy per-machine sync toggle, superseded by autoSync.mode. Read only when mode is absent (true = full, false = off). null = not chosen yet. Per-machine (project-local) — not shared.',
        })
        .nullable()
        .default(null),
      // `autoSync.resumeMode` is per-machine UI memory: when sync is paused
      // (`mode: 'off'`) after having been enabled, it records which active mode
      // to resume into (and doubles as the "was enabled, now paused" signal that
      // keeps the badge visible and the manual Sync action available). Storing
      // paused as `mode: 'off'` keeps an older app — which ignores this key —
      // reading the project as not-syncing, so pausing never lets a stale reader
      // push. Meaningful only while `mode` is `off`; ignored otherwise.
      resumeMode: z
        .enum(STORED_SYNC_ACTIVE_MODES)
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            "When sync is paused (autoSync.mode 'off') after having been enabled, the active mode to resume into ('follow' | 'full'). Per-machine UI memory; ignored while a mode is active. Not shared.",
        })
        .optional(),
      // `autoSync.{pull,push}IntervalSeconds` are the per-machine cadence for
      // the scheduled cycles. Project-local for the same reason `mode` is: how
      // hard THIS machine polls is a property of this machine's network and
      // this person's tolerance for commit noise, not something to push at
      // teammates through git.
      //
      // Absent means "use the shipped default" rather than carrying the number
      // in every config, so the defaults stay changeable in one place.
      //
      // `.catch(undefined)` is load-bearing, not decoration. `readConfigSafely`
      // degrades the ENTIRE layer to schema defaults on any parse failure, and
      // `autoSync.mode` lives in this same layer — so a hand-edited
      // `pullIntervalSeconds: 15` would drop the user's `mode: 'off'` and fall
      // through to the committed `autoSync.default`. On a project whose
      // maintainer committed `full`, that silently converts an explicit Manual
      // choice into automated commits. It would also reject every later
      // project-local Settings write, since the bad value stays in the merged
      // doc. Per-leaf catch keeps the blast radius on the leaf, and
      // `resolveAutoSyncIntervals` supplies the default.
      //
      // Pull and push are separate knobs because their costs differ in kind: a
      // pull is a read (polling faster only buys freshness) while a push
      // authors a commit in shared history (polling faster buys noise).
      pullIntervalSeconds: z
        .number()
        .int()
        .min(MIN_SYNC_INTERVAL_SECONDS)
        .max(MAX_SYNC_INTERVAL_SECONDS)
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            'Seconds between scheduled pulls while autoSync.mode is follow or full (default 30). An unauthenticated follower is additionally floored to the anonymous poll minimum, so a lower value there has no effect. Per-machine (project-local) — not shared.',
        })
        .optional()
        .catch(undefined),
      pushIntervalSeconds: z
        .number()
        .int()
        .min(MIN_SYNC_INTERVAL_SECONDS)
        .max(MAX_SYNC_INTERVAL_SECONDS)
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            "Seconds between scheduled pushes while autoSync.mode is full (default 60). Ignored in every other mode, which never pushes on a schedule. Each cycle with pending edits authors a commit, so a shorter interval means more, smaller commits in the repo's shared history. Per-machine (project-local) — not shared.",
        })
        .optional()
        .catch(undefined),
      // `autoSync.default` is the COMMITTED (project-scope) seed for a machine's
      // sync mode on first open. It travels with the repo via git so a
      // maintainer can pre-answer the prompt for everyone who clones the
      // project. It is a soft default — a per-machine choice always overrides
      // it, in both the server's `readProjectAutoSyncMode` resolution and the
      // onboarding gate. The value space is the mode vocabulary plus the legacy
      // boolean seed (`true` → full, `false` → off) so committed `default: true`
      // configs keep working; `null` reuses the "unanswered → ask" sentinel.
      default: z
        .union([z.boolean(), z.enum(STORED_SYNC_MODES)])
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project',
          description:
            "Committed project default for a machine's sync mode on first open: 'off' | 'follow' | 'full', or the legacy boolean (true = full, false = off). null = ask (show the onboarding prompt). Shared via git. A per-machine autoSync.mode choice overrides it.",
        })
        .nullable()
        .default(null),
    })
    .default({ mode: null, enabled: null, default: null }),
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
          reload: 'live',
          defaultScope: 'project-local',
          description:
            'Opt-out for the in-app terminal (a real OS shell at full user privilege). The terminal is on by default; set false to disable it for this project on this machine. Per-machine (project-local) — never shared via git, clone, or sync.',
        })
        .nullable()
        .default(null),
    })
    .default({ enabled: null }),
  // USER-scope: whether the Slides plugin is offered is a personal preference,
  // not project content — the same posture as the Themes plugin toggle
  // (appearance.colorThemeEnabled). A document opts into the deck view with
  // `slides: true` in its own frontmatter; this leaf only gates whether that
  // affordance appears at all, and only on desktop, where a Slidev process can
  // be spawned. Default off, so a user who never enables it sees nothing and
  // pays nothing.
  slides: z
    .looseObject({
      enabled: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            'Whether the Slides plugin appears in Settings → Plugins. When on, a document whose frontmatter has `slides: true` offers an action that opens the deck in a dedicated window (desktop only, requires a resolvable slidev). A personal preference (user scope). Default off.',
        })
        .default(false),
    })
    .default({ enabled: false }),
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
              reload: 'live',
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
                  reload: 'live',
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
                  reload: 'live',
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
              reload: 'live',
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
      // The ONLY key under `telemetry` that leaves the machine — every sibling
      // above is a local sink. Named as its own leaf rather than folded into
      // `localSink` precisely so the outbound posture can't be mistaken for the
      // local-only one. USER scope: a project must not be able to decide that
      // its collaborators' machines phone a third party.
      skillInstallReports: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'user',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'user',
              description:
                'Report skill installs to skills.sh so a published skill shows an accurate install count. Sends the skill name, its source repo, and which agent tools it was installed for — never file contents, and never for a private or local source. One report per skill per machine. Default on; the DO_NOT_TRACK and DISABLE_TELEMETRY environment variables also turn it off.',
            })
            .default(true),
        })
        .default({ enabled: true }),
    })
    .default({
      localSink: {
        enabled: true,
        spans: { maxBytes: DEFAULT_SPANS_MAX_BYTES },
        logs: { maxBytes: DEFAULT_LOGS_MAX_BYTES },
        attributeDenylist: [...DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST],
      },
      skillInstallReports: { enabled: true },
    }),
  // PROJECT-scope: the loss-capture ring records bridge loss-class events
  // (deferred re-derives, tripped detectors/backstops, written recovery
  // checkpoints) content-free under `<contentDir>/.ok/local/loss-capture/` for
  // `ok diagnose bundle` to harvest. Same posture as the telemetry sink:
  // local-only until the user runs bundle, default-on following the universal
  // production-tooling pattern, and a project-shared decision (a sensitive
  // workspace opts the whole team out). It is a distinct ring from the OTel
  // span/log sink above — its own file, its own smaller cap — so a burst of
  // loss events never rotates diagnostic logs out from under the user.
  lossCapture: z
    .looseObject({
      enabled: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project',
          description:
            'Record bridge loss-class events (content-free) under .ok/local/loss-capture/ for `ok diagnose bundle`. Local-only — never leaves the machine until you run bundle. Set false for sensitive workspaces. Shared across collaborators.',
        })
        .default(true),
      maxBytes: z
        .number()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project',
          description:
            'Maximum size, in bytes, of the local loss-capture file before it rotates (default ~12 MB).',
        })
        .default(DEFAULT_LOSS_CAPTURE_MAX_BYTES),
    })
    .default({
      enabled: true,
      maxBytes: DEFAULT_LOSS_CAPTURE_MAX_BYTES,
    }),
  // PROJECT-scope: kill-switches for the bridge loss-hardening mechanisms.
  // Mostly server-side, but not exclusively — `backgroundThrottle` gates the
  // desktop main process and `flushOnHide` the renderer, so the sub-tree is
  // "the bridge loss-hardening family", not "the server". Each defaults ON (the
  // mechanisms are the loss-prevention guarantee) and exists as a
  // support-visible field escape — a sensitive or regression-hit workspace can
  // disable one without a code change. Project scope because the bridge is
  // server-authoritative: the whole project shares one server, so a per-machine
  // toggle would not be honored.
  bridge: z
    .looseObject({
      backgroundThrottle: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                "Keep the desktop window's timers running at full rate while it holds unsynced work, so backgrounding the app never starves sync or recovery; when the window is idle the OS-default background throttling is restored (battery). Honored by the desktop app. Default ON — disable only to isolate a suspected regression.",
            })
            .default(true),
        })
        .default({ enabled: true }),
      deferGuard: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Defer a drain-shaped Observer B re-derive when the WYSIWYG fragment holds an un-propagated keystroke Y.Text lacks, so the keystroke survives instead of being stomped. Default ON — disable only to isolate a suspected regression.',
            })
            .default(true),
        })
        .default({ enabled: true }),
      lossDetector: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Detect content the bridge silently dropped at its reconciliation boundary (an Observer-A apply arm or a paired agent-undo derive) and write a recovery checkpoint plus a content-free loss event. Detection only — never blocks a write. Default ON — disable only to isolate a suspected regression.',
            })
            .default(true),
        })
        .default({ enabled: true }),
      fixedPoint: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Bound the Y.Text→WYSIWYG re-derive loop with a drain-count backstop: a run of re-derive drains that never reaches a raw-byte fixed point freezes the re-derive loop and writes a recovery checkpoint plus a content-free loss event, instead of churning unbounded. Default ON — disable only to isolate a suspected regression.',
            })
            .default(true),
        })
        .default({ enabled: true }),
      preDrain: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Before an agent write or undo rebuilds the WYSIWYG fragment, flush an un-propagated keystroke that provably does not overlap the operation into Y.Text so the keystroke survives instead of needing recovery; overlapping or unmodellable cases fall back to the checkpoint floor. Scope: appending writes and single-frame undos — a write that replaces the whole body (replace / edit) overwrites the keystroke either way, so those always take the checkpoint floor. Default ON — disable only to isolate a suspected regression.',
            })
            .default(true),
        })
        .default({ enabled: true }),
      flushOnHide: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                "On tab hide/unload, force-send each doc's unsynced work to the server and commit its local cache, and re-sync on return to foreground, so a backgrounded tab never strands edits that IndexedDB alone would lose on recycle. Honored client-side. Default ON — disable only to isolate a suspected regression.",
            })
            .default(true),
        })
        .default({ enabled: true }),
    })
    .default({
      backgroundThrottle: { enabled: true },
      deferGuard: { enabled: true },
      lossDetector: { enabled: true },
      fixedPoint: { enabled: true },
      preDrain: { enabled: true },
      flushOnHide: { enabled: true },
    }),
  // PROJECT-LOCAL scope: semantic search is an additive embeddings signal fused
  // into the MCP `search` tool's lexical ranking. It is per-machine, not
  // project-shared, because enabling it sends content to a third-party
  // embeddings provider (egress) and needs an API key in the local secrets file —
  // each teammate opts in deliberately for their own machine. Project scope
  // would force one teammate's egress choice across collaborators via git; user
  // scope would force it for every project. Default OFF — the feature ships dark.
  //
  // The non-secret provider knobs (baseUrl / model / dimensions) live here; the
  // API key NEVER does — it lives only in the 0600 `~/.ok/secrets.yml`
  // (`ok embeddings set-key`), out of the agent-readable project tree.
  search: z
    .looseObject({
      semantic: z
        .looseObject({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
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
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Base URL of the OpenAI-compatible embeddings API (default https://api.openai.com/v1). Override to point at a self-hosted server (Ollama / vLLM / LM Studio) or another provider. The API key is NOT stored here — set it with `ok embeddings set-key` (`~/.ok/secrets.yml`); it is sent to whichever endpoint this names.',
            })
            .default(DEFAULT_EMBEDDINGS_BASE_URL),
          model: z
            .string()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
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
              reload: 'live',
              defaultScope: 'project-local',
              description:
                "Optional output vector dimensions. Omit (recommended) to detect the model's native size from its first response — that is what lets a non-OpenAI model work without knowing its size up front. Set a smaller value (text-embedding-3 supports e.g. 512 / 1024) to shrink the on-disk cache, trading a little retrieval quality; a server that ignores the request param then fails loudly instead of silently. Changing it re-embeds the corpus.",
            })
            .optional(),
          similarityFloor: z
            .number()
            .min(0)
            .max(1)
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
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
  // Content rules (the markdown linter). PROJECT scope: lint standards (which
  // rules run, whether linting is on) are an authoring decision shared with the
  // team via git — the OK equivalent of a committed `.markdownlint.json`. The
  // no-code settings section + the desktop View-menu toggle write here; the
  // CodeMirror lint facet reads it. Defaults match `DEFAULT_LINTER_CONFIG` in
  // `markdown/lint`.
  contentRules: z
    .looseObject({
      // Lint plugins. Each entry is one built-in lint family with its own
      // per-plugin `enabled`; diagnostics from enabled plugins are concatenated.
      //
      // This leaf is hand-authored (not folded from the lint registry) because it
      // carries config-system metadata — per-field scope / agentSettable /
      // description + the walker registration contract — and deriving it would
      // couple markdown/lint to config. Adding a plugin means adding its slice
      // here too; `linter-leaf-registry-consistency.test.ts` fails loudly if this
      // drifts from LINT_PLUGINS.
      //
      // looseObject: a plugin slice written by a NEWER OK version must survive
      // an older version's parse→write-back cycle instead of being stripped. Each
      // plugin is a direct child of `contentRules` (no `plugins` wrapper).
      markdownlint: z
        .object({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description: 'Whether the markdownlint plugin (body rules) contributes diagnostics.',
            })
            .default(false),
          // The markdownlint `rules` are NOT persisted here. They live in the
          // project's own `.markdownlint.{json,jsonc,yaml,yml}` (native file =
          // source of truth, discovered server-side and injected into the
          // effective config; OK's tuned defaults layer under it). OK config
          // persists only this toggle.
        })
        .default({ enabled: false }),
      frontmatter: z
        .object({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Whether the frontmatter plugin (JSON-Schema validation of document frontmatter) contributes diagnostics.',
            })
            .default(false),
          // Schema CONTENT is NOT persisted here. Each entry scopes one
          // standard JSON Schema file (project-root-relative `file`, portable
          // to any external tool) to a set of docs via `appliesTo`
          // globs (single or list; leading `!` excludes; absent matches every
          // doc). Loaded server/CLI-side and injected into the effective
          // config; entry order carries no precedence — every match validates.
          schemas: z
            .array(
              z.object({
                appliesTo: z.union([z.string(), z.array(z.string())]).optional(),
                file: z.string(),
                // Absent = enabled; the Settings toggle writes false to keep
                // the mapping (and its appliesTo) without validating.
                enabled: z.boolean().optional(),
              }),
            )
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Frontmatter schema mappings: which docs (appliesTo globs) validate against which JSON Schema file (project-root-relative path).',
            })
            .default([]),
        })
        .default({ enabled: false, schemas: [] }),
      okf: z
        .object({
          enabled: z
            .boolean()
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Whether the OKF plugin (Open Knowledge Format portability + conformance rules) contributes diagnostics. Advisory warnings; never blocks a write.',
            })
            .default(false),
          // Per-rule opt-outs. No severity map: OKF findings are uniformly
          // advisory warnings, so a rule is only ever on or off. Deliberately
          // PARTIAL — absent means the rule runs, so a config records only
          // deviations and a newly registered rule is live without anyone
          // editing their config.
          //
          // The key space is OPEN, matching `markdownlint.rules`, and that is
          // load-bearing rather than lax. `config.yml` is committed and shared,
          // and this rule set grows: with a closed enum, a config written after
          // a new rule shipped fails to parse on any older build — and because
          // a schema failure defaults the WHOLE document, that one unknown key
          // silently reverts `content.dir`, the theme, and every other setting.
          // An unrecognized id is inert instead (`isOkfRuleEnabled` only ever
          // looks up registered ids); the settings pane is what keeps a human
          // from typo'ing one in the first place.
          rules: z
            .record(z.string(), z.boolean())
            .register(fieldRegistry, {
              scope: 'project',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project',
              description:
                'Per-rule opt-outs for the OKF plugin, keyed by rule id (e.g. no-wiki-links). Omit a rule to leave it enabled; set false to silence it while keeping the plugin on.',
            })
            .optional(),
          // The producer half of the format. Every other key under a plugin
          // describes what it REPORTS; these make it write files, which is why
          // they are opt-in separately from `enabled` rather than riding it. A
          // user who turned the plugin on to see conformance warnings did not
          // thereby ask OK to start owning documents in their tree.
          //
          // Keyed by artifact rather than a flat `generateIndex` boolean: a
          // second generated file is then a value, not a schema reshape of a
          // structure users already have in their config files.
          generate: z
            .object({
              index: z
                .boolean()
                .register(fieldRegistry, {
                  scope: 'project',
                  agentSettable: false,
                  reload: 'live',
                  defaultScope: 'project',
                  description:
                    'Whether OK generates and maintains a navigation index.md in every folder that contains Markdown, each listing the documents in that folder grouped by frontmatter type and linking to its subfolders. OK owns these files: edits to them are replaced on the next rebuild.',
                })
                .default(false),
            })
            .default({ index: false }),
        })
        .default({ enabled: false, generate: { index: false } }),
    })
    .default({
      markdownlint: { enabled: false },
      frontmatter: { enabled: false, schemas: [] },
      okf: { enabled: false, generate: { index: false } },
    }),
  // Validation-surface behavior (the unified audit plane's non-plugin knobs).
  // PROJECT scope, like `contentRules`: how broken links are classified and
  // whether the file tree surfaces problem indicators are team-shared
  // authoring decisions. Deliberately a SIBLING of `contentRules`, not a child
  // — `contentRules`' direct children are exactly the lint-plugin slices, a
  // lockstep contract enforced by `linter-leaf-registry-consistency.test.ts`.
  validation: z
    .looseObject({
      // 'off' hides broken-link findings from the whole plane (audit route,
      // MCP audit tool, ok audit, Problems panel, tree); 'warning'/'error'
      // set their severity. Default warning: a broken link is often a typo
      // or a page-yet-to-be-written, not necessarily an error.
      links: z
        .enum(LINKS_VALIDATION_SETTINGS)
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project',
          description:
            "How broken internal links are reported on the validation plane: 'off' hides them, 'warning' (default) or 'error' sets their severity.",
        })
        .default(DEFAULT_LINKS_VALIDATION),
      fileTreeIndicators: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project',
          description:
            'Whether the file tree tints and badges files that have validation problems.',
        })
        .default(true),
    })
    .default({ links: DEFAULT_LINKS_VALIDATION, fileTreeIndicators: true }),
  // PROJECT-LOCAL scope: external link-hover previews send the hovered URL to
  // the destination site to fetch its metadata (egress). Read per-machine from
  // the project-local layer, never a committed/shared config, so one clone's
  // choice never sets another's egress and a Settings toggle applies to the next
  // hover without a restart. Default ON: an absent key resolves to enabled here,
  // and a user turns external previews off with an explicit `enabled: false`.
  // This defaults ON even though its sibling egress knob `search.semantic.enabled`
  // defaults OFF: semantic search streams corpus content to a third-party
  // embeddings provider and needs an API key, whereas a preview sends only a URL
  // to the site the link already points at, so on-by-default is the right posture.
  // Internal (document-to-document) link previews are read entirely from the
  // local index with no network request and are NOT gated by this key.
  linkPreviews: z
    .looseObject({
      enabled: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            "Show a rich preview card (site name, page title, description, favicon) when you hover an external link in the editor. When ON, hovering an external link sends that link's URL to the destination site to fetch its preview metadata — outbound egress, one request per previewed link. Default ON; set to false to turn external previews off. Per-machine (project-local) — not shared with collaborators. Previews of links to other documents in this project are read from the local index with no network request and are always on.",
        })
        .default(true),
    })
    .default({ enabled: true }),
  // The canonical server surface: one listener whose local vs hosted posture
  // is EMERGENT from the values set here — there is deliberately no
  // `server.mode` / profile discriminator key. A mode key becomes a branch
  // target that drifts from the values that actually matter; "hosted" is
  // just what a non-loopback bind, a public URL, and consent look like.
  //
  // Scopes: `port` / `externalUrl` are PROJECT — the committed, reviewed shape
  // of this knowledge base's server. `bind` is PROJECT-LOCAL, alongside
  // `allowExternal` / `openBrowser` / `idleShutdown`: it is a per-machine
  // listener knob, and a committed non-loopback `bind` would otherwise refuse to
  // boot for every teammate who clones the repo and runs it locally — the
  // exposure interlock needs per-machine `allowExternal` consent, which is never
  // committed. Keeping `bind` project-local makes a committed value inert (the
  // loader's scope-aware merge skips the committed layer), so one machine
  // exposing the server can't break local clones for the rest of the team; the
  // exposing host sets it per-machine via `OK_BIND` / `--bind` or
  // `.ok/local/config.yml`. `allowExternal` is PROJECT-LOCAL consent, the same
  // posture as `terminal.enabled`: consent never travels via git, clone, or
  // share, so a committed `allowExternal: true` can never expose a future
  // cloner's machine (containers consent via environment instead). `openBrowser`
  // / `idleShutdown` are PROJECT-LOCAL personal workflow, like the sidebar
  // toggles.
  //
  // `agentSettable: false` on every leaf: an agent must never widen its own
  // network exposure.
  //
  // `openBrowser` and `idleShutdown` have DERIVED defaults, so those leaves stay
  // optional here — a schema-time `.default()` cannot see the other fields.
  // `openBrowser` keys off whether the resolved `bind` is loopback-only;
  // `idleShutdown` additionally keys off exposure (a loopback bind declared
  // externally reachable via `allowExternal` + `externalUrl` stays up too). The
  // derivation lives in `resolveServerRuntimeConfig` (`resolve-server-config.ts`).
  server: z
    .looseObject({
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'boot',
          defaultScope: 'project',
          description:
            'TCP port the server listens on. Unset by default: a local start picks a free port dynamically, and deployment platforms inject the PORT environment variable instead. Read at server start; changing it requires a restart.',
        })
        .optional(),
      bind: z
        .array(z.string().min(1))
        .min(1)
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'boot',
          defaultScope: 'project-local',
          description:
            'Addresses the server binds, e.g. [127.0.0.1] or [0.0.0.0]. Default loopback-only ([127.0.0.1]): nothing off this machine can connect. A non-loopback bind additionally requires the server.allowExternal consent interlock. Per-machine (project-local): a value committed to .ok/config.yml is ignored, so one machine exposing the server can never break local clones for the rest of the team — the exposing host sets it via OK_BIND, --bind, or .ok/local/config.yml. Lists replace, never merge. Read at server start; changing it requires a restart.',
        })
        .default([...DEFAULT_SERVER_BIND]),
      externalUrl: z
        .url({ protocol: /^https?$/ })
        // Runtime protocol check + the JSON-schema-serializable pattern (see
        // HTTP_URL_SCHEME_RE) — together they keep the published schema and the
        // runtime parser in agreement on the scheme.
        .regex(HTTP_URL_SCHEME_RE)
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'boot',
          defaultScope: 'project',
          description:
            'Canonical external origin the server is reached at, e.g. https://kb.example.com — its host joins the Host/Origin allowlists (external-Host + CORS admission). Unset by default: the server admits only loopback Hosts. Setting it declares external exposure, which additionally requires the server.allowExternal consent interlock. Read at server start; changing it requires a restart.',
        })
        .optional(),
      allowExternal: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'boot',
          defaultScope: 'project-local',
          description:
            'Exposure consent interlock. Once the unified server boot lands, a non-loopback server.bind or a server.externalUrl without allowExternal: true will be refused at boot with a one-line fix. Default off. Per-machine (project-local) — consent never travels via git, clone, or share; containers consent via the environment instead.',
        })
        .default(false),
      openBrowser: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'boot',
          defaultScope: 'project-local',
          description:
            'Open the UI in a browser when the server starts. Default derived: true when every bind address is loopback (a laptop start pops the UI), false otherwise (a container or exposed bind is headless and must never try). Acts once at start. Per-machine (project-local) — not shared.',
        })
        .optional(),
      idleShutdown: z
        .union([z.literal('off'), z.string().regex(IDLE_SHUTDOWN_DURATION_RE)])
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            "Shut the server down after this long with no activity: a duration like '30m' (positive integer with unit s, m, or h), or 'off'. Default derived: '30m' for a loopback-only, unexposed server; 'off' otherwise — a non-loopback bind, or a loopback bind declared externally reachable (server.allowExternal + server.externalUrl), stays up, because a remote agent keeps it busy over /mcp, which the idle timer does not count. Residual case the derivation cannot see: a loopback server reached by remote agents with no server.externalUrl (e.g. behind a same-box reverse proxy) still idles at 30m — set 'off' by hand. Reloadable — a valid change applies without a restart. Per-machine (project-local) — not shared.",
        })
        .optional(),
    })
    .default({
      bind: [...DEFAULT_SERVER_BIND],
      allowExternal: false,
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
