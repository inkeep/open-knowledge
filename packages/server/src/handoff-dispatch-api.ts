
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
    quitFirst: true,
  },
  cursor: {
    type: 'cli-binary',
    binaryName: 'cursor',
    urlScheme: 'cursor:',
  },
} as const satisfies Record<Exclude<HandoffTarget, 'opencode'>, Recipe>;

const TARGET_VALUES = Object.keys(RECIPES) as [
  Exclude<HandoffTarget, 'opencode'>,
  ...Exclude<HandoffTarget, 'opencode'>[],
];
const HandoffRequestSchema = z.object({
  target: z.enum(TARGET_VALUES),
  url: z.string().min(1).max(4096),
  workspacePath: z.string().optional(),
});

const HandoffSuccessSchema = z.object({}).loose();

export interface HandleHandoffDispatchDeps {
  readonly contentDir: string;
  readonly platform: NodeJS.Platform;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly spawnDetached?: (
    exec: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) => Promise<SpawnDetachedOutcome>;
  readonly resolveCursorBinary?: (timeoutMs: number) => Promise<string | null>;
  readonly isSchemeRegistered?: (scheme: InstalledAgentScheme) => Promise<boolean>;
}

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
      if (recipe.quitFirst) {
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
