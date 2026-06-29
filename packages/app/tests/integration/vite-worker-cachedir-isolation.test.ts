
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { type Node, Project, SyntaxKind } from 'ts-morph';
import { loadConfigFromFile } from 'vite';

const APP_PACKAGE_ROOT = resolve(import.meta.dirname, '../..');
const APP_VITE_CONFIG = resolve(APP_PACKAGE_ROOT, 'vite.config.ts');
const WORKER_FIXTURES = resolve(APP_PACKAGE_ROOT, 'tests/stress/_helpers/fixtures.ts');

const CACHE_DIR_ENV_VAR = 'OK_TEST_VITE_CACHE_DIR';

function parseSource(filePath: string) {
  const project = new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { noLib: true, allowJs: false },
  });
  return project.addSourceFileAtPath(filePath);
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

function classifyPerWorkerExpression(node: Node): { ok: boolean; why: string } {
  const text = node.getText();
  if (text.includes('workerInfo.workerIndex')) {
    return { ok: true, why: 'references workerInfo.workerIndex' };
  }
  if (text.includes('mkdtempSync')) {
    return {
      ok: true,
      why: 'uses mkdtempSync (fresh dir per call → per-worker unique by construction)',
    };
  }
  if (node.isKind(SyntaxKind.Identifier)) {
    const ident = node.asKindOrThrow(SyntaxKind.Identifier);
    const symbol = ident.getSymbol();
    if (!symbol) {
      return {
        ok: false,
        why: `identifier ${text} has no resolvable symbol; cannot trace declaration`,
      };
    }
    for (const decl of symbol.getDeclarations()) {
      const declText = decl.getText();
      if (declText.includes('workerInfo.workerIndex')) {
        return {
          ok: true,
          why: `identifier ${text} declared at line ${decl.getStartLineNumber()}; declaration references workerInfo.workerIndex`,
        };
      }
      if (declText.includes('mkdtempSync')) {
        return {
          ok: true,
          why: `identifier ${text} declared at line ${decl.getStartLineNumber()}; declaration uses mkdtempSync`,
        };
      }
    }
    return {
      ok: false,
      why: `identifier ${text} traced to declaration(s) that do NOT reference workerInfo.workerIndex or mkdtempSync — a static string variable does not provide per-worker uniqueness`,
    };
  }
  return {
    ok: false,
    why: `expression ${text.slice(0, 100)}${text.length > 100 ? '…' : ''} is not a recognized per-worker-unique form (expected to reference workerInfo.workerIndex or mkdtempSync, either inline or via a single-level identifier)`,
  };
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
  test(`B1: workerServer spawn() env declares ${CACHE_DIR_ENV_VAR}`, () => {
    const sf = parseSource(WORKER_FIXTURES);
    const matches = sf
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .filter((prop) => prop.getName() === CACHE_DIR_ENV_VAR);
    if (matches.length === 0) {
      throw new Error(
        `tests/stress/_helpers/fixtures.ts must declare an \`${CACHE_DIR_ENV_VAR}\` env entry on the workerServer fixture's spawn() call.\n` +
          `Without it, every worker's Vite dev server resolves its cacheDir to the default <root>/node_modules/.vite — a shared directory that the dependency optimizer is single-writer over.\n` +
          `See PR #1146 body for the AC-T3 / F1 e2e flake class this contract closes.`,
      );
    }
    expect(matches.length).toBeGreaterThan(0);
  });

  test(`B2: ${CACHE_DIR_ENV_VAR} value is per-worker unique (references workerInfo.workerIndex or mkdtempSync)`, () => {
    const sf = parseSource(WORKER_FIXTURES);
    const props = sf
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .filter((prop) => prop.getName() === CACHE_DIR_ENV_VAR);
    if (props.length === 0) {
      throw new Error(
        `B2 prerequisite missing: no \`${CACHE_DIR_ENV_VAR}\` property in fixtures.ts (B1 should have failed first).`,
      );
    }
    const failures: string[] = [];
    for (const prop of props) {
      const initializer = prop.getInitializer();
      if (!initializer) {
        failures.push(`${prop.getName()} at line ${prop.getStartLineNumber()} has no initializer`);
        continue;
      }
      const verdict = classifyPerWorkerExpression(initializer);
      if (!verdict.ok) {
        failures.push(`${CACHE_DIR_ENV_VAR} at line ${prop.getStartLineNumber()}: ${verdict.why}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        [
          `\`${CACHE_DIR_ENV_VAR}\` value must be per-worker unique. Acceptable shapes:`,
          `  - Template literal referencing workerInfo.workerIndex, e.g.:`,
          `      \`${CACHE_DIR_ENV_VAR}: join(APP_PACKAGE_ROOT, 'node_modules', \\\`.vite-w\${workerInfo.workerIndex}\\\`)\``,
          `  - Computed via mkdtempSync, e.g.:`,
          `      \`OK_TEST_VITE_CACHE_DIR: mkdtempSync(join(APP_PACKAGE_ROOT, 'node_modules', \\\`.vite-w\${workerInfo.workerIndex}-\\\`))\``,
          `  - Bound to a local variable (single-level identifier) whose declaration matches one of the above`,
          ``,
          `Violations:`,
          ...failures.map((f) => `  - ${f}`),
        ].join('\n'),
      );
    }
    expect(failures).toEqual([]);
  });

  test(`B3: workerServer teardown reclaims the per-worker ${CACHE_DIR_ENV_VAR} at both teardown sites`, () => {
    const sf = parseSource(WORKER_FIXTURES);

    const props = sf
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .filter((prop) => prop.getName() === CACHE_DIR_ENV_VAR);
    if (props.length === 0) {
      throw new Error(
        `B3 prerequisite missing: no \`${CACHE_DIR_ENV_VAR}\` property in fixtures.ts (B1 should have failed first).\n` +
          `Without the property, there is no identifier to pass to \`rmSync\` at teardown — so the per-worker Vite cacheDir cannot be reclaimed and CI accumulates orphan directories under tmpdir() until the runner's filesystem fills.`,
      );
    }
    const initializer = props[0]?.getInitializer();
    if (!initializer) {
      throw new Error(
        `B3 prerequisite missing: \`${CACHE_DIR_ENV_VAR}\` property at line ${props[0]?.getStartLineNumber()} has no initializer.`,
      );
    }
    if (!initializer.isKind(SyntaxKind.Identifier)) {
      throw new Error(
        `B3 requires \`${CACHE_DIR_ENV_VAR}\` to be bound to a named local variable so the workerServer fixture can \`rmSync\` the same path at teardown.\n` +
          `Found initializer at line ${initializer.getStartLineNumber()}: \`${initializer.getText().slice(0, 80)}\` (kind: ${initializer.getKindName()}).\n` +
          `Acceptable shape: \`const viteCacheDir = mkdtempSync(...); ...; ${CACHE_DIR_ENV_VAR}: viteCacheDir,\`.`,
      );
    }
    const cacheDirVar = initializer.getText();

    const allCalls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    const rmSyncMatching = (targetName: string) =>
      allCalls.filter((call) => {
        if (call.getExpression().getText() !== 'rmSync') return false;
        const firstArg = call.getArguments()[0];
        if (!firstArg) return false;
        return firstArg.isKind(SyntaxKind.Identifier) && firstArg.getText() === targetName;
      });
    const contentDirTeardowns = rmSyncMatching('contentDir');
    const cacheDirTeardowns = rmSyncMatching(cacheDirVar);

    if (contentDirTeardowns.length < 2) {
      throw new Error(
        `B3 expected at least 2 \`rmSync(contentDir, ...)\` calls to anchor the failure-path + happy-path teardown sites; found ${contentDirTeardowns.length}.\n` +
          `If the fixture's teardown structure was refactored, update this assertion to reflect the new pattern.`,
      );
    }

    const missing: string[] = [];
    for (const cTeardown of contentDirTeardowns) {
      const parentBlock = cTeardown.getFirstAncestorByKind(SyntaxKind.Block);
      if (!parentBlock) {
        missing.push(
          `\`rmSync(contentDir, ...)\` at line ${cTeardown.getStartLineNumber()} has no Block ancestor; cannot locate sibling teardown for ${cacheDirVar}`,
        );
        continue;
      }
      const sibling = cacheDirTeardowns.find(
        (cdt) => cdt.getFirstAncestorByKind(SyntaxKind.Block) === parentBlock,
      );
      if (!sibling) {
        missing.push(
          `teardown site near \`rmSync(contentDir, ...)\` at line ${cTeardown.getStartLineNumber()} is missing a sibling \`rmSync(${cacheDirVar}, ...)\` in the same block`,
        );
      }
    }

    if (missing.length > 0) {
      throw new Error(
        [
          `tests/stress/_helpers/fixtures.ts must \`rmSync(${cacheDirVar}, { recursive: true, force: true })\` at BOTH teardown sites — the failure-path catch block AND the happy-path after-\`use\` block — mirroring the existing \`rmSync(contentDir, ...)\` pattern.`,
          `Without cleanup at both sites, CI accumulates orphan per-worker Vite cache directories under tmpdir() until the runner's filesystem fills.`,
          ``,
          `Missing:`,
          ...missing.map((m) => `  - ${m}`),
        ].join('\n'),
      );
    }
    expect(missing).toEqual([]);
  });
});
