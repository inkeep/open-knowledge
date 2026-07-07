/**
 * POST /api/handoff — unified server-side orchestration for the
 * Open-in-Agent dropdown.
 *
 * Owns the entire "open this doc in app X" recipe per target, including
 * shell-outs that the renderer can't do directly (the OS protocol opener,
 * `osascript ... to quit` on macOS, `cursor <path>`). Used by both web-host
 * and Electron-host renderers — the renderer's `fetch` works against this
 * endpoint identically in both modes because Electron embeds the same
 * Hocuspocus/Vite server the CLI serves on web.
 *
 * Cross-platform: handoff dispatch works on macOS, Windows, and Linux, at
 * parity with the cross-platform install detection in `./handoff-api.ts`
 * (which probes scheme registration via `osascript` / `reg query HKCR` /
 * `xdg-mime`). This file owns the dispatch step; that file owns the "which
 * targets to render in the dropdown" probe.
 *
 * Recipe-per-target architecture (the final "open the protocol URL" step is
 * platform-resolved by `resolveUrlOpenInvocation`: macOS `/usr/bin/open`,
 * Windows `rundll32`, Linux `xdg-open`):
 *   - **app-bundle** (Claude / Codex):
 *       - macOS: `[osascript-quit?] → sleep → open -a <AppName> → sleep →
 *         open URL`. `open -a` doubles as the availability gate (a missing
 *         app surfaces as `not-installed`) and the activation that warms the
 *         URL dispatcher. The quit-first step is empirically required for
 *         Codex; Claude inherits the shape (no quit) for safety.
 *       - Windows / Linux: `probe scheme registration → open URL`. There is
 *         no `open -a` equivalent, and the OS protocol dispatch launches +
 *         foregrounds the registered handler on its own — so the explicit
 *         scheme probe (the same one `/api/installed-agents` uses) stands in
 *         for the `open -a` ENOENT availability signal. Without it, a target
 *         the user hasn't installed would dispatch a no-op the renderer
 *         reports as a successful launch.
 *   - **cli-binary** (Cursor): `<cursor> <workspacePath> → sleep → open URL`
 *     on every platform. The resolved `cursor` binary's presence is the
 *     availability gate (no scheme probe needed); the CLI handles workspace
 *     switching directly and the URL just seeds the prompt.
 *
 * Security model:
 *   - Loopback-only gating applied by the caller (`checkLocalOpSecurity`
 *     in `api-extension.ts`'s route wrapper).
 *   - App-name allowlist (`'Claude' | 'Codex'`) and binary allowlist
 *     (`'cursor'` via `resolveCursorBinaryDefault`) bound the set of
 *     processes the renderer can spawn.
 *   - URL scheme must match the target's expected scheme (claude:// for
 *     Claude, codex:// for Codex, cursor:// for Cursor).
 *   - Cursor's `workspacePath` is validated against `contentDir`
 *     (`isPathWithinDir`) to prevent steering Cursor at arbitrary
 *     filesystem locations.
 *   - All spawns use `shell: false` + argv-array + `detached: true` +
 *     `stdio: 'ignore'` + `unref()`. The Windows URL opener is `rundll32`
 *     (a real executable), never `cmd /c start`, so the literal `&` between
 *     URL query params can't be parsed as a shell command separator — see
 *     `resolveUrlOpenInvocation`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandoffTarget } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { createOsProbe, type InstalledAgentScheme } from './handoff-api.ts';
import { errorResponse } from './http/error-response.ts';
import {
  PayloadTooLargeError,
  RequestBodyTimeoutError,
  readBoundedJsonBody,
} from './http/request-validation.ts';
import { successResponse } from './http/success-response.ts';
import {
  isPathWithinDir,
  resolveCursorBinaryDefault,
  resolveCursorSpawnInvocation,
} from './spawn-cursor-api.ts';
import { type SpawnDetachedOutcome, spawnDetached as spawnDetachedReal } from './spawn-detached.ts';

const HANDLER = 'handoff';
const HANDOFF_MAX_BODY_BYTES = 4 * 1024;
const HANDOFF_BODY_READ_TIMEOUT_MS = 5_000;
const SPAWN_TIMEOUT_MS = 2_000;
const WHICH_TIMEOUT_MS = 500;
const QUIT_SETTLE_MS = 3_000;
const APP_BUNDLE_SETTLE_MS = 5_000;
const CURSOR_SETTLE_MS = 1_500;

/**
 * Recipe table — one entry per `HandoffTarget`. Drives the dispatch loop
 * below. Adding a 5th target is a 3-step change:
 *   (1) Add the target to `HandoffTarget` in `packages/core/src/handoff/types.ts`.
 *   (2) Append the recipe here — TypeScript fails the build until done
 *       because of the `Record<HandoffTarget, Recipe>` exhaustiveness gate.
 *   (3) Add a URL builder + switch case in renderer-side `dispatch.ts`.
 *
 * Two recipe shapes today — `app-bundle` (Claude, Codex) and `cli-binary`
 * (Cursor); per-platform step ordering is documented in the file header.
 */
type Recipe =
  | {
      readonly type: 'app-bundle';
      readonly appName: 'Claude' | 'Codex';
      readonly urlScheme: 'claude:' | 'codex:';
      /** Scheme name (no colon) for the Windows/Linux availability probe —
       *  the `InstalledAgentScheme` key `/api/installed-agents` keys off. */
      readonly probeScheme: InstalledAgentScheme;
      readonly quitFirst: boolean;
    }
  | {
      readonly type: 'cli-binary';
      readonly binaryName: 'cursor';
      readonly urlScheme: 'cursor:';
    };

const RECIPES = {
  'claude-cowork': {
    type: 'app-bundle',
    appName: 'Claude',
    urlScheme: 'claude:',
    probeScheme: 'claude',
    quitFirst: false,
  },
  'claude-code': {
    type: 'app-bundle',
    appName: 'Claude',
    urlScheme: 'claude:',
    probeScheme: 'claude',
    quitFirst: false,
  },
  codex: {
    type: 'app-bundle',
    appName: 'Codex',
    urlScheme: 'codex:',
    probeScheme: 'codex',
    // Codex's URL handler only honors workspace switches reliably on a
    // freshly-launched instance. A plain `open -a` against a still-running
    // or recently-quit-but-lingering instance leaves the dispatcher in a
    // state where the workspace URL gets ignored. The quit-first step
    // forces a clean cold-start; empirically required (user-verified).
    quitFirst: true,
  },
  cursor: {
    type: 'cli-binary',
    binaryName: 'cursor',
    urlScheme: 'cursor:',
  },
  // `opencode` is intentionally absent: it is a terminal-only target with no
  // URL scheme, dispatched via the terminal-CLI path (`requestTerminalLaunch`),
  // never this deep-link endpoint. It is excluded from the exhaustiveness gate
  // via `Exclude<…, 'opencode'>` so the build does not demand a (nonexistent)
  // URL recipe for it.
} as const satisfies Record<Exclude<HandoffTarget, 'opencode'>, Recipe>;

// Narrowed to the URL-dispatchable subset: `RECIPES` omits the terminal-only
// `opencode` target, so its keys (and the parsed `target`) exclude it, keeping
// the `RECIPES[target]` lookup below exhaustive at the type level.
const TARGET_VALUES = Object.keys(RECIPES) as [
  Exclude<HandoffTarget, 'opencode'>,
  ...Exclude<HandoffTarget, 'opencode'>[],
];
const HandoffRequestSchema = z.object({
  target: z.enum(TARGET_VALUES),
  url: z.string().min(1).max(4096),
  workspacePath: z.string().optional(),
});

// `.loose()` so future additive fields (e.g. an echo of the dispatched
// target / duration / detected-app-version) don't break the response shape
// or strip data on parse. Body is `{}` today; the laxity is forward-compat
// insurance, not a current consumer.
const HandoffSuccessSchema = z.object({}).loose();

export interface HandleHandoffDispatchDeps {
  readonly contentDir: string;
  readonly platform: NodeJS.Platform;
  /** Test seam — defaults to wall-clock setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — defaults to detached `child_process.spawn` + unref. */
  readonly spawnDetached?: (
    exec: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) => Promise<SpawnDetachedOutcome>;
  /** Test seam — defaults to `resolveCursorBinaryDefault`. */
  readonly resolveCursorBinary?: (timeoutMs: number) => Promise<string | null>;
  /**
   * Windows/Linux availability gate for `app-bundle` targets: does the OS have
   * a registered handler for the scheme? Defaults to `createOsProbe(platform)`
   * (the same `reg query HKCR` / `xdg-mime` probe `/api/installed-agents`
   * uses). `api-extension.ts` wires the shared cached probe instance so the
   * dispatch gate agrees with the dropdown's render gate and reuses its TTL.
   * Unused on macOS — there `open -a`'s ENOENT is the availability signal.
   */
  readonly isSchemeRegistered?: (scheme: InstalledAgentScheme) => Promise<boolean>;
}

/**
 * Re-export the shared spawn outcome so consumers (renderer tests, fixture
 * mocks) keep importing from this module without depending directly on
 * `./spawn-detached.ts`. The renderer maps these to `HandoffOutcome` at the
 * wire boundary via HTTP status; this is the in-process internal shape.
 */
export type { SpawnDetachedOutcome as SpawnOutcome } from './spawn-detached.ts';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleHandoffDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleHandoffDispatchDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: HANDLER,
      extraHeaders: { Allow: 'POST' },
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readBoundedJsonBody(req, {
      maxBytes: HANDOFF_MAX_BODY_BYTES,
      timeoutMs: HANDOFF_BODY_READ_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      errorResponse(res, 413, 'urn:ok:error:payload-too-large', 'Payload too large.', {
        handler: HANDLER,
        cause: err,
      });
      return;
    }
    if (err instanceof RequestBodyTimeoutError) {
      errorResponse(res, 408, 'urn:ok:error:request-timeout', 'Request body read timed out.', {
        handler: HANDLER,
        cause: err,
      });
      return;
    }
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read request body.', {
      handler: HANDLER,
      cause: err,
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch (err) {
    errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Malformed JSON body.', {
      handler: HANDLER,
      cause: err,
    });
    return;
  }

  const reqResult = HandoffRequestSchema.safeParse(parsed);
  if (!reqResult.success) {
    errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid request body.', {
      handler: HANDLER,
    });
    return;
  }
  const { target, url, workspacePath } = reqResult.data;

  // Lookup is exhaustive — `RECIPES: Record<HandoffTarget, Recipe>` plus
  // Zod-validated target above means the entry is always present at runtime.
  const recipe = RECIPES[target];
  if (!url.startsWith(recipe.urlScheme)) {
    errorResponse(
      res,
      400,
      'urn:ok:error:invalid-request',
      `URL scheme must be ${recipe.urlScheme} for target ${target}.`,
      { handler: HANDLER },
    );
    return;
  }

  const sleep = deps.sleep ?? defaultSleep;
  const spawn = deps.spawnDetached ?? spawnDetachedReal;
  const isSchemeRegistered = deps.isSchemeRegistered ?? createOsProbe(deps.platform);

  if (recipe.type === 'app-bundle') {
    if (deps.platform === 'darwin') {
      // macOS fuses availability-detection and activation into `open -a`: a
      // missing app surfaces as `not-installed`, and a present one is brought
      // to the foreground so the subsequent URL dispatch lands on a warm
      // dispatcher.
      if (recipe.quitFirst) {
        // Best-effort quit — if the app wasn't running, `to quit` no-ops cleanly.
        // Don't abort the recipe on quit failure; spawn handles a still-running
        // app gracefully (it activates instead of relaunching).
        await spawn(
          '/usr/bin/osascript',
          ['-e', `tell application "${recipe.appName}" to quit`],
          SPAWN_TIMEOUT_MS,
        ).catch(() => undefined);
        await sleep(QUIT_SETTLE_MS);
      }

      const activate = await spawn('/usr/bin/open', ['-a', recipe.appName], SPAWN_TIMEOUT_MS);
      if (!activate.ok) {
        emitSpawnFailure(res, target, activate.reason);
        return;
      }
      await sleep(APP_BUNDLE_SETTLE_MS);
    } else {
      // Windows / Linux have no `open -a` equivalent, and the OS protocol
      // dispatch below launches + foregrounds the registered handler on its
      // own — so there is no separate activation step. The explicit scheme
      // probe stands in for the availability signal macOS gets for free from
      // `open -a`'s ENOENT: without it, dispatching to an unregistered scheme
      // is a silent no-op the renderer reports as a successful launch.
      const registered = await isSchemeRegistered(recipe.probeScheme);
      if (!registered) {
        errorResponse(
          res,
          422,
          'urn:ok:error:handoff-target-not-installed',
          'Required binary or application not found.',
          { handler: HANDLER, extensions: { target } },
        );
        return;
      }
    }

    const open = resolveUrlOpenInvocation(url, deps.platform);
    const openUrl = await spawn(open.exec, open.args, SPAWN_TIMEOUT_MS);
    if (!openUrl.ok) {
      emitSpawnFailure(res, target, openUrl.reason);
      return;
    }
    successResponse(res, 200, HandoffSuccessSchema, {}, { handler: HANDLER });
    return;
  }

  // recipe.type === 'cli-binary' (Cursor)
  if (!workspacePath) {
    errorResponse(
      res,
      400,
      'urn:ok:error:invalid-request',
      'workspacePath is required for cursor handoff.',
      { handler: HANDLER },
    );
    return;
  }
  if (!isPathWithinDir(workspacePath, deps.contentDir, deps.platform)) {
    errorResponse(res, 403, 'urn:ok:error:path-escape', 'Path escapes the content directory.', {
      handler: HANDLER,
    });
    return;
  }
  const resolveCursorBinary = deps.resolveCursorBinary ?? resolveCursorBinaryDefault;
  const cursorBin = await resolveCursorBinary(WHICH_TIMEOUT_MS);
  if (!cursorBin) {
    errorResponse(
      res,
      422,
      'urn:ok:error:handoff-target-not-installed',
      'Cursor CLI not found on this machine.',
      { handler: HANDLER, extensions: { target: 'cursor' } },
    );
    return;
  }
  const invocation = resolveCursorSpawnInvocation(cursorBin, workspacePath, deps.platform);
  const spawnBinary = await spawn(invocation.exec, invocation.args, SPAWN_TIMEOUT_MS);
  if (!spawnBinary.ok) {
    emitSpawnFailure(res, target, spawnBinary.reason);
    return;
  }
  await sleep(CURSOR_SETTLE_MS);
  const open = resolveUrlOpenInvocation(url, deps.platform);
  const openUrl = await spawn(open.exec, open.args, SPAWN_TIMEOUT_MS);
  if (!openUrl.ok) {
    emitSpawnFailure(res, target, openUrl.reason);
    return;
  }
  successResponse(res, 200, HandoffSuccessSchema, {}, { handler: HANDLER });
}

/**
 * Resolve the `exec` + argv for opening a protocol URL via the OS's registered
 * handler, per platform. Mirrors `resolveCursorSpawnInvocation`'s shape so the
 * two platform-dispatch helpers read the same way.
 *
 *   - **macOS** — `/usr/bin/open <url>`: Launch Services routes the scheme to
 *     its registered handler.
 *   - **Windows** — `rundll32.exe url.dll,FileProtocolHandler <url>`: invokes
 *     `ShellExecute` on the URL, which resolves the handler from
 *     `HKCR\<scheme>\shell\open\command`. Chosen over `cmd /c start "" <url>`
 *     deliberately: `start` is a `cmd` builtin, so it would require spawning
 *     `cmd.exe`, and `cmd` treats the literal `&` that separates URL query
 *     params as a command separator — both a correctness break (the URL is
 *     truncated at the first `&`) and a shell-injection footgun. `rundll32` is
 *     a real executable, so `spawn(..., { shell: false })` passes the URL as a
 *     single inert argv element with no shell parsing.
 *   - **Linux / other** — `xdg-open <url>`: the freedesktop opener. Unknown
 *     platforms fall through here, matching `createOsProbe`'s convention.
 *
 * Exported for unit assertions.
 */
export function resolveUrlOpenInvocation(
  url: string,
  platform: NodeJS.Platform,
): { exec: string; args: ReadonlyArray<string> } {
  if (platform === 'darwin') return { exec: '/usr/bin/open', args: [url] };
  if (platform === 'win32') {
    return { exec: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { exec: 'xdg-open', args: [url] };
}

function emitSpawnFailure(
  res: ServerResponse,
  target: HandoffTarget,
  reason: 'not-installed' | 'timeout' | 'spawn-error',
): void {
  switch (reason) {
    case 'not-installed':
      errorResponse(
        res,
        422,
        'urn:ok:error:handoff-target-not-installed',
        'Required binary or application not found.',
        { handler: HANDLER, extensions: { target } },
      );
      return;
    case 'timeout':
      errorResponse(
        res,
        504,
        'urn:ok:error:handoff-spawn-timeout',
        'Handoff spawn exceeded the deadline.',
        { handler: HANDLER, extensions: { target } },
      );
      return;
    case 'spawn-error':
      errorResponse(res, 502, 'urn:ok:error:handoff-spawn-failed', 'Handoff spawn failed.', {
        handler: HANDLER,
        extensions: { target },
      });
      return;
    default:
      assertNeverReason(reason);
  }
}

function assertNeverReason(_reason: never): never {
  throw new Error(`Unhandled spawn reason: ${String(_reason)}`);
}
