/**
 * `preview_url` MCP tool — resolve the browser-reachable preview URL.
 *
 * Filename keeps the `get-` prefix even though the tool dropped it: the natural
 * target `preview-url.ts` is already taken by the shared URL-building utility
 * this module imports from. The file/tool-name mismatch is deliberate.
 *
 * Per-response payloads carry a route-only `previewUrl` (`/#/{doc}`) — no
 * scheme, host, or port. This tool is the one place an agent reaches
 * deliberately to get the browser base + a full, openable URL.
 *
 * Use it for hosts that open the URL themselves: an agent with an in-app
 * browser navigates that browser to the returned `url`; a stdio host with no
 * browser tool can `open <url>` as a last resort. Hosts with a preview pane
 * (Claude Code Desktop) use `preview_start("open-knowledge-ui")` instead; the
 * Claude Code CLI uses `ok open <doc>` to open in the OK Desktop app.
 *
 * Opening a preview counts as demand for a backend: when the registration
 * threads `serverUrl` (the global stdio MCP does), the handler runs the same
 * backend-ensure the server-backed tools use — a live `server.lock` resolves
 * immediately; otherwise the resolver auto-spawns `ok start` (which spawns
 * the `ok ui` sibling) under the `OK_MCP_AUTOSTART` gate and spawn timeout.
 * Registrations without server authority (no `serverUrl` in deps) answer
 * from disk alone, as before.
 *
 * Read-mostly EXCEPT when `armPaneTarget: true` — that flag writes a
 * TTL-bounded pane-target file under `.ok/local/` (hence
 * `readOnlyHint: false`) — and except for the demand-spawn above. Idempotent:
 * re-arming the same target is a no-op-equivalent overwrite, and repeated
 * calls converge on the same running backend.
 *
 * Input: `{ document?, folder?, armPaneTarget?, cwd? }` — `document` XOR `folder`
 *        selects the deep-link route (else the UI root); `armPaneTarget` arms it
 *        for a later Claude-pane base-open.
 * Output: `structuredContent: { url, baseUrl, running, autoOpen }` + a text body.
 */

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
  'This is THE way to open a doc OR a loose file in a browser, and the only way to force a browser when the OK Desktop app is installed (the `ok open` CLI prefers Desktop). Use it when YOUR host opens the URL itself: navigate your in-app / embedded browser to the returned `url`, or — only on a stdio host with no browser tool — `open` it in the system browser. Do not hunt for the URL via `ok ps`/`ok status` or by guessing a port — this tool returns it. Hosts with a preview pane (Claude Code Desktop) call `preview_start("open-knowledge-ui")` instead; a pure stdio CLI with no browser uses `ok open <doc>` to open in the OK Desktop app.',
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
  '- `armPaneTarget` (optional) — When true with a `document`/`folder`/`skill`, writes a small TTL-bounded (~30s) state file under `.ok/local/` so a later Claude-pane base-open lands on that target. Independent of server state; omit it and the call writes nothing.',
  '- `cwd` (optional) — Project root (see `cwd` description below).',
].join('\n');

interface GetPreviewUrlDeps {
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  /**
   * True when this MCP server runs inside OK Desktop's own built-in terminal
   * (`OK_DESKTOP_TERMINAL=1`). When set, the doc/folder/skill responses lead
   * with a steer to run `ok open <target>` (which focuses the OK Desktop
   * window) rather than navigating the returned URL — the terminal agent has
   * no business opening a browser. Absent/false everywhere else (the shared
   * collab server, Cursor/Codex, plain CLI), so those paths are unchanged.
   */
  isDesktopTerminal?: boolean;
  /**
   * Hocuspocus URL (or per-call resolver). When present, a preview request
   * is treated as demand for a backend: the resolver's auto-spawn path
   * brings up `ok start` before `ui.lock` is read. Absent in registration
   * contexts without server authority — the tool then answers from disk
   * alone.
   */
  serverUrl?: ServerUrlOrResolver;
  /** Cold-spawn `ui.lock` wait overrides — tests only. */
  uiBindWait?: { timeoutMs?: number; pollIntervalMs?: number };
  /**
   * Off-cwd resolver deps for the `file` branch (find the running session that
   * serves an out-of-project file). Injected in tests; defaults to the
   * production `createOffCwdResolverDeps()` surface.
   */
  offCwdResolverDeps?: OffCwdResolverDeps;
  /**
   * Boot-on-demand for the `file` branch: when no session yet serves the file,
   * start one (a detached headless `ok <file>`) and resolve true once it
   * registers. Provided only by registrations with spawn authority (the CLI
   * MCP); absent → the file branch returns the `ok open` hint instead of
   * booting.
   */
  ensureSingleFileSession?: (absFile: string) => Promise<boolean>;
  /** Resolve the user-scoped autoOpen preference for the `file` branch (tests inject). */
  resolveUserAutoOpen?: () => boolean;
}

/**
 * How long to wait for the freshly spawned backend's `ok ui` sibling to bind
 * before reporting no-UI. Mirrors `uiBindTimeoutMs` in `bootStartServer` —
 * the server's own wait for the same sibling — so the two surfaces give up
 * at the same horizon.
 */
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
      'Skill to resolve an editor preview URL for; returns the `…/#/__skill__/<scope>/<name>` route. Mutually exclusive with `document`/`folder`/`file`.',
    ),
  file: z
    .string()
    .optional()
    .describe(
      'Absolute path to a single markdown file to open, including one OUTSIDE any Open Knowledge project. Resolves to the running single-file (or worktree) session whose content directory contains it and returns that session’s `url`. Mutually exclusive with `document` / `folder` / `skill`. When `file` is set, `cwd` is ignored.',
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
  okOpenCommand: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Machine-readable form of the desktop-terminal steer: when this MCP server runs inside OK Desktop’s built-in terminal AND a doc/folder/skill target was given, the exact `ok open …` command to run to focus it in the OK Desktop window. Prefer running it over navigating `url`. `null`/absent in every other context (navigate `url` per your host instead).',
    ),
});

/**
 * Recovery hints for the two distinguishable no-UI states. The server-running
 * variant advises `ok ui` (the server exists; only the UI is missing — bare
 * `ok start` would exit with an already-running collision there). The
 * no-server variant advises `ok start`, which brings up server + UI sibling
 * together; `ok ui` alone in that state produces a backend-less UI shell.
 */
const NO_UI_SERVER_RUNNING_MESSAGE =
  'The OK server is running but no UI has bound for this project yet. Retry in a few seconds, or start one: `ok ui` (terminal), `preview_start("open-knowledge-ui")` (Claude Code Desktop), or open the project in OK Electron.';
const NO_SERVER_MESSAGE =
  'No OpenKnowledge server is running for this project. Start it with `ok start` (also starts the preview UI), use `preview_start("open-knowledge-ui")` (Claude Code Desktop), or open the project in OK Electron.';
const AUTOSTART_DISABLED_NOTE = ' Auto-start is disabled (OK_MCP_AUTOSTART=0).';
/**
 * Resolve `appearance.preview.autoOpen` for the out-of-project `file` branch.
 * A loose file has no project config, so read the USER-scoped config
 * (`~/.ok/config.yml`); `readConfigSafely` applies schema defaults (autoOpen
 * defaults to `true`) and never throws, so a missing file yields `true`.
 */
function readUserAutoOpen(): boolean {
  try {
    const cfg = readConfigSafely({
      absPath: resolveConfigPath('user', process.cwd()),
      sideline: false,
      warn: () => {},
    });
    return cfg.value.appearance?.preview?.autoOpen ?? true;
  } catch (err) {
    // readConfigSafely is documented not to throw; an exception here is
    // unexpected. Log it (like isServerLive) rather than silently defaulting,
    // so a genuinely broken user config is observable. Default stays `true`.
    process.stderr.write(
      `[preview-url] readUserAutoOpen failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return true;
  }
}

/** No running session serves the requested out-of-project `file`. */
function noSingleFileSessionMessage(file: string): string {
  return `No Open Knowledge session is serving ${file} yet. On a host with a terminal, \`ok open ${file}\` starts one; otherwise open ${file} in the OK Desktop app. Then retry.`;
}

/** Live server check — same lock+liveness criteria the MCP shim uses. */
function isServerLive(lockDir: string): boolean {
  try {
    const lock = readServerLock(lockDir);
    return lock !== null && lock.port > 0 && isProcessAlive(lock.pid);
  } catch (err) {
    // A permission/fs error here masquerades as "server not running" and
    // selects the wrong recovery hint — log it the way resolveUiInfo logs
    // its lock-read failures so the misdirection is observable.
    process.stderr.write(
      `[preview-url] readServerLock failed at ${lockDir} while checking server liveness: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

/**
 * Shell-quote a path argument for the `okOpenCommand` steer so an agent can run
 * it verbatim. Clean slug-ish paths (the common `specs/foo/SPEC` case) pass
 * through unquoted; a path with a space or other shell-significant character is
 * single-quoted with embedded single-quotes escaped. Skill names are already
 * constrained to `[a-z0-9-]` (SKILL_NAME_REGEX), so they never route here.
 */
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
        // NOT read-only: `armPaneTarget: true` writes a pane-target file under
        // `.ok/local/`, and the demand-ensure path can spawn `ok start`.
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args: {
      document?: string;
      folder?: string;
      skill?: { name: string; scope?: 'project' | 'global' };
      file?: string;
      armPaneTarget?: boolean;
      cwd?: string;
    }) => {
      // `document` / `folder` / `skill` / `file` are documented mutually
      // exclusive — enforce it rather than silently dropping one, so a "land on
      // this target" intent never resolves to the wrong route without a signal.
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

      // `file` is the out-of-project branch. It opens a loose markdown file that
      // may live outside any project, so it BYPASSES the project-config gate
      // below (which requires a project at cwd). Resolve the absolute path to a
      // running single-file / worktree session via off-cwd discovery; `cwd` is
      // ignored here. autoOpen has no project config to read for a loose file,
      // so it defaults to true (the user-scoped source is a later refinement).
      if (args.file) {
        // `file` must be absolute. A relative path has no project to anchor it
        // and would silently resolve against the MCP process cwd — reject it
        // with a clear message rather than opening the wrong file.
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
        // Boot-on-demand: no session serves this file yet → start one (when this
        // registration has spawn authority) and re-resolve once it registers.
        if (hit === null && deps.ensureSingleFileSession) {
          const booted = await deps.ensureSingleFileSession(args.file).catch((err) => {
            // ensureSingleFileSession is built to resolve false (not throw) on a
            // failed wait; an actual rejection is unexpected, so log it rather
            // than letting it read as an ordinary "no session" outcome.
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
      // Lock anchor is the project root (cwd), not contentDir — see server-factory.ts.
      const lockDir = resolveLockDir(context.cwd);
      const ctx: PreviewUrlContext = { lockDir };
      const autoOpen = context.config.appearance.preview.autoOpen;

      // Route fragment for the requested target (at most one of doc/folder/skill
      // is set — the mutual-exclusion guard above rejects passing more than one).
      const routeFragment = args.document
        ? `#/${encodeDocName(args.document)}`
        : args.folder
          ? `#/${encodeFolderRoute(args.folder)}`
          : args.skill
            ? `#/${encodeSkillRoute(args.skill.scope ?? 'project', args.skill.name)}`
            : null;

      // Desktop-terminal steer: this MCP process inherited `OK_DESKTOP_TERMINAL`
      // from OK Desktop's built-in terminal, so the agent is sitting in the app —
      // it should focus the page with `ok open` (which navigates the OK Desktop
      // window), NOT navigate this URL or open a browser. Lead the response with
      // the exact command. Only for an in-project doc/folder/skill target (the
      // `file` branch returns earlier; the root has nothing to `ok open`).
      const okOpenCommand = args.document
        ? `ok open ${shellQuoteArg(args.document)}`
        : args.folder
          ? `ok open ${shellQuoteArg(args.folder)}`
          : args.skill
            ? `ok open ${args.skill.name} --skill${args.skill.scope === 'global' ? ' --scope global' : ''}`
            : null;
      const desktopTerminalSteer =
        deps.isDesktopTerminal && okOpenCommand
          ? `You're in the OK Desktop terminal — run \`${okOpenCommand}\` to focus this in the OK Desktop window. Don't navigate the URL below or open a browser; it's for reference only.\n\n`
          : '';

      // Arm an explicit pane target so a subsequent Claude-pane base-open lands
      // here (TTL-bounded). Independent of whether a UI is currently running —
      // armed BEFORE the backend-ensure below so a pane open that races the
      // spawn still lands on the requested target. Best-effort: arming writes
      // to `.ok/local/`, which can fail (read-only mount, EACCES, ENOSPC); the
      // resolved URL below is valid regardless, so a failed arm must not sink
      // the whole tool call.
      if (args.armPaneTarget && routeFragment) {
        try {
          armPaneTarget(lockDir, routeFragment);
        } catch {
          // Swallow: arming is best-effort and the URL below is valid regardless.
          // When OTel is enabled the failure shows up as the fs.* span armPaneTarget
          // emits; with OTel off (the default) it is intentionally silent.
        }
      }

      // Arming with no resolvable target is a silent no-op an agent tends to
      // retry blindly — call it out in the text body so the mistake is visible.
      const armNote =
        args.armPaneTarget && !routeFragment
          ? ' (note: armPaneTarget was set but no document/folder/skill was given, so nothing was armed)'
          : '';

      // Demand-ensure: when this registration has server authority, run the
      // same backend-ensure the server-backed tools use. A live `server.lock`
      // resolves immediately (lock read, no HTTP); otherwise the resolver
      // auto-spawns `ok start` — which spawns the `ok ui` sibling — under the
      // `OK_MCP_AUTOSTART` gate and spawn timeout. Runs unconditionally (not
      // just when `ui.lock` is missing) so the orphan-UI state — a surviving
      // pane-spawned `ok ui` whose server idle-shut-down — gets its backend
      // back; the orphan re-attaches via its own `server.lock` polling.
      const serverWasLive = isServerLive(lockDir);
      let autoStartDisabled = false;
      if (deps.serverUrl !== undefined) {
        try {
          await resolveServerUrl(deps.serverUrl, context.cwd);
        } catch (err) {
          if (err instanceof AutoStartDisabledError) {
            // Operator opt-out is a chosen configuration, not a failure —
            // fall through to the normal not-running payload and name the knob.
            autoStartDisabled = true;
          } else {
            // Spawn failure/timeout is actionable (the spawn-error log rides
            // the message) — surface it as a tool error, matching how the
            // server-backed tools report the same resolver failure.
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
        // The backend came up during this call, so its `ok ui` sibling is
        // still binding — `ui.lock` lags `server.lock` by up to a few
        // seconds. Wait it out instead of reporting a no-UI state that is
        // about to stop being true.
        baseUrl = await awaitUiBaseUrl(ctx, {
          timeoutMs: deps.uiBindWait?.timeoutMs ?? UI_BIND_WAIT_TIMEOUT_MS,
          pollIntervalMs: deps.uiBindWait?.pollIntervalMs ?? UI_BIND_WAIT_POLL_MS,
        });
      }

      if (baseUrl === null) {
        const hint = isServerLive(lockDir)
          ? NO_UI_SERVER_RUNNING_MESSAGE
          : `${NO_SERVER_MESSAGE}${autoStartDisabled ? AUTOSTART_DISABLED_NOTE : ''}`;
        return textPlusStructured(`${desktopTerminalSteer}${hint}${armNote}`, {
          url: null,
          baseUrl: null,
          running: false,
          autoOpen,
          okOpenCommand: deps.isDesktopTerminal ? okOpenCommand : null,
        });
      }

      // baseUrl is non-null here (the lock is bound) — compose base + route.
      const url = routeFragment ? `${baseUrl}/${routeFragment}` : baseUrl;

      return textPlusStructured(`${desktopTerminalSteer}Preview URL: ${url}${armNote}`, {
        url,
        baseUrl,
        running: true,
        autoOpen,
        okOpenCommand: deps.isDesktopTerminal ? okOpenCommand : null,
      });
    },
  );
}
