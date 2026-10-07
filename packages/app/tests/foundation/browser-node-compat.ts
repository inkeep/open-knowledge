import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { type BridgeHostFacts, FILE_BRIDGE_ROUTE } from './node-substitutes/file-bridge-contract';

export const NODE_MODULES = /[/\\]node_modules[/\\]/;

export const BROWSER_TEST_MODULES: readonly RegExp[] = [
  /\.(?:test|test-helper)\.[cm]?[jt]sx?(?:$|\?)/,
  /[/\\]packages[/\\]app[/\\]tests[/\\]/,
  /[/\\]packages[/\\]app[/\\]src[/\\]test-utils[/\\]/,
  /[/\\]test-support[/\\]/,
];

export const BROWSER_PRODUCT_MODULE_EXCLUDES: readonly RegExp[] = [
  NODE_MODULES,
  ...BROWSER_TEST_MODULES,
];

function isBrowserTestModule(id: string): boolean {
  return !NODE_MODULES.test(id) && BROWSER_TEST_MODULES.some((pattern) => pattern.test(id));
}

const CI_READ = /\bprocess\.env\.CI\b(?![\w$])/g;

export function browserCiValue(env: Readonly<Record<string, string | undefined>>): Plugin {
  const literal = env.CI === undefined ? 'undefined' : JSON.stringify(env.CI);
  return {
    name: 'ok-browser-ci-value',
    enforce: 'pre',
    transform(code, id) {
      if (!isBrowserTestModule(id) || !code.includes('process.env.CI')) return null;
      return { code: code.replace(CI_READ, literal), map: null };
    },
  };
}

const SUBSTITUTED_NODE_MODULE = /^node:(crypto|fs|os|path|process|url)$/;
const SUBSTITUTE_DIR = fileURLToPath(new URL('./node-substitutes/', import.meta.url));

export function nodeSubstituteFor(source: string, importer: string | undefined): string | null {
  const module = SUBSTITUTED_NODE_MODULE.exec(source)?.[1];
  if (module === undefined || importer === undefined || !isBrowserTestModule(importer)) return null;
  return join(SUBSTITUTE_DIR, `${module}.ts`);
}

export type BridgePathResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly status: 400 | 403; readonly reason: string };

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw error;
  }
}

function within(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

export function resolveBridgePath(
  requested: string,
  roots: readonly string[],
): BridgePathResolution {
  if (!isAbsolute(requested)) {
    return { ok: false, status: 400, reason: `EINVAL: ${requested} is not an absolute path` };
  }
  if (requested.split(/[/\\]/).includes('..')) {
    return { ok: false, status: 403, reason: `EACCES: ${requested}: path traversal is refused` };
  }
  const declared = roots.map((root) => resolve(root));
  const path = resolve(requested);
  if (!within(path, declared)) {
    return { ok: false, status: 403, reason: `EACCES: ${requested} is outside the declared roots` };
  }
  const real = realpathOrSelf(path);
  if (!within(real, declared.map(realpathOrSelf))) {
    return {
      ok: false,
      status: 403,
      reason: `EACCES: ${requested} resolves through a symlink outside the declared roots`,
    };
  }
  return { ok: true, path: real };
}

type BridgeResponse = { readonly status: number; readonly body: string };

function answerFileBridge(
  operation: string | null,
  requested: string,
  roots: readonly string[],
  facts: BridgeHostFacts,
): BridgeResponse {
  if (operation === 'host') return { status: 200, body: JSON.stringify(facts) };
  if (operation !== 'read' && operation !== 'exists' && operation !== 'readdir') {
    return { status: 400, body: `EINVAL: unknown file bridge operation ${operation}` };
  }
  const resolved = resolveBridgePath(requested, roots);
  if (!resolved.ok) return { status: resolved.status, body: resolved.reason };
  if (operation === 'exists') return { status: 200, body: String(existsSync(resolved.path)) };
  try {
    return {
      status: 200,
      body:
        operation === 'read'
          ? readFileSync(resolved.path, 'utf8')
          : JSON.stringify(readdirSync(resolved.path)),
    };
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code === undefined) throw error;
    return { status: code === 'ENOENT' ? 404 : 500, body: message };
  }
}

export function browserNodeSubstitutes(roots: readonly string[]): Plugin {
  return {
    name: 'ok-browser-node-substitutes',
    enforce: 'pre',
    resolveId(source, importer) {
      return nodeSubstituteFor(source, importer);
    },
    configureServer(server) {
      const facts: BridgeHostFacts = {
        cwd: server.config.root,
        platform: process.platform,
        tmpdir: tmpdir(),
        eol: EOL,
        ci: process.env.CI ?? null,
      };
      server.middlewares.use(FILE_BRIDGE_ROUTE, (request, response) => {
        const url = new URL(request.url ?? '/', 'http://file-bridge');
        const { status, body } =
          request.method === 'GET'
            ? answerFileBridge(
                url.searchParams.get('op'),
                url.searchParams.get('path') ?? '',
                roots,
                facts,
              )
            : { status: 405, body: 'EINVAL: the file bridge answers GET only' };
        response.statusCode = status;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(body);
      });
    },
  };
}
