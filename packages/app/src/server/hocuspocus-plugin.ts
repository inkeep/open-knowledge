import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import {
  ASSET_EXTENSIONS,
  EXECUTABLE_BLOCKLIST_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  OK_DIR,
} from '@inkeep/open-knowledge-core';
import {
  AcpThreadManager,
  buildIngressPolicy,
  buildOkMcpStdioCommand,
  createAssetServeMiddleware,
  createCollaborationHost,
  createServer,
  getLogger,
  makeLazyEmbeddingsKeyStore,
  releaseServerLock,
  updateServerLockPort,
} from '@inkeep/open-knowledge-server';
import sirv from 'sirv';
import type { Plugin } from 'vite';
import type { WebSocketServer } from 'ws';
import { parse as parseYaml } from 'yaml';
import { computeDevApiConfigResponse } from './api-config-handler.ts';

let configureServerInvocations = 0;

const PLUGIN_DIR = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(PLUGIN_DIR, '../../../..');

interface ContentConfig {
  dir: string;
}

export function resolveContentConfig(projectRoot: string): ContentConfig {
  const defaults: ContentConfig = { dir: projectRoot };
  const configPath = resolve(projectRoot, '.ok/config.yml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown> | null;
      const content = parsed?.content as Record<string, unknown> | undefined;
      if (typeof content?.dir === 'string') {
        defaults.dir = resolve(projectRoot, content.dir);
      }
    } catch (err) {
      console.warn('[hocuspocus] Failed to parse config:', err);
    }
  }
  return defaults;
}

const contentConfig = resolveContentConfig(PROJECT_ROOT);
const CONTENT_DIR = process.env.OK_TEST_CONTENT_DIR
  ? realpathSync(process.env.OK_TEST_CONTENT_DIR)
  : contentConfig.dir;
const CONTENT_ROOT = relative(PROJECT_ROOT, CONTENT_DIR);

mkdirSync(CONTENT_DIR, { recursive: true });

const isTestIsolated = Boolean(process.env.OK_TEST_CONTENT_DIR);
const gitEnabledForTest = isTestIsolated && process.env.OK_TEST_GIT_ENABLED === '1';

const SINGLE_DOC_REL_PATH = process.env.OK_TEST_SINGLE_DOC_REL_PATH || undefined;
const isEphemeralTest = isTestIsolated && SINGLE_DOC_REL_PATH !== undefined;
const TEST_PROJECT_DIR = process.env.OK_TEST_PROJECT_DIR
  ? realpathSync(process.env.OK_TEST_PROJECT_DIR)
  : undefined;

let exitHandlerRegistered = false;
let latestLockDir: string | null = null;

const VITE_WSS_CLOSE_TIMEOUT_MS = 5_000;

function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const terminationErrors: unknown[] = [];
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (err) {
          terminationErrors.push(err);
        }
      }
      const timeoutError = new Error(
        `WebSocket server close timed out after ${VITE_WSS_CLOSE_TIMEOUT_MS}ms`,
      );
      reject(
        terminationErrors.length === 0
          ? timeoutError
          : new AggregateError(
              [timeoutError, ...terminationErrors],
              'WebSocket server close timed out and client termination failed',
            ),
      );
    }, VITE_WSS_CLOSE_TIMEOUT_MS);
    timer.unref?.();

    const settle = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    try {
      wss.close(settle);
    } catch (err) {
      settle(err);
    }
  });
}

export function hocuspocusPlugin(): Plugin {
  const activeRuntimeTeardowns = new Set<() => Promise<void>>();
  return {
    name: 'hocuspocus',
    async buildEnd() {
      const results = await Promise.allSettled(
        [...activeRuntimeTeardowns].map((teardown) => teardown()),
      );
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Hocuspocus Vite teardown failed');
    },
    async configureServer(server) {
      configureServerInvocations += 1;
      if (configureServerInvocations > 1) {
        console.warn(
          `[collab] configureServer invoked ${configureServerInvocations}× — Vite restarted; spinning up a fresh ServerInstance. The previous srv will be destroyed by its httpServer close handler.`,
        );
      } else {
        console.info(`[collab] configureServer invocation=1 pid=${process.pid}`);
      }

      const currentSrv = createServer({
        contentDir: CONTENT_DIR,
        projectDir: TEST_PROJECT_DIR ?? (isTestIsolated ? CONTENT_DIR : PROJECT_ROOT),
        contentRoot: isTestIsolated ? '' : CONTENT_ROOT,
        ...(isTestIsolated ? { configHomedirOverride: CONTENT_DIR } : {}),
        gitEnabled: isEphemeralTest ? false : !isTestIsolated || gitEnabledForTest,
        enableTestRoutes: true,
        quiet: true,
        embeddingsKeyStore: makeLazyEmbeddingsKeyStore(),
        capabilities: ['http', 'ws', 'ui'],
        ...(isEphemeralTest ? { ephemeral: true, singleDocRelPath: SINGLE_DOC_REL_PATH } : {}),
      });

      latestLockDir = currentSrv.lockDir;
      if (!exitHandlerRegistered) {
        exitHandlerRegistered = true;
        process.once('exit', () => {
          if (latestLockDir === null) return;
          try {
            releaseServerLock(latestLockDir);
          } catch {}
        });
      }

      if (configureServerInvocations === 1) {
        getLogger('hocuspocus').info({ contentDir: CONTENT_DIR }, 'content dir');
      }

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (typeof addr === 'object' && addr !== null) {
          updateServerLockPort(currentSrv.lockDir, addr.port, `http://localhost:${addr.port}`);
        }
      });

      const {
        hocuspocus,
        nativeApi,
        sessionManager,
        agentFocusBroadcaster,
        agentPresenceBroadcaster,
      } = currentSrv;

      const acpThreadManager = isEphemeralTest
        ? null
        : new AcpThreadManager({
            contentDir: CONTENT_DIR,
            localDir: currentSrv.lockDir,
            globalDir: resolve(homedir(), OK_DIR),
            registry: currentSrv.acpRegistry,
            permissions: currentSrv.acpPermissions,
            sessionManager,
            agentPresenceBroadcaster,
            resolveEmbed: currentSrv.resolveEmbed,
            isExcludedPath: (rel) => currentSrv.contentFilter.isExcluded(rel),
            isIgnoredPath: (rel) => currentSrv.contentFilter.isPathIgnored(rel),
            getLoadedDocText: (docName) =>
              hocuspocus.documents.get(docName)?.getText('source').toString() ?? null,
            getServerUrl: () => {
              const addr = server.httpServer?.address();
              const port = typeof addr === 'object' && addr !== null ? addr.port : 5173;
              return `http://localhost:${port}`;
            },
            getMcpStdioCommand: () => {
              const addr = server.httpServer?.address();
              const port = typeof addr === 'object' && addr !== null ? addr.port : 5173;
              return buildOkMcpStdioCommand(undefined, port, { log: getLogger('acp-threads') });
            },
            log: getLogger('acp-threads'),
          });
      await acpThreadManager?.init();

      const collaborationHost = createCollaborationHost({
        hocuspocus,
        log: getLogger('hocuspocus'),
        sessionManager,
        agentFocusBroadcaster,
        agentPresenceBroadcaster,
        maintenanceCoordinator: currentSrv.maintenanceCoordinator,
        acpThreadManager,
      });
      server.httpServer?.prependListener('upgrade', collaborationHost.handleUpgrade);

      const assetMiddleware = createAssetServeMiddleware({
        contentFilter: currentSrv.contentFilter,
        contentSirv: sirv(CONTENT_DIR, { dev: true, dotfiles: false }),
        inlineExtensions: INLINE_RENDERABLE_EXTENSIONS,
        assetExtensions: ASSET_EXTENSIONS,
        blocklistExtensions: EXECUTABLE_BLOCKLIST_EXTENSIONS,
        ingressPolicy: buildIngressPolicy({}),
      });
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        const path = url.split('?')[0] ?? '';
        const queryStart = url.indexOf('?');
        const query = queryStart >= 0 ? url.slice(queryStart) : '';
        const params = query ? new URLSearchParams(query) : null;
        if (
          path.startsWith('/@vite/') ||
          path.startsWith('/@fs/') ||
          path.startsWith('/@id/') ||
          path === '/@react-refresh' ||
          path.startsWith('/node_modules/') ||
          path.startsWith('/src/') ||
          path === '/favicon.svg' ||
          params?.has('import') ||
          params?.has('html-proxy')
        ) {
          return next();
        }
        return assetMiddleware(req, res, next);
      });

      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url?.startsWith('/api/')) {
          if (url === '/api/config') {
            const addr = server.httpServer?.address();
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
            const response = computeDevApiConfigResponse(req.method, port, isEphemeralTest);
            if (response) {
              for (const [name, value] of Object.entries(response.headers)) {
                res.setHeader(name, value);
              }
              res.statusCode = response.status;
              if (response.omitBody) {
                res.end();
              } else {
                res.end(response.body);
              }
              return;
            }
          }
          if (await nativeApi.dispatch(req, res)) return;
          // biome-ignore lint/suspicious/noExplicitAny: Hocuspocus `hooks()` has no exported payload type for onRequest
          await hocuspocus.hooks('onRequest', { request: req, response: res } as any);
          if (res.writableEnded || res.headersSent) return;
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'API route not found', path: url }));
          return;
        }
        next();
      });

      let teardownPromise: Promise<void> | undefined;
      const teardown = (): Promise<void> => {
        teardownPromise ??= (async () => {
          const errors: unknown[] = [];
          const run = async (label: string, action: () => Promise<void>): Promise<void> => {
            try {
              await action();
            } catch (err) {
              errors.push(err);
              getLogger('hocuspocus').error(
                { err },
                `Vite collaboration teardown failed: ${label}`,
              );
            }
          };
          server.httpServer?.off('upgrade', collaborationHost.handleUpgrade);
          await run('ACP thread manager', async () => acpThreadManager?.destroy());
          await run('collaboration host', () => collaborationHost.shutdown());
          await run('WebSocket server', () => closeWebSocketServer(collaborationHost.wss));
          await run('server instance', () => currentSrv.destroy());
          if (errors.length > 0)
            throw new AggregateError(errors, 'Vite collaboration teardown failed');
        })();
        void teardownPromise.finally(() => activeRuntimeTeardowns.delete(teardown)).catch(() => {});
        return teardownPromise;
      };
      activeRuntimeTeardowns.add(teardown);
      server.httpServer?.on('close', () => {
        void teardown().catch((err) =>
          getLogger('hocuspocus').error({ err }, 'HTTP close fallback teardown failed'),
        );
      });

      getLogger('hocuspocus').info({}, 'WebSocket server ready on /collab');
    },
  };
}
