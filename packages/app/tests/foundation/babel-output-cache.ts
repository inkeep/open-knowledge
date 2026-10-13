import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OK_ROOT = join(APP_ROOT, '..', '..');

export const BABEL_OUTPUT_CACHE_DIR = join(APP_ROOT, 'node_modules', '.cache', 'ok-browser-babel');

export const BABEL_OUTPUT_KEY_FILES: readonly string[] = [
  join(OK_ROOT, 'pnpm-lock.yaml'),
  join(OK_ROOT, 'node_modules', '.pnpm', 'lock.yaml'),
  join(APP_ROOT, 'vite.react-babel.ts'),
  join(APP_ROOT, 'vitest.browser.config.ts'),
  join(APP_ROOT, 'tests', 'foundation', 'browser-node-compat.ts'),
  join(APP_ROOT, 'tests', 'foundation', 'babel-output-cache.ts'),
  join(APP_ROOT, 'lingui.config.ts'),
];

export const BABEL_OUTPUT_KEY_ENV: readonly string[] = [
  'BABEL_ENV',
  'BABEL_SHOW_CONFIG_FOR',
  'BABEL_TYPES_8_BREAKING',
  'BROWSERSLIST',
  'BROWSERSLIST_CONFIG',
  'BROWSERSLIST_DISABLE_CACHE',
  'BROWSERSLIST_ROOT_PATH',
  'CI',
  'DEBUG',
  'ENABLE_REACT_COMPILER_TIMINGS',
  'FORCE_COLOR',
  'JITI_ALIAS',
  'JITI_CACHE',
  'JITI_DEBUG',
  'JITI_ESM_EVAL_TEMP_FILE',
  'JITI_EXTENSIONS',
  'JITI_FS_CACHE',
  'JITI_INTEROP_DEFAULT',
  'JITI_JSX',
  'JITI_MODULE_CACHE',
  'JITI_NATIVE_MODULES',
  'JITI_REBUILD_FS_CACHE',
  'JITI_REQUIRE_CACHE',
  'JITI_SOURCE_MAPS',
  'JITI_TRANSFORM_MODULES',
  'JITI_TRY_NATIVE',
  'JITI_TSCONFIG_PATHS',
  'LINGUI_CONFIG',
  'NODE_DEBUG',
  'NODE_ENV',
  'NODE_V8_COVERAGE',
  'NO_COLOR',
  'TMPDIR',
  'WATCH_REPORT_DEPENDENCIES',
];

const ENTRY_SCHEMA = 'ok-browser-babel-output-v1';

type TransformResult = { readonly code?: string; readonly map?: unknown } | null | undefined;

type TransformHandler = (
  this: { readonly environment?: { readonly name?: string } },
  code: string,
  id: string,
  options?: { readonly moduleType?: string },
) => TransformResult | Promise<TransformResult>;

export type BabelOutputCacheCounts = { hits: number; misses: number; unwritten: number };

export type BabelOutputCacheOptions = {
  readonly directory?: string;
  readonly keyFiles?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
};

function fileDigest(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

function readEntry(path: string): { value: TransformResult } | undefined {
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as { schema?: unknown; value?: unknown };
    if (entry.schema !== ENTRY_SCHEMA || !('value' in entry)) return undefined;
    return { value: entry.value as TransformResult };
  } catch {
    return undefined;
  }
}

function writeEntry(path: string, value: TransformResult): boolean {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ schema: ENTRY_SCHEMA, value: value ?? null }));
    renameSync(temporary, path);
    return true;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {}
    return false;
  }
}

export function babelOutputCache(options: BabelOutputCacheOptions = {}) {
  const directory = options.directory ?? BABEL_OUTPUT_CACHE_DIR;
  const keyFiles = options.keyFiles ?? BABEL_OUTPUT_KEY_FILES;
  const env = options.env ?? process.env;
  const counts = new Map<number, BabelOutputCacheCounts>();
  const countsFor = (index: number) => {
    const entry = counts.get(index) ?? { hits: 0, misses: 0, unwritten: 0 };
    counts.set(index, entry);
    return entry;
  };
  let inputs: string | undefined;
  const keyInputs = () => {
    inputs ??= JSON.stringify([
      ENTRY_SCHEMA,
      keyFiles.map((path) => [path, fileDigest(path)]),
      BABEL_OUTPUT_KEY_ENV.map((name) => [name, env[name] ?? null]),
    ]);
    return inputs;
  };

  async function wrap<P extends { readonly name: string; transform?: unknown }>(
    pending: P | Promise<P>,
    index: number,
  ): Promise<P> {
    const plugin = await pending;
    const transform = plugin.transform as { handler?: unknown } | undefined;
    if (
      typeof transform !== 'object' ||
      transform === null ||
      typeof transform.handler !== 'function'
    ) {
      throw new Error(`the Babel output cache needs a transform handler on ${plugin.name}`);
    }
    const handler = transform.handler as TransformHandler;
    transform.handler = async function cachedBabelTransform(
      this: { readonly environment?: { readonly name?: string } },
      code: string,
      id: string,
      transformOptions?: { readonly moduleType?: string },
    ) {
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            keyInputs(),
            index,
            this.environment?.name ?? null,
            transformOptions?.moduleType ?? null,
            id,
            code,
          ]),
        )
        .digest('hex');
      const path = join(directory, key.slice(0, 2), `${key}.json`);
      const cached = readEntry(path);
      const tally = countsFor(index);
      if (cached !== undefined) {
        tally.hits += 1;
        return cached.value ?? undefined;
      }
      tally.misses += 1;
      const value = await handler.call(this, code, id, transformOptions);
      if (!writeEntry(path, value)) tally.unwritten += 1;
      return value;
    };
    return plugin;
  }

  return {
    directory,
    wrap,
    counts: (index: number): BabelOutputCacheCounts => ({ ...countsFor(index) }),
  };
}
