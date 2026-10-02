import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import { loadConfigFromFile } from 'vite';
import { describe, expect, test } from 'vitest';

const APP_PACKAGE_ROOT = resolve(import.meta.dirname, '../..');
const APP_VITE_CONFIG = resolve(APP_PACKAGE_ROOT, 'vite.config.ts');
const WORKER_FIXTURES = resolve(APP_PACKAGE_ROOT, 'tests/stress/_helpers/fixtures.ts');

const CACHE_DIR_ENV_VAR = 'OK_TEST_VITE_CACHE_DIR';

function inspectWorkerCache(source: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { noLib: true } });
  const syntax = project.createSourceFile('/input.ts', source);
  const file = project.createSourceFile(
    '/fixtures.ts',
    ts.transpile(source, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    }),
  );
  const imported = (module: string, name: string) => {
    const declaration =
      file.getImportDeclaration(module) ?? file.getImportDeclaration(module.replace('node:', ''));
    const entry = declaration?.getNamedImports().find((item) => item.getName() === name);
    return (entry?.getAliasNode() ?? entry?.getNameNode())?.getSymbol();
  };
  const returned = new Map<import('ts-morph').Symbol, Node>();
  const value = (node: Node | undefined, seen = new Set<Node>()): Node | undefined => {
    if (!node || seen.has(node)) return undefined;
    const next = new Set(seen).add(node);
    if (Node.isParenthesizedExpression(node) || Node.isAwaitExpression(node))
      return value(node.getExpression(), next);
    if (Node.isVariableDeclaration(node))
      return value(node.getInitializer() ?? returned.get(node.getSymbolOrThrow()), next);
    if (Node.isPropertyAssignment(node)) return value(node.getInitializer(), next);
    if (Node.isShorthandPropertyAssignment(node))
      return value(node.getValueSymbol()?.getDeclarations()[0], next);
    if (Node.isIdentifier(node)) {
      const declaration = node.getSymbol()?.getDeclarations()[0];
      return declaration &&
        (Node.isVariableDeclaration(declaration) || Node.isBindingElement(declaration))
        ? value(declaration, next)
        : node;
    }
    if (Node.isBindingElement(node)) {
      const owner = node.getParent().getParent();
      const object = Node.isVariableDeclaration(owner)
        ? value(owner.getInitializer(), next)
        : undefined;
      const name = node.getPropertyNameNode();
      const key = name && Node.isIdentifier(name) ? ts.idText(name.compilerNode) : node.getName();
      const field = object?.getType().getProperty(key)?.getDeclarations()[0];
      return field ? value(field, next) : node;
    }
    return node;
  };
  const property = (node: Node | undefined, key: string) =>
    value(
      value(node)
        ?.asKind(SyntaxKind.ObjectLiteralExpression)
        ?.getProperties()
        .find((field) => field.getSymbol()?.getName() === key),
    );
  const calls = file.getDescendantsOfKind(SyntaxKind.CallExpression);
  const phase = file.getFunction('spendOnBudgetPhase')?.getSymbol();
  for (const call of calls) {
    if (!phase || value(call.getExpression())?.getSymbol() !== phase) continue;
    const callback = call.getArguments()[1];
    const result = callback
      ?.getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .find(
        (statement) =>
          statement.getFirstAncestor((node) => ts.isFunctionLike(node.compilerNode)) === callback,
      )
      ?.getExpression();
    const assignment = call.getFirstAncestorByKind(SyntaxKind.BinaryExpression);
    const binding = assignment?.getLeft().getSymbol();
    if (result && binding && assignment?.getOperatorToken().getKind() === SyntaxKind.EqualsToken)
      returned.set(binding, result);
  }
  const declaration = file.getVariableDeclaration('test');
  const extend = declaration?.getInitializerIfKind(SyntaxKind.CallExpression);
  const callee = extend?.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
  const fixture = property(extend?.getArguments()[0], 'workerServer')
    ?.asKind(SyntaxKind.ArrayLiteralExpression)
    ?.getElements()[0]
    ?.asKind(SyntaxKind.ArrowFunction);
  const base = imported('@playwright/test', 'test');
  const worker = fixture?.getParameters()[2]?.getSymbol();
  const spawn = imported('node:child_process', 'spawn');
  const fresh = imported('node:fs', 'mkdtempSync');
  const removals = [
    imported('node:fs', 'rmSync'),
    imported('./teardown-fs.ts', 'removeAllDuringTeardown'),
  ].filter((symbol) => symbol !== undefined);
  const spawns = (fixture?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []).filter(
    (call) => spawn && value(call.getExpression())?.getSymbol() === spawn,
  );
  const census = Object.entries({
    syntax: project.getProgram().getSyntacticDiagnostics(syntax).length === 0,
    test: !!declaration?.getVariableStatement()?.isExported(),
    extend: callee?.getName() === 'extend' && !!base && callee.getExpression().getSymbol() === base,
    workerServer: !!fixture,
    workerInfo: !!worker,
    spawn: spawns.length > 0,
  }).flatMap(([name, holds]) => (holds ? [] : [name]));
  const unique = (input: Node | undefined): boolean => {
    const node = value(input);
    return (
      !!node &&
      [node, ...node.getDescendants()].some(
        (part) =>
          (Node.isCallExpression(part) &&
            !!fresh &&
            value(part.getExpression())?.getSymbol() === fresh) ||
          (Node.isPropertyAccessExpression(part) &&
            part.getName() === 'workerIndex' &&
            value(part.getExpression())?.getSymbol() === worker),
      )
    );
  };
  const cacheProperties = file
    .getDescendants()
    .filter(
      (node) =>
        (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) &&
        node.getSymbol()?.getName() === CACHE_DIR_ENV_VAR,
    );
  const nonUnique = cacheProperties.filter((node) => !unique(node)).length;
  let missingEnv = 0,
    missingCleanup = 0,
    teardowns = 0;
  const reclaims = calls.filter((call) =>
    removals.some((symbol) => value(call.getExpression())?.getSymbol() === symbol),
  );
  const blocksOf = (resource: Node | undefined) =>
    resource
      ? reclaims
          .filter((call) => call.getArguments().some((arg) => value(arg) === resource))
          .map((call) => call.getFirstAncestorByKind(SyntaxKind.Block))
      : [];
  for (const call of spawns) {
    const env = property(call.getArguments()[2], 'env');
    const cache = property(env, CACHE_DIR_ENV_VAR);
    if (!cache) {
      missingEnv++;
      continue;
    }
    const contents = blocksOf(property(env, 'OK_TEST_CONTENT_DIR'));
    const caches = new Set(blocksOf(cache));
    teardowns += contents.length;
    missingCleanup +=
      Number(contents.length < 2) + contents.filter((block) => !block || !caches.has(block)).length;
  }
  return { census, missingEnv, nonUnique, missingCleanup, spawns: spawns.length, teardowns };
}

async function withEnv<T>(
  key: string,
  value: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const orig = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await body();
  } finally {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
}

describe('per-worker Vite cacheDir isolation — vite.config.ts side', () => {
  test('A1: resolves cacheDir from OK_TEST_VITE_CACHE_DIR env var', async () => {
    const expected = '/tmp/ok-vite-cachedir-isolation-test-a1';
    await withEnv(CACHE_DIR_ENV_VAR, expected, async () => {
      const result = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        APP_VITE_CONFIG,
        APP_PACKAGE_ROOT,
      );
      expect(result?.config.cacheDir).toBe(expected);
    });
  });

  test('A2: distinct OK_TEST_VITE_CACHE_DIR values produce distinct resolved cacheDirs (anti-vacuousness)', async () => {
    const pathW0 = '/tmp/ok-vite-cachedir-isolation-test-a2-w0';
    const pathW1 = '/tmp/ok-vite-cachedir-isolation-test-a2-w1';
    const cacheW0 = await withEnv(CACHE_DIR_ENV_VAR, pathW0, async () => {
      const r = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        APP_VITE_CONFIG,
        APP_PACKAGE_ROOT,
      );
      return r?.config.cacheDir;
    });
    const cacheW1 = await withEnv(CACHE_DIR_ENV_VAR, pathW1, async () => {
      const r = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        APP_VITE_CONFIG,
        APP_PACKAGE_ROOT,
      );
      return r?.config.cacheDir;
    });
    expect(cacheW0).toBe(pathW0);
    expect(cacheW1).toBe(pathW1);
    expect(cacheW0).not.toBe(cacheW1);
  });
});

describe('per-worker Vite cacheDir isolation — workerServer fixture side', () => {
  const inspect = () => inspectWorkerCache(readFileSync(WORKER_FIXTURES, 'utf8'));
  test(`B1: workerServer spawn() env declares ${CACHE_DIR_ENV_VAR}`, () => {
    const result = inspect();
    expect(result.census).toEqual([]);
    expect(
      result.missingEnv,
      `Declare ${CACHE_DIR_ENV_VAR} on the workerServer fixture's spawn env. Otherwise workers share Vite's default node_modules/.vite cache, whose optimizer is single-writer. See PR #1146 AC-T3 / F1.`,
    ).toBe(0);
  });
  test(`B2: ${CACHE_DIR_ENV_VAR} value is per-worker unique (references workerInfo.workerIndex or mkdtempSync)`, () => {
    const result = inspect();
    expect(result.census).toEqual([]);
    expect(result.missingEnv).toBe(0);
    expect(
      result.nonUnique,
      `${CACHE_DIR_ENV_VAR} must be, or be bound through variables to, an expression that itself calls the imported mkdtempSync or reads the fixture's workerInfo.workerIndex. A static string does not isolate workers, and an index first read into another variable is not followed.`,
    ).toBe(0);
  });
  test(`B3: workerServer teardown reclaims the per-worker ${CACHE_DIR_ENV_VAR} at both teardown sites`, () => {
    const result = inspect();
    expect(result.census).toEqual([]);
    expect(result.missingEnv).toBe(0);
    expect(
      result.missingCleanup,
      `Bind ${CACHE_DIR_ENV_VAR} to a local variable and reclaim the same resource alongside contentDir at BOTH failure and happy teardown sites. Recognised primitives are node:fs rmSync and teardown-fs removeAllDuringTeardown; admit a new removal primitive by adding its import to the removals list in inspectWorkerCache. Missing cleanup leaves orphan Vite cache directories under packages/app/node_modules.`,
    ).toBe(0);
    expect(result.teardowns).toBeGreaterThanOrEqual(2);
  });
});

const workerFixture = `import { test as base } from '@playwright/test';
  import { spawn } from 'node:child_process';
  import { mkdtempSync, rmSync } from 'node:fs';
  export const test = base.extend({ workerServer: [async ({}, use, workerInfo) => {
    const contentDir = mkdtempSync('content');
    const viteCacheDir = mkdtempSync('cache');
    spawn('pnpm', [], { env: { OK_TEST_CONTENT_DIR: contentDir, OK_TEST_VITE_CACHE_DIR: viteCacheDir } });
    try { await use(); } catch { rmSync(contentDir); rmSync(viteCacheDir); }
    rmSync(contentDir); rmSync(viteCacheDir);
  }, { scope: 'worker' }] });`;

const phasedFixture = `import { test as base } from '@playwright/test';
  import { spawn } from 'node:child_process';
  import { mkdtempSync, rmSync } from 'node:fs';
  async function spendOnBudgetPhase(phase, body) { return body(); }
  export const test = base.extend({ workerServer: [async ({}, use, workerInfo) => {
    let started;
    started = await spendOnBudgetPhase(0, async () => {
      const contentDir = mkdtempSync('content');
      const viteCacheDir = mkdtempSync('cache');
      const log = () => { return 0; };
      try { spawn('pnpm', [], { env: { OK_TEST_CONTENT_DIR: contentDir, OK_TEST_VITE_CACHE_DIR: viteCacheDir } }); }
      catch { rmSync(contentDir); rmSync(viteCacheDir); }
      return { contentDir, viteCacheDir };
    });
    const { contentDir, viteCacheDir } = started;
    await use();
    rmSync(contentDir); rmSync(viteCacheDir);
  }, { scope: 'worker' }] });`;

describe('worker cache rule self-test', () => {
  test('accepts a unique reclaimed cache and rejects the adjacent shared cache', () => {
    expect(inspectWorkerCache(workerFixture)).toEqual({
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 1,
      teardowns: 2,
    });
    expect(
      inspectWorkerCache(workerFixture.replace("mkdtempSync('cache')", "'shared'")).nonUnique,
    ).toBe(1);
    expect(
      inspectWorkerCache(
        workerFixture
          .replace("mkdtempSync('cache')", "'shared'; const OK_TEST_VITE_CACHE_DIR = viteCacheDir")
          .replace('OK_TEST_VITE_CACHE_DIR: viteCacheDir', 'OK_TEST_VITE_CACHE_DIR'),
      ),
    ).toMatchObject({ missingEnv: 0, nonUnique: 1, missingCleanup: 0 });
    for (const shared of [
      "prepareViteCacheDir('shared')",
      "'cache-' + ({ workerIndex: 0 }).workerIndex",
    ]) {
      expect(
        inspectWorkerCache(workerFixture.replace("mkdtempSync('cache')", shared)).nonUnique,
        shared,
      ).toBe(1);
    }
  });
  test('requires the spawn entry and both cleanup sites', () => {
    expect(
      inspectWorkerCache(workerFixture.replace('OK_TEST_VITE_CACHE_DIR:', 'OTHER:')).missingEnv,
    ).toBe(1);
    expect(
      inspectWorkerCache(workerFixture.replace('rmSync(viteCacheDir);', '')).missingCleanup,
    ).toBe(1);
    expect(
      inspectWorkerCache(workerFixture.replace('rmSync(viteCacheDir);\n', '\n')).missingCleanup,
    ).toBe(1);
  });
  test('reads the setup phase result past a nested block-bodied return', () => {
    expect(inspectWorkerCache(phasedFixture)).toEqual({
      census: [],
      missingEnv: 0,
      nonUnique: 0,
      missingCleanup: 0,
      spawns: 1,
      teardowns: 2,
    });
  });
  test('ignores comments and refuses a forwarding or unparseable fixture', () => {
    expect(
      inspectWorkerCache(`${workerFixture} /* OK_TEST_VITE_CACHE_DIR: 'shared' */`).nonUnique,
    ).toBe(0);
    expect(inspectWorkerCache("export {test} from './moved.ts';").census).toEqual([
      'test',
      'extend',
      'workerServer',
      'workerInfo',
      'spawn',
    ]);
    expect(inspectWorkerCache(`${workerFixture} const = ;`).census).toEqual(['syntax']);
  });
});
