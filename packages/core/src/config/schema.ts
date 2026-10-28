import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../constants/doc-extensions.ts';
import {
  BESIDE_DOCUMENT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
} from '../constants/upload.ts';
import { SUPPORTED_LOCALES } from '../i18n/locales.ts';
import {
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
  LINKS_VALIDATION_SETTINGS,
} from '../markdown/lint/types.ts';
import { BASE16_SLOT_ROLES, BASE16_SLOTS } from '../theme/base16.ts';
import { THEME_ID_PATTERN, THEME_PLUGIN_IDS } from '../theme/theme-plugins.ts';
import {
  MAX_SYNC_INTERVAL_SECONDS,
  MIN_SYNC_INTERVAL_SECONDS,
  STORED_SYNC_ACTIVE_MODES,
  STORED_SYNC_MODES,
} from './auto-sync-mode.ts';
import { EffectiveAutolinkEntrySchema } from './autolinks-config.ts';
import { fieldRegistry } from './field-registry.ts';
import { EffectiveGitHostEntrySchema } from './git-host-config.ts';
import { EffectiveTrustedPrivateOriginSchema } from './skill-source-config.ts';

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
export const MIN_EMBEDDINGS_MAX_BATCH_SIZE = 1;
export const MAX_EMBEDDINGS_MAX_BATCH_SIZE = 2_048;
export const MIN_EMBEDDINGS_MAX_BATCH_CHARS = 1;
export const MAX_EMBEDDINGS_MAX_BATCH_CHARS = 16_384_000;
export const MIN_EMBEDDINGS_DOC_TIMEOUT_MS = 1;
export const MAX_EMBEDDINGS_DOC_TIMEOUT_MS = 600_000;

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

export function canonicalAttachmentFolderPath(value: string): string {
  const normalized = normalizeAttachmentFolderPath(value);
  if (normalized === '.') return '/';
  if (normalized.startsWith('./') || normalized.startsWith('/')) return normalized;
  return `/${normalized}`;
}

export const ATTACHMENT_FOLDER_PATH_VARIABLES = ['filename'] as const;

type AttachmentFolderPathVariable = (typeof ATTACHMENT_FOLDER_PATH_VARIABLES)[number];

export type AttachmentFolderPathPart =
  | { kind: 'text'; text: string; start: number }
  | { kind: 'variable'; text: string; start: number; name: AttachmentFolderPathVariable }
  | { kind: 'unknown-variable'; text: string; start: number; name: string };

export type AttachmentFolderPathVariableIssue =
  | { kind: 'unknown-variable'; variables: string[] }
  | { kind: 'unclosed-braces' }
  | { kind: 'repeated-variable' };

const ATTACHMENT_FOLDER_VARIABLE_PATTERN = /\{\{([^{}\n]+?)\}\}/g;

function isAttachmentFolderPathVariable(name: string): name is AttachmentFolderPathVariable {
  return (ATTACHMENT_FOLDER_PATH_VARIABLES as readonly string[]).includes(name);
}

export function parseAttachmentFolderPath(value: string): AttachmentFolderPathPart[] {
  const parts: AttachmentFolderPathPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(ATTACHMENT_FOLDER_VARIABLE_PATTERN)) {
    const start = match.index;
    if (start > cursor)
      parts.push({ kind: 'text', text: value.slice(cursor, start), start: cursor });
    const name = (match[1] ?? '').trim();
    parts.push(
      isAttachmentFolderPathVariable(name)
        ? { kind: 'variable', text: match[0], start, name }
        : { kind: 'unknown-variable', text: match[0], start, name },
    );
    cursor = start + match[0].length;
  }
  if (cursor < value.length) parts.push({ kind: 'text', text: value.slice(cursor), start: cursor });
  return parts;
}

function countVariables(parts: readonly AttachmentFolderPathPart[]): number {
  return parts.filter((part) => part.kind === 'variable').length;
}

export function attachmentFolderPathVariableIssue(
  value: string,
): AttachmentFolderPathVariableIssue | null {
  const parts = parseAttachmentFolderPath(value);
  const unknown = parts.flatMap((part) => (part.kind === 'unknown-variable' ? [part.text] : []));
  if (unknown.length > 0) return { kind: 'unknown-variable', variables: unknown };
  if (
    parts.some(
      (part) => part.kind === 'text' && (part.text.includes('{{') || part.text.includes('}}')),
    )
  ) {
    return { kind: 'unclosed-braces' };
  }
  if (value.split('/').some((segment) => countVariables(parseAttachmentFolderPath(segment)) > 1)) {
    return { kind: 'repeated-variable' };
  }
  return null;
}

export function describeAttachmentFolderPathVariableIssue(
  issue: AttachmentFolderPathVariableIssue,
): string {
  const supported = ATTACHMENT_FOLDER_PATH_VARIABLES.map((name) => `{{${name}}}`).join(', ');
  switch (issue.kind) {
    case 'unknown-variable':
      return `content.attachmentFolderPath uses the unknown variable ${issue.variables.join(', ')}. Supported variables: ${supported}.`;
    case 'unclosed-braces':
      return 'content.attachmentFolderPath has a "{{" or "}}" without its pair.';
    case 'repeated-variable':
      return 'content.attachmentFolderPath uses a variable more than once in one folder name.';
  }
}

function expandAttachmentFolderPath(
  value: string,
  variables: Record<AttachmentFolderPathVariable, string>,
): string {
  return parseAttachmentFolderPath(value)
    .map((part) => (part.kind === 'variable' ? variables[part.name] : part.text))
    .join('');
}

function documentFilenameVariable(docFile: string): string {
  const lower = docFile.toLowerCase();
  const docExt = SUPPORTED_DOC_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return docExt ? docFile.slice(0, -docExt.length) : '';
}

export function attachmentFolderForDocument(attachmentFolderPath: string, docPath: string): string {
  const slash = docPath.lastIndexOf('/');
  const docDir = slash === -1 ? '' : docPath.slice(0, slash);
  const filename = documentFilenameVariable(docPath.slice(slash + 1));
  const normalized = normalizeAttachmentFolderPath(attachmentFolderPath);
  const template =
    filename === '' && countVariables(parseAttachmentFolderPath(normalized)) > 0
      ? BESIDE_DOCUMENT_ATTACHMENT_FOLDER_PATH
      : normalized;
  const expanded = expandAttachmentFolderPath(template, { filename });
  const docRelative = expanded.startsWith('./');
  const rest = docRelative ? expanded.slice(2) : expanded;
  return [...(docRelative ? [docDir] : []), ...rest.split('/')]
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

export function attachmentFolderSegmentMatcher(segment: string): (candidate: string) => boolean {
  const parts = parseAttachmentFolderPath(segment);
  if (countVariables(parts) !== 1) return (candidate) => candidate === segment;
  const variableIndex = parts.findIndex((part) => part.kind === 'variable');
  const textOf = (side: readonly AttachmentFolderPathPart[]) =>
    side.map((part) => part.text).join('');
  const prefix = textOf(parts.slice(0, variableIndex));
  const suffix = textOf(parts.slice(variableIndex + 1));
  return (candidate) =>
    candidate.length > prefix.length + suffix.length &&
    candidate.startsWith(prefix) &&
    candidate.endsWith(suffix);
}

const ATTACHMENT_FOLDER_PATH_SAFETY_RULE =
  "must not contain '..' segments, NUL bytes, backslashes, or drive letters";

export function isValidAttachmentFolderPath(value: string): boolean {
  const normalized = normalizeAttachmentFolderPath(value);
  if (normalized.includes('\0')) return false;
  if (normalized.includes('\\')) return false;
  const segments = normalized.split('/');
  const firstFolder = segments.find((segment) => segment !== '' && segment !== '.');
  if (firstFolder !== undefined && /^[A-Za-z]:/.test(firstFolder)) return false;
  if (segments.some((seg) => seg === '..')) return false;
  return true;
}

const RESERVED_FOLDER_NAME_CHARACTERS = /[<>:"\\|?*]/;

export type AttachmentFolderPathInputIssue =
  | { kind: 'empty' }
  | { kind: 'outside-project' }
  | { kind: 'reserved-character' }
  | { kind: 'surrounding-space' }
  | { kind: 'missing-prefix' }
  | { kind: 'empty-folder-name' }
  | { kind: 'trailing-slash' }
  | { kind: 'single-brace' }
  | AttachmentFolderPathVariableIssue;

function inputIssue(issue: AttachmentFolderPathInputIssue) {
  return { params: issue };
}

function hasSingleBrace(path: string): boolean {
  return parseAttachmentFolderPath(path).some(
    (part) => part.kind === 'text' && /[{}]/.test(part.text),
  );
}

const AttachmentFolderPathInputSchema = z
  .string()
  .refine((path) => path.trim() !== '', inputIssue({ kind: 'empty' }))
  .refine(
    (path) => !RESERVED_FOLDER_NAME_CHARACTERS.test(path),
    inputIssue({ kind: 'reserved-character' }),
  )
  .refine(isValidAttachmentFolderPath, inputIssue({ kind: 'outside-project' }))
  .refine((path) => path === path.trim(), inputIssue({ kind: 'surrounding-space' }))
  .refine(
    (path) => path.startsWith('./') || path.startsWith('/'),
    inputIssue({ kind: 'missing-prefix' }),
  )
  .refine((path) => !path.includes('//'), inputIssue({ kind: 'empty-folder-name' }))
  .refine(
    (path) => path === './' || path === '/' || !path.endsWith('/'),
    inputIssue({ kind: 'trailing-slash' }),
  )
  .superRefine((path, ctx) => {
    const issue = attachmentFolderPathVariableIssue(path);
    if (issue) ctx.addIssue({ code: 'custom', params: issue });
  })
  .refine((path) => !hasSingleBrace(path), inputIssue({ kind: 'single-brace' }));

const INPUT_ISSUE_KINDS = {
  empty: true,
  'outside-project': true,
  'reserved-character': true,
  'surrounding-space': true,
  'missing-prefix': true,
  'empty-folder-name': true,
  'trailing-slash': true,
  'single-brace': true,
  'unknown-variable': true,
  'unclosed-braces': true,
  'repeated-variable': true,
} satisfies Record<AttachmentFolderPathInputIssue['kind'], true>;

function isAttachmentFolderPathInputIssue(value: unknown): value is AttachmentFolderPathInputIssue {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  const { kind } = value;
  if (typeof kind !== 'string' || !Object.hasOwn(INPUT_ISSUE_KINDS, kind)) return false;
  return kind !== 'unknown-variable' || ('variables' in value && Array.isArray(value.variables));
}

export function attachmentFolderPathInputIssue(
  path: string,
): AttachmentFolderPathInputIssue | null {
  const result = AttachmentFolderPathInputSchema.safeParse(path);
  if (result.success) return null;
  const [first] = result.error.issues;
  const params = first?.code === 'custom' ? first.params : undefined;
  if (isAttachmentFolderPathInputIssue(params)) return params;
  throw new Error(
    `Attachment folder path check failed without a known problem kind: ${first?.message}`,
  );
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
            "Where pasted and dropped assets, and MCP write assets given a bare file name, are stored. The path must start with './' (relative to the current document) or '/' (relative to the content root): './' colocates beside the current document; './subdir' targets a subfolder next to it; '/' targets the content root; '/folder' targets a fixed folder under the content root. '{{filename}}' expands to the current document's name without its extension, so the default './{{filename}}.assets' keeps each document's files in its own folder. An upload whose parent is not a Markdown document, such as an MCP write asset given a bare file name, ignores {{filename}} and is placed as with './', which for a bare file name is the content root. A bare name such as 'attachments', saved by older versions, is read as '/attachments'. A path with an unknown variable refuses uploads until it is fixed. Whitespace-only values are treated as the default.",
        })
        .refine(isValidAttachmentFolderPath, {
          message: `Invalid attachment folder path: ${ATTACHMENT_FOLDER_PATH_SAFETY_RULE}.`,
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
            "Auto-approve OpenKnowledge's own tools for agents launched from the built-in terminal (plus `ok open` on Claude) and for in-app Agents-panel chats with any ACP agent. Destructive tools (delete/move/share/install/import) still prompt. Per-machine personal preference (user scope).",
        })
        .default(true),
      browserTools: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            "Give in-app Claude Code and Codex chats a browser they can drive (Playwright MCP, started through npx from OpenKnowledge's own folder with a fresh in-memory profile), so an agent can open pages, click, and take screenshots. Every browser action asks for approval, with no option to always allow it, unless the agent's own mode or permission settings skip approvals. Needs Google Chrome and Node.js. Off by default; takes effect for chats started after the change. Per-machine personal preference (user scope).",
        })
        .default(false),
    })
    .default({ autoApproveOkTools: true, browserTools: false }),
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
            'Seconds between scheduled pulls while autoSync.mode is follow or full (default 30). Per-machine (project-local) — not shared.',
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
  skills: z
    .looseObject({
      trustedPrivateOrigins: z
        .array(EffectiveTrustedPrivateOriginSchema)
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'user',
          description:
            'Canonical HTTPS origins allowed to serve website skills from private network addresses. Empty by default: website skills require public addresses. Set only in user global.yml, never project configuration or acquisition requests. Use a lowercase hostname and omit credentials, default port 443, trailing slash, path, query, fragment and wildcards. Include nondefault ports when required. Invalid entries are ignored with located config diagnostics; valid siblings remain approved. TLS certificate and hostname checks still apply.',
        })
        .default([])
        .catch([]),
    })
    .default({ trustedPrivateOrigins: [] }),
  git: z
    .looseObject({
      hosts: z
        .record(z.string(), EffectiveGitHostEntrySchema)
        .register(fieldRegistry, {
          scope: 'user',
          agentSettable: false,
          reload: 'boot',
          defaultScope: 'user',
          description:
            "Per-git-host declarations, keyed by hostname (for example ghes.example.com). Each entry says how OpenKnowledge should treat remotes on that host; today the only key an entry carries is `provider`. Hosts absent from this map are treated as generic git remotes. Per-machine (user scope, global.yml in the OpenKnowledge home folder); a value in a project's `.ok/config.yml` is ignored. Declarations take effect when OpenKnowledge next starts.",
        })
        .default({})
        .catch({}),
    })
    .default({ hosts: {} }),
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
                'Write per-project diagnostic spans + logs under the user-level OpenKnowledge logs directory for `ok diagnose bundle`. Files stay local unless shared, including in a support bundle. Set false for sensitive workspaces. Shared across collaborators.',
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
                'Report skill installs to skills.sh so a published skill shows an accurate install count. Sends the skill name, its source repo, and which agent tools it was installed for — never file contents, and never for a private or local source. One report per skill per machine. Default off; when it is on, the DO_NOT_TRACK and DISABLE_TELEMETRY environment variables still turn it off.',
            })
            .default(false),
        })
        .default({ enabled: false }),
    })
    .default({
      localSink: {
        enabled: true,
        spans: { maxBytes: DEFAULT_SPANS_MAX_BYTES },
        logs: { maxBytes: DEFAULT_LOGS_MAX_BYTES },
        attributeDenylist: [...DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST],
      },
      skillInstallReports: { enabled: false },
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
                'Base URL of the OpenAI-compatible embeddings API (default https://api.openai.com/v1). Override to point at a self-hosted server (Ollama / vLLM / LM Studio) or another provider. The API key is NOT stored here — set it with `ok embeddings set-key` (stored in secrets.yml in the OpenKnowledge home folder); it is sent to whichever endpoint this names.',
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
            .min(MIN_EMBEDDINGS_MAX_BATCH_SIZE)
            .max(MAX_EMBEDDINGS_MAX_BATCH_SIZE)
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                "Maximum number of text chunks sent in one indexing request (1–2048, default 96). The ceiling follows OpenAI's input-array limit; other providers may impose different limits. Larger requests may still be split by the character budget. Changing it preserves cached vectors and document chunking; it applies to the next indexing pass. Invalid values use the default and are reported by ok config validate and server logs.",
            })
            .default(DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE)
            .catch(DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE),
          maxBatchChars: z
            .number()
            .int()
            .min(MIN_EMBEDDINGS_MAX_BATCH_CHARS)
            .max(MAX_EMBEDDINGS_MAX_BATCH_CHARS)
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Approximate cumulative character budget per indexing request (1–16384000, default 96000). A single chunk can exceed this budget. OpenAI separately caps total input at 300000 tokens per request; this character budget does not enforce that limit, and high values can produce rejected requests. Other providers have their own limits. Changing it preserves cached vectors and document chunking; it applies to the next indexing pass. Invalid values use the default and are reported by ok config validate and server logs.',
            })
            .default(DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS)
            .catch(DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS),
          docTimeoutMs: z
            .number()
            .int()
            .min(MIN_EMBEDDINGS_DOC_TIMEOUT_MS)
            .max(MAX_EMBEDDINGS_DOC_TIMEOUT_MS)
            .register(fieldRegistry, {
              scope: 'project-local',
              agentSettable: false,
              reload: 'live',
              defaultScope: 'project-local',
              description:
                'Timeout in milliseconds for each indexing request attempt (1–600000, default 30000). A request can retry four times, and a failed grouped request can trigger individual-document requests. There is no total indexing-pass deadline: large timeouts can delay newly queued work for hours. The query timeout remains 8 seconds per attempt. Changing it preserves cached vectors and applies to the next indexing pass; an in-progress pass keeps its current timeout. Invalid values use the default and are reported by ok config validate and server logs.',
            })
            .default(DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS)
            .catch(DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS),
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
      suppressLogLinkAdvisories: z
        .boolean()
        .register(fieldRegistry, {
          scope: 'project',
          agentSettable: false,
          reload: 'live',
          defaultScope: 'project',
          description:
            "Whether unresolved links in the reserved change-history documents (lowercase-stemmed log.md / log.mdx at any depth, where the extension's case does not matter and the stem's does) are omitted from broken-link advisories: the Problems panel, file-tree indicators, source diagnostics, audits, and agent write/edit results. Default true. Raw link views still show them, and LOG.md, Log.md, and every other stem spelling are ordinary documents.",
        })
        .default(DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES),
    })
    .default({
      links: DEFAULT_LINKS_VALIDATION,
      fileTreeIndicators: true,
      suppressLogLinkAdvisories: DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
    }),
  autolinks: z
    .array(EffectiveAutolinkEntrySchema)
    .register(fieldRegistry, {
      scope: 'project',
      agentSettable: false,
      reload: 'live',
      defaultScope: 'project',
      description:
        'Turn ticket references into links; today they apply to Agents-panel chat messages. Each entry pairs a `prefix` (for example `PRD-`) with a `url` template containing `<num>` (for example `https://linear.app/inkeep/issue/PRD-<num>`); the prefix followed by digits links to that URL with the digits in place of `<num>`. Matching is case-sensitive. An invalid entry is skipped with a warning and the others still apply. Shared with collaborators (project scope, `.ok/config.yml`).',
    })
    .default([])
    .catch([]),
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
            "Show a rich preview card (site name, page title, description, favicon) when you hover an external link in the editor, and a status card when you hover a GitHub pull request or issue link in an agent chat. When ON, hovering an external link sends that link's URL to the destination site to fetch its preview metadata, and hovering a GitHub reference asks the GitHub host's API for it, signed in as you when a GitHub sign-in is available — outbound egress, one request per previewed link. Default ON; set to false to turn external previews off. Per-machine (project-local) — not shared with collaborators. Previews of links to other documents in this project are read from the local index with no network request and are always on.",
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
            'Exposure consent interlock. A non-loopback server.bind without allowExternal: true is refused at boot with a one-line fix; a server.externalUrl without it boots (a committed externalUrl never arms exposure on clones — but it is project-scoped, so its host still joins the Host/Origin allowlists there), but requests carrying forwarding headers (X-Forwarded-For etc.) are refused until consent is given — proxy tolerance requires both keys. Default off. The server has no authentication of its own, so only consent behind an authenticating edge. Per-machine (project-local) — consent never travels via git, clone, or share; containers consent via the environment instead.',
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
