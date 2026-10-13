import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PREBUILT_MODULE_MANIFEST } from '../../src/build/prebuilt-dev-contract';
import { prebuiltModuleChunksPlugin } from '../../src/build/prebuilt-module-chunks-plugin';
import {
  parseModuleChunks,
  parseModuleManifest,
  resolveServedModules,
} from '../stress/_helpers/prebuilt/served-modules';

const APP: Readonly<Record<string, string>> = {
  'index.html':
    '<!doctype html><script>document.documentElement.lang = "en";</script><script type="module" src="/src/main.ts"></script>\n',
  'src/main.ts':
    "import { shared } from './shared.ts';\ndocument.title = shared;\nvoid import('./lazy.ts');\nvoid import('./locales/es/messages.json');\nvoid import('./locales/fr/messages.json');\n",
  'src/lazy.ts': "import { child } from './lazy-child.ts';\nexport const lazy = 'lazy ' + child;\n",
  'src/lazy-child.ts': "export const child = 'child';\n",
  'src/shared.ts': "export const shared = 'shared';\n",
  'src/unused.ts': "export const unused = 'unused';\n",
  'src/page-modules.ts': "export { shared } from './shared.ts';\n",
  'src/locales/es/messages.json': '{"messages":{"hello":"hola"}}\n',
  'src/locales/fr/messages.json': '{"messages":{"hello":"bonjour"}}\n',
};

const roots: string[] = [];

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function app(files: Readonly<Record<string, string>> = APP): string {
  const root = scratch('ok-served-modules-app-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

let appRoot: string;
let outputDir: string;

beforeAll(async () => {
  appRoot = app();
  outputDir = scratch('ok-served-modules-output-');
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'silent',
    plugins: [prebuiltModuleChunksPlugin(appRoot)],
    build: {
      outDir: join(outputDir, 'dist'),
      emptyOutDir: true,
      manifest: PREBUILT_MODULE_MANIFEST,
      rolldownOptions: {
        input: {
          index: join(appRoot, 'index.html'),
          'page-modules': join(appRoot, 'src/page-modules.ts'),
        },
        preserveEntrySignatures: 'exports-only',
      },
    },
  });
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const at = (path: string) => new URL(path, 'http://127.0.0.1:51234');

describe('modules served by the dev server', () => {
  test('a script module is requested at its source path', () => {
    const modules = resolveServedModules({ kind: 'dev-server' }, appRoot);
    expect(modules.moduleUrl('src/page-modules.ts')).toBe('/src/page-modules.ts');
  });

  test('a JSON module is requested as an import, the way the app’s own import requests it', () => {
    const modules = resolveServedModules({ kind: 'dev-server' }, appRoot);
    expect(modules.moduleUrl('src/locales/es/messages.json')).toBe(
      '/src/locales/es/messages.json?import',
    );
  });

  test('a source the app does not have is refused rather than given a URL nothing serves', () => {
    const modules = resolveServedModules({ kind: 'dev-server' }, appRoot);
    expect(() => modules.moduleUrl('src/locales/de/messages.json')).toThrow(
      'src/locales/de/messages.json is not a source file of the app, so the dev server serves no module for it',
    );
  });

  test('the entry script is the shell’s one module script', () => {
    const modules = resolveServedModules({ kind: 'dev-server' }, appRoot);
    expect(modules.entryScriptUrl()).toBe('/src/main.ts');
  });

  test('a shell with two module scripts names no single entry script', () => {
    const twoEntries = app({
      'index.html':
        '<!doctype html><script type="module" src="/src/main.ts"></script><script src="/classic.js"></script><script type="module" src="/src/second.ts"></script>\n',
    });
    const modules = resolveServedModules({ kind: 'dev-server' }, twoEntries);
    expect(() => modules.entryScriptUrl()).toThrow(
      'index.html has 2 module scripts, so it names no single entry script',
    );
  });

  test('a module route matches the request with any query and nothing else', () => {
    const route = resolveServedModules({ kind: 'dev-server' }, appRoot).moduleRoute(
      'src/locales/es/messages.json',
    );
    expect(route(at('/src/locales/es/messages.json?import'))).toBe(true);
    expect(route(at('/src/locales/es/messages.json?import&t=1791000000000'))).toBe(true);
    expect(route(at('/src/locales/fr/messages.json?import'))).toBe(false);
    expect(route(at('/locales/es/messages.json'))).toBe(false);
  });

  test('a module another module imports is delayed at its own request', () => {
    const route = resolveServedModules({ kind: 'dev-server' }, appRoot).moduleRoute(
      'src/lazy-child.ts',
    );
    expect(route(at('/src/lazy-child.ts'))).toBe(true);
    expect(route(at('/src/lazy.ts'))).toBe(false);
  });
});

describe('modules served by the prebuilt DEV app', () => {
  test('a lazily loaded module is requested at its own chunk', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    const route = modules.moduleRoute('src/locales/es/messages.json');
    const url = modules.moduleUrl('src/locales/es/messages.json');
    expect(url).toMatch(/^\/assets\/messages-[\w-]+\.js$/);
    expect(route(at(url))).toBe(true);
    expect(route(at(modules.moduleUrl('src/locales/fr/messages.json')))).toBe(false);
  });

  test('a separate entry keeps the exports a page imports from it', async () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    const chunk: { shared?: unknown } = await import(
      join(outputDir, 'dist', modules.moduleUrl('src/page-modules.ts'))
    );
    expect(chunk.shared).toBe('shared');
  });

  test('the entry script is the chunk the shell starts', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    const entry = modules.entryScriptUrl();
    expect(entry).toMatch(/^\/assets\/index-[\w-]+\.js$/);
    expect(modules.entryScriptRoute()(at(entry))).toBe(true);
    expect(modules.entryScriptRoute()(at(modules.moduleUrl('src/lazy.ts')))).toBe(false);
  });

  test('a module bundled into another chunk is refused, since no request serves it alone', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    expect(() => modules.moduleUrl('src/main.ts')).toThrow(
      /^src\/main\.ts names no chunk of the prebuilt DEV app \(.+\), so no request serves it alone$/,
    );
  });

  test('a module bundled into its importer’s chunk is delayed through that chunk when its importer is too', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    const lazyChunk = modules.moduleUrl('src/lazy.ts');
    const route = modules.moduleRoute('src/lazy.ts', 'src/lazy-child.ts');
    expect(route(at(lazyChunk))).toBe(true);
    expect(route(at(modules.moduleUrl('src/locales/es/messages.json')))).toBe(false);
  });

  test('a module bundled into a chunk the route does not otherwise delay is refused', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    expect(() => modules.moduleRoute('src/lazy-child.ts')).toThrow(
      /^src\/lazy-child\.ts is bundled into assets\/lazy-[\w-]+\.js, the chunk of src\/lazy\.ts, which this route does not delay, so delaying it would delay more than src\/lazy-child\.ts$/,
    );
  });

  test('a module bundled into a chunk two entries share is refused, since no module loads that chunk on its own', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    expect(() => modules.moduleRoute('src/shared.ts')).toThrow(
      /^src\/shared\.ts is bundled into assets\/[\w-]+\.js, which no single module loads on its own, so delaying it would delay more than src\/shared\.ts$/,
    );
  });

  test('a module bundled into the entry chunk is refused, since delaying it would hold the whole app', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    expect(() => modules.moduleRoute('src/main.ts')).toThrow(
      /^src\/main\.ts is bundled into assets\/index-[\w-]+\.js, the chunk of index\.html, which this route does not delay/,
    );
  });

  test('a source the build never bundled is refused rather than given a route that matches nothing', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    expect(() => modules.moduleRoute('src/unused.ts')).toThrow(
      /^src\/unused\.ts is in no chunk of the prebuilt DEV app \(.+\)$/,
    );
  });

  test('a route with no source to match is refused', () => {
    const modules = resolveServedModules({ kind: 'prebuilt', outputDir }, appRoot);
    expect(() => modules.moduleRoute()).toThrow(
      'a module route needs at least one source to match',
    );
  });
});

describe('the prebuilt module manifest', () => {
  test('an entry naming no file is refused', () => {
    expect(() => parseModuleManifest({ 'src/lazy.ts': { isDynamicEntry: true } })).toThrow(
      'the prebuilt module manifest entry for src/lazy.ts names no file',
    );
  });

  test('a chunk map entry naming no chunk is refused', () => {
    expect(() => parseModuleChunks({ 'src/lazy.ts': '' })).toThrow(
      'the prebuilt module chunk map names no chunk for src/lazy.ts',
    );
  });

  test('a manifest that is not an object is refused', () => {
    expect(() => parseModuleManifest(['assets/index.js'])).toThrow(
      'the prebuilt module manifest is not a JSON object',
    );
  });
});
