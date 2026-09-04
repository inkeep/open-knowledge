import { type SpawnOptions, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  EmptyRequestSchema,
  LocalOpAuthCancelRequestSchema,
  LocalOpAuthEmptySuccessSchema,
  type LocalOpAuthHostRequest,
  LocalOpAuthHostRequestSchema,
  LocalOpAuthPatRequestSchema,
  LocalOpAuthPatSuccessSchema,
  LocalOpAuthSetIdentityRequestSchema,
  LocalOpAuthStatusSuccessSchema,
  type LocalOpCloneRequest,
  LocalOpCloneRequestSchema,
  LocalOpEmbeddingsMutationSuccessSchema,
  LocalOpEmbeddingsSetKeyRequestSchema,
  type LocalOpEmbeddingsTestResponse,
  LocalOpEmbeddingsTestResponseSchema,
  LocalOpOkInitRequestSchema,
  LocalOpOkInitResponseSchema,
} from '@inkeep/open-knowledge-core';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  LOCAL_OP_PIPE_STDIO_OPTIONS,
  withHiddenWindowsConsole,
} from '../child-process-windows-hide.ts';
import { getLocalDir } from '../config/paths.ts';
import {
  FileEmbeddingsBackend,
  probeEmbeddingEndpoint,
  type ResolvedSemanticConfig,
  resolveEmbeddingsCredential,
  type SemanticSearchService,
} from '../embeddings/index.ts';
import { isProjectRoot } from '../fs/find-project-root.ts';
import { withParentLock } from '../git-handle.ts';
import { writeGitIdentity } from '../git-identity.ts';
import { initContent } from '../init-project.ts';
import {
  type ConcurrencyGuard,
  expandTilde,
  isAllowedGitUrl,
  isSafeLocalPath,
} from '../local-op-security.ts';
import {
  type AuthEvent,
  cachedGhBinaryPath,
  classifyCloneError,
  runCloneSubprocess,
  runDeviceFlowSubprocess,
  runGhDeviceLoginSubprocess,
  runPatSubprocess,
} from '../local-ops/index.ts';
import type { PinoLogger } from '../logger.ts';
import { originGitHubHost } from '../share/git-context.ts';
import { redactShareSubprocessStderr } from '../share/publish.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { resolveUiRedirectPort } from '../ui-redirect-port.ts';
import { type ApiRouteGroup, type ApiRouteRecord, createApiRouteGroup } from './api-pipeline.ts';
import { catchErrors } from './catch-errors.ts';
import { createStreamingErrorWriter, errorResponse } from './error-response.ts';
import { withValidation } from './request-validation.ts';
import { successResponse } from './success-response.ts';

function onAuthCredentialLanded(getSyncEngine?: () => SyncEngine | null): void {
  const engine = getSyncEngine?.();
  if (!engine) return;
  void engine.notifyCredentialsChanged().catch(() => {});
  void engine.refreshPushPermission().catch(() => {});
}

export function resumeSyncOnAuthEvent(
  event: AuthEvent,
  getSyncEngine?: () => SyncEngine | null,
): void {
  if (event.type !== 'complete') return;
  onAuthCredentialLanded(getSyncEngine);
}

export interface LocalOpRouteDeps {
  projectDir: string | undefined;
  contentDir: string;
  log: PinoLogger;
  checkLocalOpSecurity: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: { handler: string },
  ) => boolean;
  localOpCliArgs: string[];
  localOpGuard: ConcurrencyGuard;
  getSyncEngine: (() => SyncEngine | null) | undefined;
  authStreamHeartbeatMs: number | undefined;
  embeddingsSecretsFile: string | undefined;
  readSemanticProviderConfig: (() => ResolvedSemanticConfig) | undefined;
  semanticSearch: SemanticSearchService | undefined;
}

export function createLocalOpRoutes(deps: LocalOpRouteDeps): ApiRouteGroup {
  const {
    projectDir,
    contentDir,
    log,
    checkLocalOpSecurity,
    localOpCliArgs,
    localOpGuard,
    getSyncEngine,
    authStreamHeartbeatMs,
    embeddingsSecretsFile,
    readSemanticProviderConfig,
    semanticSearch,
  } = deps;

  const LOCAL_OP_CLONE_KEY = '/api/local-op/clone';
  const LOCAL_OP_OK_INIT_KEY = '/api/local-op/ok-init';
  const LOCAL_OP_TIMEOUT_MS = 10 * 60 * 1000;
  const LOCAL_OP_OPEN_TIMEOUT_MS = 45_000;
  const LOCAL_OP_STDERR_ONLY_OPTIONS: { stdio: ['ignore', 'ignore', 'pipe'] } = {
    stdio: ['ignore', 'ignore', 'pipe'],
  };
  const LOCAL_OP_IGNORED_STDIO_OPTIONS: Pick<SpawnOptions, 'stdio'> = {
    stdio: 'ignore',
  };

  const HANDLE_LOCAL_OP_CLONE = 'local-op-clone';
  const handleLocalOpClone = withValidation(LocalOpCloneRequestSchema, handleLocalOpCloneInner, {
    handler: HANDLE_LOCAL_OP_CLONE,
    method: 'POST',
    preBodyGate: (req, res) => checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_CLONE }),
  });
  async function handleLocalOpCloneInner(
    _req: IncomingMessage,
    res: ServerResponse,
    body: LocalOpCloneRequest,
  ): Promise<void> {
    const { url, dir, branch } = body;

    if (!isAllowedGitUrl(url)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:url-not-allowed',
        'URL protocol is not allowed for clone.',
        { handler: HANDLE_LOCAL_OP_CLONE, cause: new Error(`url=${url}`) },
      );
      return;
    }
    if (!isSafeLocalPath(dir)) {
      errorResponse(
        res,
        400,
        'urn:ok:error:dir-outside-home',
        'Clone destination must be within the user home directory.',
        { handler: HANDLE_LOCAL_OP_CLONE, cause: new Error(`dir=${dir}`) },
      );
      return;
    }

    if (!localOpGuard.tryAcquire(LOCAL_OP_CLONE_KEY)) {
      errorResponse(
        res,
        429,
        'urn:ok:error:concurrent-operation',
        'A clone operation is already in progress.',
        { handler: HANDLE_LOCAL_OP_CLONE, extraHeaders: { 'Retry-After': '30' } },
      );
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });

    const writeStreamError = createStreamingErrorWriter(res, HANDLE_LOCAL_OP_CLONE);

    let cloneCompleteDir: string | null = null;

    const flow = runCloneSubprocess({
      cliArgs: localOpCliArgs,
      url,
      dir,
      branch,
      timeoutMs: LOCAL_OP_TIMEOUT_MS,
      onEvent: (event) => {
        if (event.type === 'complete') {
          cloneCompleteDir = event.dir;
          return;
        }
        if (event.type === 'error') {
          if (event.message) {
            log.warn(
              { stderr: redactShareSubprocessStderr(event.message), url, dir },
              '[local-op/clone] clone failed',
            );
          }
          const classification = classifyCloneError(event.message ?? '');
          writeStreamError(500, 'urn:ok:error:clone-failed', classification.title, {
            detail: classification.detail || undefined,
            cause: event.message
              ? new Error(redactShareSubprocessStderr(event.message))
              : undefined,
          });
          return;
        }
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${JSON.stringify(event)}\n`);
          } catch {}
        }
      },
    });

    void (async () => {
      try {
        await flow.done;
        if (cloneCompleteDir && !res.writableEnded && !res.destroyed) {
          const result = await startServerAtDirAndGetPort(cloneCompleteDir);
          if (!res.writableEnded && !res.destroyed) {
            if ('port' in result) {
              res.write(
                `${JSON.stringify({ type: 'complete', port: result.port, dir: cloneCompleteDir })}\n`,
              );
            } else {
              writeStreamError(
                500,
                'urn:ok:error:server-start-failed',
                'Cloned successfully but failed to start the project server.',
                { cause: new Error(result.error) },
              );
            }
          }
        }
      } catch (err) {
        if (!res.writableEnded && !res.destroyed) {
          writeStreamError(
            500,
            'urn:ok:error:internal-server-error',
            'Unexpected error during clone post-processing.',
            { cause: err },
          );
        } else {
          log.error(
            { err, handler: HANDLE_LOCAL_OP_CLONE },
            'clone IIFE rejected after stream ended',
          );
        }
      } finally {
        if (!res.writableEnded) res.end();
        localOpGuard.release(LOCAL_OP_CLONE_KEY);
      }
    })();

    res.on('close', () => {
      flow.cancel();
    });
  }

  const SERVER_WITHOUT_UI_ERROR =
    'A server is already running for this directory without a web UI (started with `--only server`, or from a build without the bundled editor). Restart it with plain `ok start` from an install that includes the web UI.';

  async function startServerAtDirAndGetPort(
    dir: string,
  ): Promise<{ port: number } | { error: string }> {
    const absDir = resolve(expandTilde(dir));
    const lockDir = getLocalDir(absDir);

    const existing = resolveUiRedirectPort(lockDir);
    if (existing === 'no-ui') return { error: SERVER_WITHOUT_UI_ERROR };
    if (existing !== null) return { port: existing };

    const [cmd, ...baseArgs] = localOpCliArgs;

    const spawnAndAwaitServer = async (): Promise<{ port: number } | { error: string }> => {
      const child = spawn(
        cmd,
        [...baseArgs, 'start'],
        withHiddenWindowsConsole({
          ...LOCAL_OP_STDERR_ONLY_OPTIONS,
          cwd: absDir,
          detached: true,
          env: { ...process.env, OK_LOCK_KIND: 'interactive' },
        }),
      );

      const stderrChunks: Buffer[] = [];
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        log.warn(
          { cwd: absDir, msg: chunk.toString('utf-8').trim() },
          '[local-op/clone] child stderr',
        );
      });

      let earlyExitCode: number | null = null;
      let earlyExitSignal: NodeJS.Signals | null = null;
      let spawnErrorMessage: string | null = null;
      child.on('exit', (code, signal) => {
        earlyExitCode = code ?? -1;
        earlyExitSignal = signal ?? null;
      });
      child.on('error', (err) => {
        spawnErrorMessage = err.message;
        earlyExitCode = -1;
        log.error({ cwd: absDir, err }, '[local-op/clone] failed to spawn child');
      });

      child.unref();

      const deadline = Date.now() + LOCAL_OP_OPEN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await wait(500);
        const state = resolveUiRedirectPort(lockDir);
        if (state === 'no-ui') return { error: SERVER_WITHOUT_UI_ERROR };
        if (state !== null) return { port: state };
        if (earlyExitCode !== null) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
          const cause = spawnErrorMessage
            ? `spawn failed: ${spawnErrorMessage}`
            : earlyExitSignal
              ? `killed by ${earlyExitSignal}`
              : `code ${earlyExitCode}`;
          const winner = resolveUiRedirectPort(lockDir);
          if (winner === 'no-ui') return { error: SERVER_WITHOUT_UI_ERROR };
          if (winner !== null) return { port: winner };
          return {
            error: `\`ok start\` exited (${cause})${stderr ? ` — ${stderr}` : ''}`,
          };
        }
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      return {
        error: `Server did not start within the expected time${stderr ? ` — ${stderr}` : ''}`,
      };
    };

    return spawnAndAwaitServer();
  }

  const HANDLE_LOCAL_OP_OK_INIT = 'local-op-ok-init';
  const handleLocalOpOkInit = withValidation(
    LocalOpOkInitRequestSchema,
    async (_req, res, body) => {
      const { projectPath } = body;

      if (!isAbsolute(projectPath)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:invalid-request',
          'projectPath must be an absolute path.',
          {
            handler: HANDLE_LOCAL_OP_OK_INIT,
            cause: new Error(`projectPath=${projectPath}`),
          },
        );
        return;
      }

      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(projectPath);
      } catch (err) {
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          {
            ok: false,
            reason: 'not-a-git-worktree',
            message: `projectPath does not exist or is not accessible: ${(err as Error).message}`,
          },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
        return;
      }

      if (!isSafeLocalPath(canonicalPath)) {
        errorResponse(
          res,
          400,
          'urn:ok:error:dir-outside-home',
          'projectPath must be within the user home directory.',
          {
            handler: HANDLE_LOCAL_OP_OK_INIT,
            cause: new Error(`projectPath=${projectPath}`),
          },
        );
        return;
      }

      const gitDirKind = resolveGitDirDetailed(canonicalPath).kind;
      if (gitDirKind !== 'directory' && gitDirKind !== 'linked') {
        log.warn(
          { project: basename(canonicalPath), result: 'not-a-git-worktree', kind: gitDirKind },
          `[ok-init] action=init project=${basename(canonicalPath)} result=not-a-git-worktree kind=${gitDirKind}`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          {
            ok: false,
            reason: 'not-a-git-worktree',
            message: `projectPath is not a git working tree (.git is ${gitDirKind}).`,
          },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
        return;
      }

      if (isProjectRoot(canonicalPath)) {
        log.warn(
          { project: basename(canonicalPath), result: 'already-initialized' },
          `[ok-init] action=init project=${basename(canonicalPath)} result=already-initialized`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          { ok: true, projectPath: canonicalPath },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
        return;
      }

      if (!localOpGuard.tryAcquire(LOCAL_OP_OK_INIT_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An ok-init operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_OK_INIT, extraHeaders: { 'Retry-After': '2' } },
        );
        return;
      }

      try {
        await withParentLock(async () => {
          initContent(canonicalPath);
        });
        log.warn(
          { project: basename(canonicalPath), result: 'success' },
          `[ok-init] action=init project=${basename(canonicalPath)} result=success`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          { ok: true, projectPath: canonicalPath },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { project: basename(canonicalPath), result: 'failed', reason: message },
          `[ok-init] action=init project=${basename(canonicalPath)} result=failed reason=${message}`,
        );
        successResponse(
          res,
          200,
          LocalOpOkInitResponseSchema,
          { ok: false, reason: 'init-failed', message },
          { handler: HANDLE_LOCAL_OP_OK_INIT },
        );
      } finally {
        localOpGuard.release(LOCAL_OP_OK_INIT_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_OK_INIT,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_OK_INIT }),
    },
  );

  const LOCAL_OP_AUTH_LOGIN_KEY = '/api/local-op/auth/login';
  const LOCAL_OP_AUTH_STATUS_KEY = '/api/local-op/auth/status';
  const LOCAL_OP_AUTH_REPOS_KEY = '/api/local-op/auth/repos';
  const LOCAL_OP_AUTH_SIGNOUT_KEY = '/api/local-op/auth/signout';
  const LOCAL_OP_AUTH_PAT_KEY = '/api/local-op/auth/pat';
  const LOCAL_OP_AUTH_GH_LOGIN_KEY = '/api/local-op/auth/gh-login';

  const LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS = 30_000;

  const AUTH_STREAM_HEARTBEAT_MS = authStreamHeartbeatMs ?? 15_000;

  const AUTH_DEVICE_FLOW_TIMEOUT_MS = 16 * 60 * 1000;

  const defaultAuthHost = (): string => originGitHubHost(projectDir ?? contentDir);

  type StreamingAuthController = { done: Promise<void>; cancel(): void };
  const authLoginInFlight: { current: StreamingAuthController | null } = { current: null };
  const authGhLoginInFlight: { current: StreamingAuthController | null } = { current: null };

  function streamAuthFlow(cfg: {
    res: ServerResponse;
    handler: string;
    guardKey: string;
    inFlight: { current: StreamingAuthController | null };
    concurrentMessage: string;
    streamErrorMessage: string;
    makeFlow: (onEvent: (event: AuthEvent) => void) => StreamingAuthController;
  }): void {
    const { res, handler, guardKey, inFlight, concurrentMessage, streamErrorMessage, makeFlow } =
      cfg;

    if (!localOpGuard.tryAcquire(guardKey)) {
      const stale = inFlight.current;
      if (!stale) {
        console.error(
          JSON.stringify({
            event: 'ok-local-op:auth-flow-slot-no-controller',
            channel: 'auth',
            transport: 'http',
            handler,
          }),
        );
        errorResponse(res, 429, 'urn:ok:error:concurrent-operation', concurrentMessage, {
          handler,
          extraHeaders: { 'Retry-After': '5' },
        });
        return;
      }
      stale.cancel();
      inFlight.current = null;
      console.warn(
        JSON.stringify({
          event: 'ok-local-op:idempotent-start-replaced-stale-slot',
          channel: 'auth',
          transport: 'http',
          handler,
        }),
      );
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    const writeStreamError = createStreamingErrorWriter(res, handler);

    const writeLine = (line: string): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(line);
      } catch {}
    };

    let heartbeat: ReturnType<typeof setInterval> | null = setInterval(() => {
      writeLine(`${JSON.stringify({ type: 'ping' })}\n`);
    }, AUTH_STREAM_HEARTBEAT_MS);
    heartbeat.unref();
    const stopHeartbeat = (): void => {
      if (heartbeat === null) return;
      clearInterval(heartbeat);
      heartbeat = null;
    };

    const flow = makeFlow((event: AuthEvent) => {
      if (event.type === 'error') {
        writeStreamError(500, 'urn:ok:error:auth-failed', streamErrorMessage, {
          cause: event.message ? new Error(event.message) : undefined,
        });
        return;
      }
      resumeSyncOnAuthEvent(event, getSyncEngine);
      writeLine(`${JSON.stringify(event)}\n`);
    });
    inFlight.current = flow;

    const onClientClose = () => {
      stopHeartbeat();
      if (inFlight.current !== flow) return;
      console.warn(
        JSON.stringify({
          event: 'ok-local-op:auth-stream-detached',
          channel: 'auth',
          transport: 'http',
          handler,
        }),
      );
    };
    res.on('close', onClientClose);

    void flow.done.finally(() => {
      stopHeartbeat();
      res.off('close', onClientClose);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {}
      }
      if (inFlight.current === flow) {
        inFlight.current = null;
        localOpGuard.release(guardKey);
      }
    });
  }

  const HANDLE_LOCAL_OP_AUTH_LOGIN = 'local-op-auth-login';
  const handleLocalOpAuthLogin = withValidation(
    LocalOpAuthHostRequestSchema,
    handleLocalOpAuthLoginInner,
    {
      handler: HANDLE_LOCAL_OP_AUTH_LOGIN,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_LOGIN }),
    },
  );
  async function handleLocalOpAuthLoginInner(
    _req: IncomingMessage,
    res: ServerResponse,
    body: LocalOpAuthHostRequest,
  ): Promise<void> {
    const host = body.host ?? defaultAuthHost();
    streamAuthFlow({
      res,
      handler: HANDLE_LOCAL_OP_AUTH_LOGIN,
      guardKey: LOCAL_OP_AUTH_LOGIN_KEY,
      inFlight: authLoginInFlight,
      concurrentMessage: 'An auth login operation is already in progress.',
      streamErrorMessage: 'Auth subprocess reported an error.',
      makeFlow: (onEvent) =>
        runDeviceFlowSubprocess({
          cliArgs: localOpCliArgs,
          host,
          timeoutMs: AUTH_DEVICE_FLOW_TIMEOUT_MS,
          onEvent,
        }),
    });
  }

  const HANDLE_LOCAL_OP_AUTH_GH_LOGIN = 'local-op-auth-gh-login';
  const handleLocalOpAuthGhLogin = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();
      const ghPath = await cachedGhBinaryPath();
      if (ghPath === null) {
        errorResponse(
          res,
          400,
          'urn:ok:error:auth-failed',
          'The GitHub CLI (gh) is not installed.',
          { handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN },
        );
        return;
      }

      streamAuthFlow({
        res,
        handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN,
        guardKey: LOCAL_OP_AUTH_GH_LOGIN_KEY,
        inFlight: authGhLoginInFlight,
        concurrentMessage: 'A gh sign-in is already in progress.',
        streamErrorMessage: 'gh sign-in reported an error.',
        makeFlow: (onEvent) =>
          runGhDeviceLoginSubprocess({
            host,
            ghPath,
            timeoutMs: AUTH_DEVICE_FLOW_TIMEOUT_MS,
            onEvent,
          }),
      });
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_GH_LOGIN }),
    },
  );

  const HANDLE_LOCAL_OP_AUTH_CANCEL = 'local-op-auth-cancel';
  const handleLocalOpAuthCancel = withValidation(
    LocalOpAuthCancelRequestSchema,
    catchErrors(
      async (_req, res, body) => {
        const target =
          body.channel === 'gh-login'
            ? { inFlight: authGhLoginInFlight, guardKey: LOCAL_OP_AUTH_GH_LOGIN_KEY }
            : { inFlight: authLoginInFlight, guardKey: LOCAL_OP_AUTH_LOGIN_KEY };
        const flow = target.inFlight.current;
        if (flow) {
          flow.cancel();
          target.inFlight.current = null;
          localOpGuard.release(target.guardKey);
        }
        successResponse(
          res,
          200,
          LocalOpAuthEmptySuccessSchema,
          {},
          { handler: HANDLE_LOCAL_OP_AUTH_CANCEL },
        );
      },
      { handler: HANDLE_LOCAL_OP_AUTH_CANCEL, title: 'Failed to cancel the sign-in.' },
    ),
    {
      handler: HANDLE_LOCAL_OP_AUTH_CANCEL,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_CANCEL }),
    },
  );

  const HANDLE_LOCAL_OP_AUTH_STATUS = 'local-op-auth-status';
  const handleLocalOpAuthStatus = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_STATUS_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An auth status operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_STATUS, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        const [cmd, ...baseArgs] = localOpCliArgs;
        const spawnArgs = [...baseArgs, 'auth', 'status', '--json', '--host', host];

        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            cmd,
            spawnArgs,
            withHiddenWindowsConsole({
              ...LOCAL_OP_PIPE_STDIO_OPTIONS,
              env: { ...process.env },
            }),
          );
          let settled = false;
          const killTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill('SIGKILL');
            } catch {}
            child.stdout.destroy();
            child.stderr.destroy();
            reject(
              new Error(
                `auth status subprocess timed out after ${LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS}ms`,
              ),
            );
          }, LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS);
          killTimer.unref?.();
          const chunks: Buffer[] = [];
          child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            resolve(Buffer.concat(chunks).toString('utf-8'));
          });
          child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            reject(err);
          });
        });

        const lines = output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        let parsed: unknown = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i] as string);
            break;
          } catch {}
        }
        const ghAvailable = (await cachedGhBinaryPath()) !== null;
        if (parsed !== null) {
          successResponse(
            res,
            200,
            LocalOpAuthStatusSuccessSchema,
            { ...(parsed as Record<string, unknown>), ghAvailable },
            { handler: HANDLE_LOCAL_OP_AUTH_STATUS },
          );
        } else {
          successResponse(
            res,
            200,
            LocalOpAuthStatusSuccessSchema,
            { authenticated: false, ghAvailable },
            { handler: HANDLE_LOCAL_OP_AUTH_STATUS },
          );
        }
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:auth-failed', 'Auth status check failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_STATUS,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_STATUS_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_STATUS,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_STATUS }),
    },
  );

  const HANDLE_LOCAL_OP_AUTH_PAT = 'local-op-auth-pat';
  const handleLocalOpAuthPat = withValidation(
    LocalOpAuthPatRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_PAT_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An auth operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_PAT, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        const result = await runPatSubprocess({ cliArgs: localOpCliArgs, host, token: body.token });
        if (result.ok) {
          onAuthCredentialLanded(getSyncEngine);
          successResponse(
            res,
            200,
            LocalOpAuthPatSuccessSchema,
            { host: result.host, login: result.login },
            { handler: HANDLE_LOCAL_OP_AUTH_PAT },
          );
        } else {
          errorResponse(res, 400, 'urn:ok:error:auth-failed', result.error, {
            handler: HANDLE_LOCAL_OP_AUTH_PAT,
          });
        }
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:auth-failed', 'Storing the token failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_PAT,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_PAT_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_PAT,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_PAT }),
    },
  );

  const HANDLE_LOCAL_OP_AUTH_REPOS = 'local-op-auth-repos';
  const handleLocalOpAuthRepos = withValidation(
    LocalOpAuthHostRequestSchema,
    handleLocalOpAuthReposInner,
    {
      handler: HANDLE_LOCAL_OP_AUTH_REPOS,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_REPOS }),
    },
  );
  async function handleLocalOpAuthReposInner(
    _req: IncomingMessage,
    res: ServerResponse,
    body: LocalOpAuthHostRequest,
  ): Promise<void> {
    const host = body.host ?? defaultAuthHost();

    if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_REPOS_KEY)) {
      errorResponse(
        res,
        429,
        'urn:ok:error:concurrent-operation',
        'An auth repos operation is already in progress.',
        { handler: HANDLE_LOCAL_OP_AUTH_REPOS, extraHeaders: { 'Retry-After': '5' } },
      );
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });

    const writeStreamError = createStreamingErrorWriter(res, HANDLE_LOCAL_OP_AUTH_REPOS);

    const [cmd, ...baseArgs] = localOpCliArgs;
    const spawnArgs = [...baseArgs, 'auth', 'repos', '--json', '--host', host];

    let settled = false;
    let stdoutBuffer = '';
    const child = spawn(
      cmd,
      spawnArgs,
      withHiddenWindowsConsole({
        ...LOCAL_OP_PIPE_STDIO_OPTIONS,
        env: { ...process.env },
      }),
    );

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      child.stdout.destroy();
      child.stderr.destroy();
      if (!res.writableEnded) {
        writeStreamError(
          500,
          'urn:ok:error:auth-failed',
          `Auth repos subprocess timed out after ${LOCAL_OP_TIMEOUT_MS}ms.`,
        );
      }
      res.end();
      localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
    }, LOCAL_OP_TIMEOUT_MS);
    killTimer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: { type?: unknown; message?: unknown } | null = null;
        try {
          evt = JSON.parse(line) as { type?: unknown; message?: unknown };
        } catch {}
        if (evt && evt.type === 'error') {
          const detail = typeof evt.message === 'string' ? evt.message : undefined;
          writeStreamError(
            500,
            'urn:ok:error:auth-failed',
            'Auth repos subprocess reported an error.',
            { detail },
          );
          continue;
        }
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`${line}\n`);
          } catch {}
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      log.debug({ msg: chunk.toString('utf-8').trim() }, '[local-op/auth/repos] stderr');
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        if (code !== 0 && !res.writableEnded) {
          writeStreamError(
            500,
            'urn:ok:error:auth-failed',
            `Auth repos subprocess exited with code ${code}.`,
          );
        }
        res.end();
        localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        if (!res.writableEnded) {
          writeStreamError(
            500,
            'urn:ok:error:auth-failed',
            'Failed to spawn the auth repos subprocess.',
            { cause: err },
          );
          res.end();
        }
        localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
      }
    });

    res.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(killTimer);
        child.kill('SIGTERM');
        localOpGuard.release(LOCAL_OP_AUTH_REPOS_KEY);
      }
    });
  }

  const HANDLE_LOCAL_OP_AUTH_SIGNOUT = 'local-op-auth-signout';
  const handleLocalOpAuthSignout = withValidation(
    LocalOpAuthHostRequestSchema,
    async (_req, res, body) => {
      const host = body.host ?? defaultAuthHost();

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_SIGNOUT_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An auth signout operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        const [cmd, ...baseArgs] = localOpCliArgs;
        const spawnArgs = [...baseArgs, 'auth', 'signout', '--host', host];

        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            cmd,
            spawnArgs,
            withHiddenWindowsConsole({
              ...LOCAL_OP_IGNORED_STDIO_OPTIONS,
              env: { ...process.env },
            }),
          );
          let settled = false;
          const killTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill('SIGKILL');
            } catch {}
            reject(
              new Error(
                `auth signout subprocess timed out after ${LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS}ms`,
              ),
            );
          }, LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS);
          killTimer.unref?.();
          child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            resolve();
          });
          child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            reject(err);
          });
        });

        successResponse(
          res,
          200,
          LocalOpAuthEmptySuccessSchema,
          {},
          {
            handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT,
          },
        );
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:auth-failed', 'Auth signout failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_SIGNOUT_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_SIGNOUT }),
    },
  );

  const LOCAL_OP_AUTH_SET_IDENTITY_KEY = '/api/local-op/auth/set-identity';

  const HANDLE_LOCAL_OP_AUTH_SET_IDENTITY = 'local-op-auth-set-identity';
  const handleLocalOpAuthSetIdentity = withValidation(
    LocalOpAuthSetIdentityRequestSchema,
    async (_req, res, body) => {
      const name = body.name.trim();
      const email = body.email.trim();

      if (!projectDir) {
        errorResponse(res, 503, 'urn:ok:error:no-project-dir', 'No project directory configured.', {
          handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
        });
        return;
      }

      if (!localOpGuard.tryAcquire(LOCAL_OP_AUTH_SET_IDENTITY_KEY)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A set-identity operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }

      try {
        writeGitIdentity(projectDir, name, email);
        void getSyncEngine?.()
          ?.refreshIdentity()
          .catch(() => {});
        successResponse(
          res,
          200,
          LocalOpAuthEmptySuccessSchema,
          {},
          {
            handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
          },
        );
      } catch (err) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Set-identity failed.', {
          handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
          cause: err,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_AUTH_SET_IDENTITY_KEY);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_AUTH_SET_IDENTITY }),
    },
  );
  const HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY = 'local-op-embeddings-set-key';
  const HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY = 'local-op-embeddings-clear-key';
  const LOCAL_OP_EMBEDDINGS_GUARD = '/api/local-op/embeddings';

  function embeddingsKeyScope(): { projectDir: string; baseUrl: string } {
    const cfg = readSemanticProviderConfig?.();
    return {
      projectDir: projectDir ?? contentDir,
      baseUrl: cfg?.baseUrl ?? DEFAULT_EMBEDDINGS_BASE_URL,
    };
  }

  const handleLocalOpEmbeddingsSetKey = withValidation(
    LocalOpEmbeddingsSetKeyRequestSchema,
    async (_req, res, body) => {
      if (!localOpGuard.tryAcquire(LOCAL_OP_EMBEDDINGS_GUARD)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An embeddings key operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { projectDir: pd, baseUrl } = embeddingsKeyScope();
        await new FileEmbeddingsBackend(embeddingsSecretsFile).setForProject(pd, baseUrl, body.key);
        semanticSearch?.reloadCredential();
        successResponse(
          res,
          200,
          LocalOpEmbeddingsMutationSuccessSchema,
          { keyPresent: true },
          {
            handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY,
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to store the key.', {
          handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY,
          cause: e,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_EMBEDDINGS_GUARD);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_EMBEDDINGS_SET_KEY }),
    },
  );

  const handleLocalOpEmbeddingsClearKey = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!localOpGuard.tryAcquire(LOCAL_OP_EMBEDDINGS_GUARD)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'An embeddings key operation is already in progress.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const { projectDir: pd, baseUrl } = embeddingsKeyScope();
        await new FileEmbeddingsBackend(embeddingsSecretsFile).clearForProject(pd, baseUrl);
        semanticSearch?.reloadCredential();
        successResponse(
          res,
          200,
          LocalOpEmbeddingsMutationSuccessSchema,
          { keyPresent: false },
          {
            handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY,
            extraHeaders: { 'Cache-Control': 'no-store' },
          },
        );
      } catch (e) {
        errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to clear the key.', {
          handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY,
          cause: e,
        });
      } finally {
        localOpGuard.release(LOCAL_OP_EMBEDDINGS_GUARD);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_EMBEDDINGS_CLEAR_KEY }),
    },
  );

  const HANDLE_LOCAL_OP_EMBEDDINGS_TEST = 'local-op-embeddings-test';
  const LOCAL_OP_EMBEDDINGS_TEST_GUARD = '/api/local-op/embeddings/test';

  const handleLocalOpEmbeddingsTest = withValidation(
    EmptyRequestSchema,
    async (_req, res) => {
      if (!localOpGuard.tryAcquire(LOCAL_OP_EMBEDDINGS_TEST_GUARD)) {
        errorResponse(
          res,
          429,
          'urn:ok:error:concurrent-operation',
          'A connection test is already in progress.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST, extraHeaders: { 'Retry-After': '5' } },
        );
        return;
      }
      try {
        const config = readSemanticProviderConfig?.() ?? {
          baseUrl: DEFAULT_EMBEDDINGS_BASE_URL,
          model: DEFAULT_EMBEDDINGS_MODEL,
          dimensions: undefined,
        };
        const cred = await resolveEmbeddingsCredential(
          new FileEmbeddingsBackend(embeddingsSecretsFile),
          projectDir ?? contentDir,
          config.baseUrl,
        );
        const echo = { endpoint: config.baseUrl, model: config.model };
        const probe =
          cred.apiKey || cred.keyless
            ? await probeEmbeddingEndpoint({
                baseUrl: config.baseUrl,
                model: config.model,
                dimensions: config.dimensions,
                apiKey: cred.apiKey ?? undefined,
              })
            : ({ ok: false, reason: 'no_key', status: undefined } as const);
        const payload: LocalOpEmbeddingsTestResponse = probe.ok
          ? { ok: true, ...echo, dimensions: probe.dimensions }
          : { ok: false, ...echo, reason: probe.reason, status: probe.status };
        successResponse(res, 200, LocalOpEmbeddingsTestResponseSchema, payload, {
          handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST,
          extraHeaders: { 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        errorResponse(
          res,
          500,
          'urn:ok:error:internal-server-error',
          'Failed to test the embeddings endpoint.',
          { handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST, cause: e },
        );
      } finally {
        localOpGuard.release(LOCAL_OP_EMBEDDINGS_TEST_GUARD);
      }
    },
    {
      handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST,
      method: 'POST',
      preBodyGate: (req, res) =>
        checkLocalOpSecurity(req, res, { handler: HANDLE_LOCAL_OP_EMBEDDINGS_TEST }),
    },
  );

  const routes = {
    '/api/local-op/clone': handleLocalOpClone,
    '/api/local-op/ok-init': handleLocalOpOkInit,
    '/api/local-op/auth/login': handleLocalOpAuthLogin,
    '/api/local-op/auth/status': handleLocalOpAuthStatus,
    '/api/local-op/auth/pat': handleLocalOpAuthPat,
    '/api/local-op/auth/gh-login': handleLocalOpAuthGhLogin,
    '/api/local-op/auth/cancel': handleLocalOpAuthCancel,
    '/api/local-op/auth/repos': handleLocalOpAuthRepos,
    '/api/local-op/auth/signout': handleLocalOpAuthSignout,
    '/api/local-op/auth/set-identity': handleLocalOpAuthSetIdentity,
    '/api/local-op/embeddings/set-key': handleLocalOpEmbeddingsSetKey,
    '/api/local-op/embeddings/clear-key': handleLocalOpEmbeddingsClearKey,
    '/api/local-op/embeddings/test': handleLocalOpEmbeddingsTest,
  } satisfies ApiRouteRecord;

  return createApiRouteGroup(routes, {
    mutatingPrefixes: ['/api/local-op/'],
    dynamic: {
      prefix: '/api/local-op/',
      template: '/api/local-op/:op',
      dispatch: () => undefined,
    },
  });
}
