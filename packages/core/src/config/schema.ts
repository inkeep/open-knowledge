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

function namedThemeIds() {
  return THEME_PLUGIN_IDS.filter((id) => id !== 'default' && id !== 'custom')
    .map((id) => `'${id}'`)
    .join(', ');
}

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

const DEFAULT_LOSS_CAPTURE_MAX_BYTES = 12_582_912;

export const DEFAULT_EMBEDDINGS_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE = 96;
export const DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS = 96_000;
export const DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS = 30_000;

export const DEFAULT_SERVER_BIND: readonly string[] = Object.freeze(['127.0.0.1']);

export const IDLE_SHUTDOWN_DURATION_RE = /^[1-9]\d*(s|m|h)$/;

const HTTP_URL_SCHEME_RE = /^https?:\/\//;

export const DEFAULT_TUNNEL_PORT = 24550;

export type EmbeddingsBaseUrlProblem = 'invalid-url' | 'insecure-scheme';

export function isLoopbackEmbeddingsUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
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
  if (normalized === '/') return true;
  if (normalized.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) return false;
  return true;
}

export const ConfigSchema = z.looseObject({
  content: z
    .looseObject({
      dir: z
        .string()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
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
      shell: z
        .string()
        .register(fieldRegistry, {
          scope: 'project-local',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project-local',
          description:
            'Absolute Windows shell executable override for the in-app terminal. PowerShell, cmd.exe, and Git Bash support OpenKnowledge-managed launches (agent chat tabs and fixed commands such as Resolve in terminal or Install Slidev) and dropped-file path insertion. A different existing executable remains usable for plain terminal tabs and shows a capability notice; requested agent and command launches open only the plain shell without running the agent or command, and dropped-file paths are refused. Empty values use automatic shell discovery. Per-machine (project-local), human-managed, and never shared via git, clone, or sync.',
        })
        .optional(),
    })
    .default({ enabled: null }),
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
          maxBatchSize: z
            .number()
            .int()
            .positive()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Maximum number of document inputs sent in one embeddings request (default 96). This changes only transport batching, not document chunking or vector-cache identity. Most setups should keep the default.',
            })
            .default(DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE),
          maxBatchChars: z
            .number()
            .int()
            .positive()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Approximate maximum cumulative character budget per document embeddings request (default 96000). This changes only transport batching, not document chunking or vector-cache identity. Most setups should keep the default.',
            })
            .default(DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS),
          docTimeoutMs: z
            .number()
            .int()
            .positive()
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Timeout in milliseconds for each document embeddings request (default 30000). Query timeout is unchanged. This transport setting does not change vector-cache identity. Most setups should keep the default.',
            })
            .default(DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS),
        })
        .default({
          enabled: false,
          baseUrl: DEFAULT_EMBEDDINGS_BASE_URL,
          model: DEFAULT_EMBEDDINGS_MODEL,
          maxBatchSize: DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
          maxBatchChars: DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
          docTimeoutMs: DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
        }),
    })
    .default({
      semantic: {
        enabled: false,
        baseUrl: DEFAULT_EMBEDDINGS_BASE_URL,
        model: DEFAULT_EMBEDDINGS_MODEL,
        maxBatchSize: DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
        maxBatchChars: DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
        docTimeoutMs: DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
      },
    }),
  contentRules: z
    .looseObject({
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
          schemas: z
            .array(
              z.object({
                appliesTo: z.union([z.string(), z.array(z.string())]).optional(),
                file: z.string(),
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
  validation: z
    .looseObject({
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

export type ConfigPatch = DeepPartial<Config>;

type DeepPartial<T> =
  T extends Array<infer U>
    ? Array<U>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> | null }
      : T;
