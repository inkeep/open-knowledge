import { z } from 'zod';
import { DEFAULT_ATTACHMENT_FOLDER_PATH } from '../constants/upload.ts';
import { fieldRegistry } from './field-registry.ts';

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

export const DEFAULT_EMBEDDINGS_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';

export const ConfigSchema = z.looseObject({
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
            'Folder pasted or dropped assets are written to. Use ./ for the current page folder, / for the content root, ./attachments beside each page, or attachments for a fixed content-relative folder.',
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

export type ConfigPatch = DeepPartial<Config>;

type DeepPartial<T> =
  T extends Array<infer U>
    ? Array<U>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> | null }
      : T;
