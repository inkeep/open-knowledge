import { MANAGED_ARTIFACT_SCOPES, SKILL_NAME_REGEX } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { AutoStartDisabledError } from '../../autostart.ts';
import { resolveLockDir } from '../../config/paths.ts';
import { armPaneTarget } from '../../pane-target.ts';
import { isProcessAlive } from '../../process-alive.ts';
import { readServerLock } from '../../server-lock.ts';
import {
  awaitUiBaseUrl,
  encodeDocName,
  encodeFolderRoute,
  encodeSkillRoute,
  type PreviewUrlContext,
  resolveUiInfo,
} from './preview-url.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectConfigContext,
  resolveServerUrl,
  textPlusStructured,
} from './shared.ts';

const DESCRIPTION = [
  'Resolve the browser-reachable preview URL for an OpenKnowledge project (optionally for a specific doc). Opening a preview counts as demand: when no OK server is running for the project, this call auto-starts one (same `OK_MCP_AUTOSTART` gate and spawn timeout as the read/write tools) and waits briefly for the preview UI to bind — a cold first call can take a few seconds; calls against a running system answer immediately.',
  '',
  'Per-response `previewUrl` fields on read/write tools are ROUTE-ONLY (`/#/<doc>`, no host:port) — they identify which doc to preview, not a URL to open by itself. Call this tool to get the full, openable URL.',
  '',
  'Use this when YOUR host opens the URL itself: navigate your in-app browser to the returned `url`, or — only on a stdio host with no browser tool — `open` it in the system browser. Hosts with a preview pane (Claude Code Desktop) call `preview_start("open-knowledge-ui")` instead; the Claude Code CLI uses `ok open <doc>` to open in the OK Desktop app.',
  '',
  'Returns `{ url: null, baseUrl: null, running: false, autoOpen }` + a recovery hint only when no UI could be reached (auto-start disabled via `OK_MCP_AUTOSTART=0`, no spawn authority in this registration, or the UI did not bind in time) — the hint names the right command for the actual state.',
  '',
  '**Parameters:**',
  '- `document` (optional) — Extension-less doc path (e.g. `specs/foo/SPEC`). Omit for the UI root URL.',
  '- `folder` (optional) — Folder path (e.g. `specs/foo`); returns the `…/#/<folder>/` route. Mutually exclusive with `document`.',
  '- `skill` (optional) — A skill to open in the editor: `{ name, scope? }` (scope `project` default). Returns the `…/#/__skill__/<scope>/<name>` route. Mutually exclusive with `document`/`folder`.',
  '- `armPaneTarget` (optional) — When true with a `document`/`folder`/`skill`, writes a small TTL-bounded (~30s) state file under `.ok/local/` so a later Claude-pane base-open lands on that target. Independent of server state; omit it and the call writes nothing.',
  '- `cwd` (optional) — Project root (see `cwd` description below).',
].join('\n');

interface GetPreviewUrlDeps {
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  serverUrl?: ServerUrlOrResolver;
  uiBindWait?: { timeoutMs?: number; pollIntervalMs?: number };
}

const UI_BIND_WAIT_TIMEOUT_MS = 3000;
const UI_BIND_WAIT_POLL_MS = 100;

const InputSchema = {
  document: z
    .string()
    .optional()
    .describe(
      'Extension-less doc path to resolve a preview URL for (e.g. "specs/foo/SPEC"). Omit to get the UI root URL.',
    ),
  folder: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Folder path to resolve a folder-route preview URL for (e.g. "specs/foo"); returns the `…/#/<folder>/` route. Mutually exclusive with `document`.',
    ),
  skill: z
    .object({
      name: z
        .string()
        .min(1)
        .regex(SKILL_NAME_REGEX, 'Skill name must be lowercase letters, digits, and hyphens only.')
        .describe('Skill name (the `.ok/skills/<name>` identity).'),
      scope: z
        .enum(MANAGED_ARTIFACT_SCOPES)
        .optional()
        .describe('Skill scope; defaults to `project`.'),
    })
    .optional()
    .describe(
      'Skill to resolve an editor preview URL for; returns the `…/#/__skill__/<scope>/<name>` route. Mutually exclusive with `document`/`folder`.',
    ),
  armPaneTarget: z
    .boolean()
    .optional()
    .describe(
      'When true with a `document` or `folder`, arm that target so a subsequent Claude-pane base-open (`preview_start`) lands there instead of the presence-driven default. TTL-bounded (~30s) so a stale arm cannot hijack a later open.',
    ),
  cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
} as const;

const OutputSchema = outputSchemaWithText({
  url: z
    .string()
    .nullable()
    .describe(
      'Browser-reachable URL — the UI base joined with the doc route when `document` is given, else the UI root. `null` when no UI is running.',
    ),
  baseUrl: z
    .string()
    .nullable()
    .describe(
      'Browser-reachable origin of the running UI (e.g. `http://localhost:5173`). `null` when no UI is running.',
    ),
  running: z.boolean().describe('Whether a UI is running for the project.'),
  autoOpen: z
    .boolean()
    .describe(
      'User-scoped preview-auto-open preference (`appearance.preview.autoOpen`). When `true`, the agent should route the preview using capability-based routing (in-app browser if available, system browser as fallback). When `false`, the user is managing their own preview view (OK Desktop window, a browser tab they opened, etc.) — the agent must NOT open or refresh any preview UI, and should surface this URL only on direct user ask. Resolved fresh on every call; defaults to `true`.',
    ),
});

const NO_UI_SERVER_RUNNING_MESSAGE =
  'The OK server is running but no UI has bound for this project yet. Retry in a few seconds, or start one: `ok ui` (terminal), `preview_start("open-knowledge-ui")` (Claude Code Desktop), or open the project in OK Electron.';
const NO_SERVER_MESSAGE =
  'No OpenKnowledge server is running for this project. Start it with `ok start` (also starts the preview UI), use `preview_start("open-knowledge-ui")` (Claude Code Desktop), or open the project in OK Electron.';
const AUTOSTART_DISABLED_NOTE = ' Auto-start is disabled (OK_MCP_AUTOSTART=0).';

function isServerLive(lockDir: string): boolean {
  try {
    const lock = readServerLock(lockDir);
    return lock !== null && lock.port > 0 && isProcessAlive(lock.pid);
  } catch (err) {
    process.stderr.write(
      `[preview-url] readServerLock failed at ${lockDir} while checking server liveness: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

export function register(server: ServerInstance, deps: GetPreviewUrlDeps): void {
  server.registerTool(
    'preview_url',
    {
      description: DESCRIPTION,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args: {
      document?: string;
      folder?: string;
      skill?: { name: string; scope?: 'project' | 'global' };
      armPaneTarget?: boolean;
      cwd?: string;
    }) => {
      if ([args.document, args.folder, args.skill].filter((t) => t != null).length > 1) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Error: document, folder, and skill are mutually exclusive — pass at most one.',
            },
          ],
        };
      }
      const context = await resolveProjectConfigContext(deps.resolveCwd, deps.config, args.cwd);
      if (!context.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Error: ${context.error}` }],
        };
      }
      const lockDir = resolveLockDir(context.cwd);
      const ctx: PreviewUrlContext = { lockDir };
      const autoOpen = context.config.appearance.preview.autoOpen;

      const routeFragment = args.document
        ? `#/${encodeDocName(args.document)}`
        : args.folder
          ? `#/${encodeFolderRoute(args.folder)}`
          : args.skill
            ? `#/${encodeSkillRoute(args.skill.scope ?? 'project', args.skill.name)}`
            : null;

      if (args.armPaneTarget && routeFragment) {
        try {
          armPaneTarget(lockDir, routeFragment);
        } catch {}
      }

      const armNote =
        args.armPaneTarget && !routeFragment
          ? ' (note: armPaneTarget was set but no document/folder/skill was given, so nothing was armed)'
          : '';

      const serverWasLive = isServerLive(lockDir);
      let autoStartDisabled = false;
      if (deps.serverUrl !== undefined) {
        try {
          await resolveServerUrl(deps.serverUrl, context.cwd);
        } catch (err) {
          if (err instanceof AutoStartDisabledError) {
            autoStartDisabled = true;
          } else {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        }
      }

      let { baseUrl } = resolveUiInfo(ctx);
      if (baseUrl === null && !serverWasLive && isServerLive(lockDir)) {
        baseUrl = await awaitUiBaseUrl(ctx, {
          timeoutMs: deps.uiBindWait?.timeoutMs ?? UI_BIND_WAIT_TIMEOUT_MS,
          pollIntervalMs: deps.uiBindWait?.pollIntervalMs ?? UI_BIND_WAIT_POLL_MS,
        });
      }

      if (baseUrl === null) {
        const hint = isServerLive(lockDir)
          ? NO_UI_SERVER_RUNNING_MESSAGE
          : `${NO_SERVER_MESSAGE}${autoStartDisabled ? AUTOSTART_DISABLED_NOTE : ''}`;
        return textPlusStructured(`${hint}${armNote}`, {
          url: null,
          baseUrl: null,
          running: false,
          autoOpen,
        });
      }

      const url = routeFragment ? `${baseUrl}/${routeFragment}` : baseUrl;

      return textPlusStructured(`Preview URL: ${url}${armNote}`, {
        url,
        baseUrl,
        running: true,
        autoOpen,
      });
    },
  );
}
