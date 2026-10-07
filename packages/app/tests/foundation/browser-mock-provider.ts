import {
  PlaywrightBrowserProvider,
  type PlaywrightProviderOptions,
} from '@vitest/browser-playwright';
import type { BrowserContext } from 'playwright';
import { parseSync, type ViteDevServer } from 'vite';
import type { BrowserModuleMocker, BrowserProviderOption, TestProject } from 'vitest/node';

type MockedModule = Parameters<BrowserModuleMocker['register']>[1];
type ManualMockedModule = Extract<MockedModule, { type: 'manual' }>;
type RouteHandler = Parameters<BrowserContext['route']>[1];

const CAUSE_DEPTH = 8;

type ErrorLike = { message?: unknown; cause?: unknown };

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && messages.length < CAUSE_DEPTH) {
    const { message, cause } = (typeof current === 'object' ? current : {}) as ErrorLike;
    messages.push(typeof message === 'string' ? message : String(current));
    current = cause;
  }
  return messages.join(' <- caused by: ');
}

const REJECTED_BINDING = '__okRejectedMockBinding';

function rejectedMockModuleSource(
  pathname: string,
  exportNames: ReadonlySet<string>,
  error: unknown,
): string {
  const message = `vi.mock factory for ${pathname} rejected: ${errorChain(error)}`;
  const exported = [...exportNames]
    .map((name) => `${REJECTED_BINDING} as ${JSON.stringify(name)}`)
    .join(', ');
  return [
    `throw new Error(${JSON.stringify(message)});`,
    `let ${REJECTED_BINDING};`,
    `export { ${exported} };`,
    '',
  ].join('\n');
}

function answerRejectedFactories(handler: RouteHandler, vite: ViteDevServer): RouteHandler {
  return async (route, request) => {
    try {
      return await handler(route, request);
    } catch (error) {
      const { pathname } = new URL(request.url());
      await route.fulfill({
        headers: moduleResponseHeaders(vite),
        body: rejectedMockModuleSource(pathname, await moduleExportNames(vite, pathname), error),
      });
    }
  };
}

const guardedContexts = new WeakSet<BrowserContext>();

function guardMockRoutes(context: BrowserContext, vite: ViteDevServer): void {
  if (guardedContexts.has(context)) return;
  guardedContexts.add(context);
  const route = context.route.bind(context);
  context.route = (url, handler, options) =>
    route(url, answerRejectedFactories(handler, vite), options);
}

async function moduleExportNames(
  vite: ViteDevServer,
  url: string,
  seen: Set<string> = new Set(),
): Promise<Set<string>> {
  const names = new Set<string>();
  if (seen.has(url)) return names;
  seen.add(url);
  const transformed = await vite.environments.client.transformRequest(url);
  if (transformed === null) return names;
  const { module } = parseSync('module.js', transformed.code, { lang: 'js', sourceType: 'module' });
  for (const { entries } of module.staticExports) {
    for (const { exportName, importName, moduleRequest } of entries) {
      if (exportName.kind === 'Default') names.add('default');
      if (exportName.kind === 'Name' && exportName.name !== null) names.add(exportName.name);
      if (exportName.kind === 'None' && importName.kind === 'AllButDefault' && moduleRequest) {
        for (const reexported of await moduleExportNames(vite, moduleRequest.value, seen)) {
          if (reexported !== 'default') names.add(reexported);
        }
      }
    }
  }
  return names;
}

function completeFactoryExports(vite: ViteDevServer, module: ManualMockedModule): void {
  const resolve = module.resolve.bind(module);
  module.resolve = async () => {
    const exports = await resolve();
    const missing = [...(await moduleExportNames(vite, module.url))].filter(
      (name) => !Object.hasOwn(exports, name),
    );
    return { ...Object.fromEntries(missing.map((name) => [name, undefined])), ...exports };
  };
}

function viteOf(project: TestProject): ViteDevServer {
  const vite = project.browser?.vite;
  if (vite === undefined) throw new Error(`${project.name} has no browser Vite server`);
  return vite;
}

function moduleResponseHeaders(vite: ViteDevServer): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/javascript' };
  for (const [name, value] of Object.entries(vite.config.server.headers ?? {})) {
    headers[name] = String(value);
  }
  return headers;
}

export function withMockContracts(
  base: BrowserProviderOption<PlaywrightProviderOptions>,
): BrowserProviderOption<PlaywrightProviderOptions> {
  return {
    ...base,
    providerFactory(project) {
      const provider = base.providerFactory(project);
      if (!(provider instanceof PlaywrightBrowserProvider)) {
        throw new Error('withMockContracts wraps only the Playwright provider');
      }
      const register = provider.mocker.register;
      provider.mocker.register = async (sessionId, module) => {
        const vite = viteOf(project);
        guardMockRoutes(provider.getPage(sessionId).context(), vite);
        if (module.type === 'manual') completeFactoryExports(vite, module);
        return register(sessionId, module);
      };
      return provider;
    },
  };
}
