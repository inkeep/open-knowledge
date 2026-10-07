import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  prebuiltManifest,
  prebuiltServingDecision,
  reuseDecision,
  serverFingerprint,
} from './test-server-inputs';

const OK_TREE: Readonly<Record<string, string>> = {
  'package.json': '{"name":"open-knowledge"}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'packages/app/package.json': '{"name":"@inkeep/open-knowledge-app"}\n',
  'packages/app/vite.config.ts': 'export default {};\n',
  'packages/app/src/App.tsx': 'export const App = () => null;\n',
  'packages/app/src/server/hocuspocus-plugin.ts': 'export const hocuspocusPlugin = () => ({});\n',
  'packages/core/src/index.ts': 'export const core = 1;\n',
  'packages/server/src/index.ts': 'export const server = 1;\n',
};

const WORKER_ENV = { OK_TEST_GIT_ENABLED: '1' };

const roots: string[] = [];

function okTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-server-inputs-'));
  roots.push(root);
  for (const [path, content] of Object.entries(OK_TREE)) write(root, path, content);
  return root;
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('server reuse eligibility', () => {
  test('an edit to the server source makes the admitted server ineligible and names the file', () => {
    const root = okTree();
    const admitted = serverFingerprint(root, WORKER_ENV);

    write(root, 'packages/server/src/index.ts', 'export const server = 2;\n');

    expect(reuseDecision(admitted, serverFingerprint(root, WORKER_ENV))).toEqual({
      reuse: false,
      changedInputs: ['packages/server/src/index.ts'],
      changedEnv: [],
    });
  });

  test('edits to app source the dev server transforms on request leave the admitted server reusable', () => {
    const root = okTree();
    const admitted = serverFingerprint(root, WORKER_ENV);

    write(root, 'packages/app/src/App.tsx', 'export const App = () => "edited";\n');
    write(
      root,
      'packages/app/src/components/NewPanel.tsx',
      'export const NewPanel = () => null;\n',
    );
    write(root, 'packages/app/src/locales/en/messages.po', 'msgid "Save"\nmsgstr "Save"\n');

    expect(reuseDecision(admitted, serverFingerprint(root, WORKER_ENV))).toEqual({ reuse: true });
  });

  test('core source, the lockfile, shared configuration and the Node-side dev server plugin each make the admitted server ineligible', () => {
    const edits = [
      ['packages/core/src/index.ts', 'export const core = 2;\n'],
      ['pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters: {}\n"],
      ['package.json', '{"name":"open-knowledge","private":true}\n'],
      ['packages/app/vite.config.ts', 'export default { server: {} };\n'],
      [
        'packages/app/src/server/hocuspocus-plugin.ts',
        'export const hocuspocusPlugin = () => null;\n',
      ],
    ] as const;

    const decisions = edits.map(([path, content]) => {
      const root = okTree();
      const admitted = serverFingerprint(root, WORKER_ENV);
      write(root, path, content);
      return reuseDecision(admitted, serverFingerprint(root, WORKER_ENV));
    });

    expect(decisions).toEqual(
      edits.map(([path]) => ({ reuse: false, changedInputs: [path], changedEnv: [] })),
    );
  });

  test('a server source file added or removed after admission makes the server ineligible', () => {
    const root = okTree();
    const admitted = serverFingerprint(root, WORKER_ENV);

    write(root, 'packages/server/src/routes/new-route.ts', 'export const route = 1;\n');
    rmSync(join(root, 'packages/core/src/index.ts'));

    expect(reuseDecision(admitted, serverFingerprint(root, WORKER_ENV))).toEqual({
      reuse: false,
      changedInputs: ['packages/core/src/index.ts', 'packages/server/src/routes/new-route.ts'],
      changedEnv: [],
    });
  });

  test('the core and server build output the dev server writes at startup leaves the admitted server reusable', () => {
    const root = okTree();
    const admitted = serverFingerprint(root, WORKER_ENV);

    write(root, 'packages/core/dist/index.mjs', 'export const core = 1;\n');
    write(root, 'packages/server/dist/index.mjs', 'export const server = 1;\n');
    write(root, 'packages/server/.turbo/turbo-build.log', 'built\n');
    write(root, 'packages/server/node_modules/.vite/deps.json', '{}\n');

    expect(reuseDecision(admitted, serverFingerprint(root, WORKER_ENV))).toEqual({ reuse: true });
  });

  test('a changed worker environment makes the admitted server ineligible without recording the values', () => {
    const root = okTree();
    const admitted = serverFingerprint(root, { ...WORKER_ENV, OK_TEST_TOKEN: 'secret-before' });
    const current = serverFingerprint(root, {
      OK_TEST_TOKEN: 'secret-after',
      OK_TEST_EXTRA: 'on',
    });

    expect(reuseDecision(admitted, current)).toEqual({
      reuse: false,
      changedInputs: [],
      changedEnv: ['OK_TEST_EXTRA', 'OK_TEST_GIT_ENABLED', 'OK_TEST_TOKEN'],
    });
    expect(JSON.stringify([admitted, current])).not.toMatch(/secret-(?:before|after)/);
  });
});

const BUILD_OPTIONS = { mode: 'development', devHooks: true };

describe('prebuilt DEV output freshness', () => {
  test('an app source edit after the build refuses the recorded output and names the file', () => {
    const root = okTree();
    const recorded = prebuiltManifest(root, BUILD_OPTIONS);

    write(root, 'packages/app/src/App.tsx', 'export const App = () => "edited";\n');

    expect(prebuiltServingDecision(recorded, prebuiltManifest(root, BUILD_OPTIONS))).toEqual({
      serve: false,
      reason: 'stale',
      changedInputs: ['packages/app/src/App.tsx'],
      changedOptions: [],
    });
  });

  test('core, server, dependency pins, locale catalogs and HTML entries are all inputs of the recorded output', () => {
    const edits = [
      ['packages/core/src/index.ts', 'export const core = 2;\n'],
      ['packages/server/src/index.ts', 'export const server = 2;\n'],
      ['pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters: {}\n"],
      ['packages/app/src/locales/es/messages.po', 'msgid "Save"\nmsgstr "Guardar"\n'],
      ['packages/app/index.html', '<!doctype html><div id="root"></div>\n'],
    ] as const;

    const decisions = edits.map(([path, content]) => {
      const root = okTree();
      const recorded = prebuiltManifest(root, BUILD_OPTIONS);
      write(root, path, content);
      return prebuiltServingDecision(recorded, prebuiltManifest(root, BUILD_OPTIONS));
    });

    expect(decisions).toEqual(
      edits.map(([path]) => ({
        serve: false,
        reason: 'stale',
        changedInputs: [path],
        changedOptions: [],
      })),
    );
  });

  test('a changed build option refuses the recorded output and names the option', () => {
    const root = okTree();
    const recorded = prebuiltManifest(root, BUILD_OPTIONS);

    expect(
      prebuiltServingDecision(
        recorded,
        prebuiltManifest(root, { ...BUILD_OPTIONS, devHooks: false }),
      ),
    ).toEqual({ serve: false, reason: 'stale', changedInputs: [], changedOptions: ['devHooks'] });
  });

  test('the output the build itself writes leaves the recorded manifest fresh', () => {
    const root = okTree();
    const recorded = prebuiltManifest(root, BUILD_OPTIONS);

    write(root, 'packages/app/dist/index.html', '<!doctype html>\n');
    write(root, 'packages/app/public/excalidraw-assets/fonts/Virgil.woff2', 'font\n');
    write(root, 'packages/core/dist/index.mjs', 'export const core = 1;\n');

    expect(prebuiltServingDecision(recorded, prebuiltManifest(root, BUILD_OPTIONS))).toEqual({
      serve: true,
    });
  });

  test('without a recorded manifest the prebuilt output is refused as missing', () => {
    const root = okTree();

    expect(prebuiltServingDecision(undefined, prebuiltManifest(root, BUILD_OPTIONS))).toEqual({
      serve: false,
      reason: 'missing',
    });
  });
});
