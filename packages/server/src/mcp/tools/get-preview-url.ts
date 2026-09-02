import { isAbsolute } from 'node:path';
import { MANAGED_ARTIFACT_SCOPES, SKILL_NAME_REGEX } from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { z } from 'zod';
import { AutoStartDisabledError } from '../../autostart.ts';
import { resolveLockDir } from '../../config/paths.ts';
import {
  createOffCwdResolverDeps,
  type OffCwdResolverDeps,
  resolveOffCwdTarget,
} from '../../off-cwd-resolver.ts';
import { isProcessAlive } from '../../process-alive.ts';
import { lockAdvertisesUi, readServerLock } from '../../server-lock.ts';
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
  'This is THE way to open a doc OR a loose file in a browser, and the only way to force a browser when the OK Desktop app is installed (the `ok open` CLI prefers Desktop). Use it when YOUR host opens the URL itself: navigate your in-app / embedded browser to the returned `url`, or — only on a stdio host with no browser tool — `open` it in the system browser. Do not hunt for the URL via `ok ps`/`ok status` or by guessing a port — this tool returns it. Claude Code Desktop opens its in-app Browser pane with `preview_start({url})` then `navigate({url})` to move; a pure stdio CLI with no browser uses `ok open <doc>` to open in the OK Desktop app.',
  '',
  'If you are running INSIDE an OpenKnowledge surface — the desktop app’s built-in terminal or its in-app agent panel — the response leads with an `ok open …` steer and returns it as `okOpenCommand`. Run that instead: the user is already looking at the app, so a localhost URL in your reply is noise at best and a dead link at worst. Never paste `url` into your answer in that case.',
  '',
  'Returns `{ url: null, baseUrl: null, running: false, autoOpen }` + a recovery hint only when no UI could be reached (auto-start disabled via `OK_MCP_AUTOSTART=0`, no spawn authority in this registration, or the UI did not bind in time) — the hint names the right command for the actual state.',
  '',
  'To open a single markdown file that may live OUTSIDE any Open Knowledge project (a loose file, or a doc in a different git worktree), pass `file` with an absolute path: the tool finds the running session whose content directory contains it and returns that session’s URL, then navigate your in-app browser there. `document`/`folder` are for a doc in the current project; `file` is the out-of-project form.',
  '',
  '**Parameters:**',
  '- `document` (optional) — Extension-less doc path in the current project (e.g. `specs/foo/SPEC`). Omit for the UI root URL.',
  '- `folder` (optional) — Folder path in the current project (e.g. `specs/foo`); returns the `…/#/<folder>/` route. Mutually exclusive with `document`.',
  '- `skill` (optional) — A skill to open in the editor: `{ name, scope? }` (scope `project` default). Returns the `…/#/__skill__/<scope>/<name>` route. Mutually exclusive with `document`/`folder`/`file`.',
  '- `file` (optional) — Absolute path to a single markdown file, including one outside any project. Resolves to the running single-file / worktree session serving it. Mutually exclusive with `document`/`folder`/`skill`; `cwd` is ignored when set.',
  '- `cwd` (optional) — Project root (see `cwd` description below).',
].join('\n');

interface GetPreviewUrlDeps {
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  isHostedAgent?: boolean;
  serverUrl?: ServerUrlOrResolver;
  uiBindWait?: { timeoutMs?: number; pollIntervalMs?: number };
  offCwdResolverDeps?: OffCwdResolverDeps;
  ensureSingleFileSession?: (absFile: string) => Promise<boolean>;
  resolveUserAutoOpen?: () => boolean;
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
        .describe('Skill name (the bundle-dir identity, wherever the skill lives).'),
      scope: z
        .enum(MANAGED_ARTIFACT_SCOPES)
        .optional()
        .describe('Skill scope; defaults to `project`.'),
    })
    .optional()
    .describe(
      'Skill to resolve an editor preview URL for; returns the `…/#/__skill__/<scope>/<name>` route. Mutually exclusive with `document`/`folder`/`file`.',
    ),
  file: z
    .string()
    .optional()
    .describe(
      'Absolute path to a single markdown file to open, including one OUTSIDE any Open Knowledge project. Resolves to the running single-file (or worktree) session whose content directory contains it and returns that session’s `url`. Mutually exclusive with `document` / `folder` / `skill`. When `file` is set, `cwd` is ignored.',
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
  okOpenCommand: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Machine-readable form of the hosted-agent steer: when the calling agent runs inside an OpenKnowledge surface (the desktop app’s built-in terminal, or its in-app agent panel) AND a doc/folder/skill target was given, the exact `ok open …` command to run to bring it up for the user. Run it INSTEAD of navigating `url`, and do not paste `url` into your reply — the user is already in the app it points at. `null`/absent in every other context (navigate `url` per your host instead).',
    ),
});

const NO_UI_SERVER_RUNNING_MESSAGE =
  'The OK server is running but no UI has bound for this project yet. Retry in a few seconds, or open the project in OK Electron.';
const NO_UI_NONE_MOUNTED_MESSAGE =
  'The OK server is running but no preview UI is mounted (e.g. it was started with `--only server`). Restart it with plain `ok start` to serve the editor, or open the project in OK Electron.';
const NO_SERVER_MESSAGE =
  'No OpenKnowledge server is running for this project. Start it with `ok start` (also starts the preview UI), or open the project in OK Electron.';
const AUTOSTART_DISABLED_NOTE = ' Auto-start is disabled (OK_MCP_AUTOSTART=0).';
function readUserAutoOpen(): boolean {
  try {
    const cfg = readConfigSafely({
      absPath: resolveConfigPath('user', process.cwd()),
      sideline: false,
      warn: () => {},
    });
    return cfg.value.appearance?.preview?.autoOpen ?? true;
  } catch (err) {
    process.stderr.write(
      `[preview-url] readUserAutoOpen failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return true;
  }
}

function noSingleFileSessionMessage(file: string): string {
  return `No Open Knowledge session is serving ${file} yet. On a host with a terminal, \`ok open ${file}\` starts one; otherwise open ${file} in the OK Desktop app. Then retry.`;
}

function serverExplicitlyLacksUi(lockDir: string): boolean {
  try {
    const lock = readServerLock(lockDir);
    if (lock === null || lock.port <= 0 || !isProcessAlive(lock.pid)) return false;
    return !lockAdvertisesUi(lock);
  } catch (err) {
    process.stderr.write(
      `[preview-url] readServerLock failed at ${lockDir} while checking ui capability: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

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

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9._/@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
      file?: string;
      cwd?: string;
    }) => {
      if ([args.document, args.folder, args.skill, args.file].filter((t) => t != null).length > 1) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Error: document, folder, skill, and file are mutually exclusive — pass at most one.',
            },
          ],
        };
      }

      if (args.file) {
        if (!isAbsolute(args.file)) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Error: file must be an absolute path (a loose file outside a project has no cwd to anchor a relative path).',
              },
            ],
          };
        }
        const fileAutoOpen = (deps.resolveUserAutoOpen ?? readUserAutoOpen)();
        const resolverDeps = deps.offCwdResolverDeps ?? createOffCwdResolverDeps();
        let hit = await resolveOffCwdTarget(args.file, resolverDeps);
        if (hit === null && deps.ensureSingleFileSession) {
          const booted = await deps.ensureSingleFileSession(args.file).catch((err) => {
            process.stderr.write(
              `[preview-url] ensureSingleFileSession failed for ${args.file}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            return false;
          });
          if (booted) hit = await resolveOffCwdTarget(args.file, resolverDeps);
        }
        if (hit !== null) {
          const url = `${hit.baseUrl}/#/${encodeDocName(hit.docName)}`;
          return textPlusStructured(`Preview URL: ${url}`, {
            url,
            baseUrl: hit.baseUrl,
            running: true,
            autoOpen: fileAutoOpen,
          });
        }
        return textPlusStructured(noSingleFileSessionMessage(args.file), {
          url: null,
          baseUrl: null,
          running: false,
          autoOpen: fileAutoOpen,
        });
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

      const okOpenCommand = args.document
        ? `ok open ${shellQuoteArg(args.document)}`
        : args.folder
          ? `ok open ${shellQuoteArg(args.folder)}`
          : args.skill
            ? `ok open ${args.skill.name} --skill${args.skill.scope === 'global' ? ' --scope global' : ''}`
            : null;
      const hostedAgentSteer =
        deps.isHostedAgent && okOpenCommand
          ? `You're running inside OpenKnowledge — run \`${okOpenCommand}\` to bring this up for the user. Don't navigate the URL below, open a browser, or paste the URL into your reply; it's for reference only.\n\n`
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
        const hint = !isServerLive(lockDir)
          ? `${NO_SERVER_MESSAGE}${autoStartDisabled ? AUTOSTART_DISABLED_NOTE : ''}`
          : serverExplicitlyLacksUi(lockDir)
            ? NO_UI_NONE_MOUNTED_MESSAGE
            : NO_UI_SERVER_RUNNING_MESSAGE;
        return textPlusStructured(`${hostedAgentSteer}${hint}`, {
          url: null,
          baseUrl: null,
          running: false,
          autoOpen,
          okOpenCommand: deps.isHostedAgent ? okOpenCommand : null,
        });
      }

      const url = routeFragment ? `${baseUrl}/${routeFragment}` : baseUrl;

      return textPlusStructured(`${hostedAgentSteer}Preview URL: ${url}`, {
        url,
        baseUrl,
        running: true,
        autoOpen,
        okOpenCommand: deps.isHostedAgent ? okOpenCommand : null,
      });
    },
  );
}
