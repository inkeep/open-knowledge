import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Plugin } from 'vite';
import { afterEach, describe, expect, test } from 'vitest';
import {
  APP_BROWSER_BABEL_OUTPUT,
  appBrowserBabelPasses,
  appBrowserVitestConfig,
} from '../../vitest.browser.config';
import {
  BABEL_OUTPUT_KEY_ENV,
  BABEL_OUTPUT_KEY_FILES,
  babelOutputCache,
} from './babel-output-cache';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OK_ROOT = join(APP_ROOT, '..', '..');
const PRODUCT_MODULE = '/src/components/OutlinePanel.tsx';
const TEST_MODULE = '/tests/foundation/outline-panel.browser.test.tsx';

function unseenIds(): [string, string] {
  const probe = randomUUID();
  return [`${PRODUCT_MODULE}?probe=${probe}`, `${TEST_MODULE}?probe=${probe}`];
}
const COMPILE_TIMEOUT_MS = 60_000;

const REQUIRED_KEY_FILES = [
  join(OK_ROOT, 'pnpm-lock.yaml'),
  join(OK_ROOT, 'node_modules', '.pnpm', 'lock.yaml'),
  join(APP_ROOT, 'vite.react-babel.ts'),
  join(APP_ROOT, 'vitest.browser.config.ts'),
  join(APP_ROOT, 'tests', 'foundation', 'browser-node-compat.ts'),
  join(APP_ROOT, 'tests', 'foundation', 'babel-output-cache.ts'),
  join(APP_ROOT, 'lingui.config.ts'),
];

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-babel-output-cache-'));
  scratch.push(dir);
  return dir;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
}

type Call = {
  readonly index: number;
  readonly environment: string;
  readonly moduleType: string;
  readonly id: string;
  readonly code: string;
};

const BASE_CALL: Call = {
  index: 0,
  environment: 'client',
  moduleType: 'tsx',
  id: '/app/src/Example.tsx',
  code: 'export const Example = () => null;',
};

function countingPass() {
  let compiles = 0;
  const plugin = {
    name: 'counting-pass',
    transform: {
      handler: (code: string, id: string) => {
        compiles += 1;
        return { code: `${code}\n//compiled ${id}`, map: { mappings: 'AAAA' } };
      },
    },
  };
  return { plugin, compiles: () => compiles };
}

async function compileOnce(
  cache: ReturnType<typeof babelOutputCache>,
  call: Call = BASE_CALL,
): Promise<{ compiled: boolean; value: unknown; counts: ReturnType<typeof cache.counts> }> {
  const pass = countingPass();
  const plugin = await cache.wrap(pass.plugin, call.index);
  const handler = plugin.transform.handler as unknown as (
    this: unknown,
    code: string,
    id: string,
    options: { moduleType: string },
  ) => Promise<unknown>;
  const value = await handler.call(
    { environment: { name: call.environment } },
    call.code,
    call.id,
    {
      moduleType: call.moduleType,
    },
  );
  return { compiled: pass.compiles() === 1, value, counts: cache.counts(call.index) };
}

function keyedScratch() {
  const dir = scratchDir();
  const directory = join(dir, 'cache');
  const keyFiles = BABEL_OUTPUT_KEY_FILES.map((path, position) => {
    const copy = join(dir, 'inputs', String(position), basename(path));
    mkdirSync(join(dir, 'inputs', String(position)), { recursive: true });
    copyFileSync(path, copy);
    return copy;
  });
  const env: Record<string, string | undefined> = Object.fromEntries(
    BABEL_OUTPUT_KEY_ENV.map((name) => [name, `value-of-${name}`]),
  );
  const fresh = (overrides: { env?: Record<string, string | undefined> } = {}) =>
    babelOutputCache({ directory, keyFiles, env: overrides.env ?? env });
  return { directory, keyFiles, env, fresh };
}

async function transformAll(plugins: Plugin[], ids: readonly string[]): Promise<string[]> {
  const server = await createServer({
    configFile: false,
    root: APP_ROOT,
    logLevel: 'silent',
    plugins,
    resolve: { alias: appBrowserVitestConfig.resolve.alias },
    server: { middlewareMode: true, ws: false, preTransformRequests: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const codes: string[] = [];
    for (const id of ids) {
      const result = await server.environments.client.transformRequest(id);
      if (result === null) throw new Error(`${id} produced no transform result`);
      codes.push(result.code);
    }
    return codes;
  } finally {
    await server.close();
  }
}

async function configBabelPasses(): Promise<Plugin[]> {
  const plugins = await Promise.all(appBrowserVitestConfig.plugins.flat());
  return plugins.filter(
    (plugin): plugin is Plugin =>
      typeof plugin === 'object' && plugin !== null && plugin.name === '@rolldown/plugin-babel',
  );
}

describe('the browser tier Babel output cache key', () => {
  test('a second compile of the same module from the same inputs is served from the cache, unchanged', async () => {
    const { fresh } = keyedScratch();
    const first = await compileOnce(fresh());
    const second = await compileOnce(fresh());

    expect(first.compiled).toBe(true);
    expect(second.compiled).toBe(false);
    expect(second.counts).toEqual({ hits: 1, misses: 0, unwritten: 0 });
    expect(second.value).toEqual(first.value);
  });

  test.each(
    REQUIRED_KEY_FILES.map((required) => ({ required, label: relative(OK_ROOT, required) })),
  )('editing $label makes the next compile miss', async ({ required }) => {
    const { keyFiles, fresh } = keyedScratch();
    await compileOnce(fresh());
    const position = BABEL_OUTPUT_KEY_FILES.indexOf(required);
    expect(position).toBeGreaterThanOrEqual(0);
    writeFileSync(keyFiles[position] as string, '\nedited\n', { flag: 'a' });

    expect((await compileOnce(fresh())).compiled).toBe(true);
  });

  test.each(BABEL_OUTPUT_KEY_ENV)(
    'a different %s value makes the next compile miss, and an unset one too',
    async (name) => {
      const { env, fresh } = keyedScratch();
      await compileOnce(fresh());

      expect((await compileOnce(fresh({ env: { ...env, [name]: 'changed' } }))).compiled).toBe(
        true,
      );
      expect((await compileOnce(fresh({ env: { ...env, [name]: undefined } }))).compiled).toBe(
        true,
      );
    },
  );

  test.each([
    ['Babel pass', { index: 1 }],
    ['Vite environment', { environment: 'ssr' }],
    ['module type', { moduleType: 'ts' }],
    ['module id', { id: '/app/src/Other.tsx' }],
    ['source text reaching the pass', { code: 'export const Example = () => 1;' }],
  ] as const)('a different %s makes the compile miss', async (_label, change) => {
    const { fresh } = keyedScratch();
    await compileOnce(fresh());

    expect((await compileOnce(fresh(), { ...BASE_CALL, ...change })).compiled).toBe(true);
  });
});

describe('the browser tier Babel output cache never fails a run over its own storage', () => {
  test('a cache directory that cannot be created still compiles, and records the entry as unwritten', async () => {
    const dir = scratchDir();
    const blocked = join(dir, 'a-file');
    writeFileSync(blocked, 'not a directory');
    const cache = babelOutputCache({ directory: join(blocked, 'cache'), keyFiles: [], env: {} });

    const run = await compileOnce(cache);

    expect(run.compiled).toBe(true);
    expect(run.value).toEqual({
      code: `${BASE_CALL.code}\n//compiled ${BASE_CALL.id}`,
      map: { mappings: 'AAAA' },
    });
    expect(run.counts).toEqual({ hits: 0, misses: 1, unwritten: 1 });
  });

  test('a corrupt entry is a miss that the compile rewrites', async () => {
    const { directory, fresh } = keyedScratch();
    await compileOnce(fresh());
    const entries = filesUnder(directory);
    expect(entries).toHaveLength(1);
    for (const entry of entries) writeFileSync(entry, '{"schema":');

    expect((await compileOnce(fresh())).compiled).toBe(true);
    expect((await compileOnce(fresh())).compiled).toBe(false);
  });

  test('an entry path that cannot be replaced is a miss, and the failed write leaves no partial file behind', async () => {
    const { directory, fresh } = keyedScratch();
    await compileOnce(fresh());
    const [entry] = filesUnder(directory);
    expect(entry).toBeDefined();
    rmSync(entry as string);
    mkdirSync(join(entry as string, 'occupied'), { recursive: true });

    const run = await compileOnce(fresh());

    expect(run.compiled).toBe(true);
    expect(run.counts).toEqual({ hits: 0, misses: 1, unwritten: 1 });
    expect(filesUnder(directory).filter((path) => path.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the browser config compiles through the cache', () => {
  test(
    'each of the config’s Babel passes reads and writes the cache, and a warm compile is byte-identical to a fresh one',
    async () => {
      const passes = await configBabelPasses();
      expect(passes).toHaveLength(appBrowserBabelPasses().length);
      const before = passes.map((_, index) => APP_BROWSER_BABEL_OUTPUT.counts(index));

      const ids = unseenIds();

      await transformAll(passes, ids);
      const afterCold = passes.map((_, index) => APP_BROWSER_BABEL_OUTPUT.counts(index));
      const warm = await transformAll(passes, ids);
      const afterWarm = passes.map((_, index) => APP_BROWSER_BABEL_OUTPUT.counts(index));
      const uncached = await transformAll(
        (await Promise.all(appBrowserBabelPasses())) as unknown as Plugin[],
        ids,
      );

      expect(
        afterCold.map((counts, index) => counts.misses - (before[index]?.misses ?? 0)),
      ).toEqual(passes.map(() => 1));
      expect(afterWarm.map((counts, index) => counts.hits - (afterCold[index]?.hits ?? 0))).toEqual(
        passes.map(() => 1),
      );
      expect(warm).toEqual(uncached);
    },
    COMPILE_TIMEOUT_MS,
  );
});

const OBSERVE_ENV_READS = `
const compileReads = new Set();
const configReads = new Set();
let compiling = 0;
let loadingConfig = false;
const note = (name) => {
  if (typeof name !== 'string') return;
  if (compiling > 0) compileReads.add(name);
  if (loadingConfig && /vitest\\.browser\\.config\\.ts\\.timestamp/.test(new Error().stack ?? '')) configReads.add(name);
};
process.env = new Proxy(process.env, {
  get(target, name) { note(name); return Reflect.get(target, name); },
  has(target, name) { note(name); return Reflect.has(target, name); },
});
const { createServer, loadConfigFromFile } = await import('vite');
const root = process.cwd();
const [cacheDir, ...ids] = process.argv.slice(1);
loadingConfig = true;
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, root + '/vitest.browser.config.ts', root, 'silent');
const plugins = (await Promise.all(loaded.config.plugins.flat())).filter((plugin) => plugin && plugin.name === '@rolldown/plugin-babel');
loadingConfig = false;
for (const plugin of plugins) {
  const inner = plugin.transform.handler;
  plugin.transform.handler = async function (...args) {
    compiling += 1;
    try { return await inner.apply(this, args); } finally { compiling -= 1; }
  };
}
const server = await createServer({ configFile: false, root, cacheDir, logLevel: 'silent', plugins, resolve: { alias: loaded.config.resolve.alias }, server: { middlewareMode: true, ws: false, preTransformRequests: false }, optimizeDeps: { noDiscovery: true, include: [] } });
for (const id of ids) await server.environments.client.transformRequest(id);
await server.close();
process.stdout.write(JSON.stringify({ passes: plugins.length, configReads: [...configReads].sort(), compileReads: [...compileReads].sort() }));
process.exit(0);
`;

function observeEnvReads(): Promise<{
  passes: number;
  configReads: string[];
  compileReads: string[];
}> {
  const dir = scratchDir();
  const cacheDir = join(dir, 'node_modules', '.vite');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', OBSERVE_ENV_READS, cacheDir, ...unseenIds()],
      { cwd: APP_ROOT, env: { ...process.env, TMPDIR: dir }, timeout: COMPILE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`observing the compile failed: ${stderr || error.message}`));
        else resolve(JSON.parse(stdout));
      },
    );
  });
}

describe('the cache key covers every environment value the compile reads', () => {
  test(
    'the config’s Babel option code and a cold compile of a product and a test module read only keyed environment values',
    async () => {
      const observed = await observeEnvReads();

      expect(observed.passes).toBe(appBrowserBabelPasses().length);
      expect(observed.compileReads).toContain('NODE_ENV');
      expect(observed.configReads.filter((name) => !BABEL_OUTPUT_KEY_ENV.includes(name))).toEqual(
        [],
      );
      expect(observed.compileReads.filter((name) => !BABEL_OUTPUT_KEY_ENV.includes(name))).toEqual(
        [],
      );
    },
    COMPILE_TIMEOUT_MS,
  );
});
