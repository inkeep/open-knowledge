import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const APP_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKSPACE_ROOT = join(APP_PACKAGE_ROOT, '..', '..');
const APP_PACKAGE_NAME = '@inkeep/open-knowledge-app';
const FRESHNESS_GLOBAL_SETUP = './tests/stress/_helpers/i18n-catalog-freshness.ts';
const TURBO_DRY_RUN_TIMEOUT_MS = 120_000;
const TURBO_DRY_RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const TURBO_OUTPUT_HEAD_CHARS = 400;

const PLAYWRIGHT_TIERS = {
  e2e: {
    configFile: 'playwright.config.ts',
    turboTask: 'test:e2e',
    load: () => import('../../playwright.config'),
  },
  a11y: {
    configFile: 'playwright.a11y.config.ts',
    turboTask: 'test:a11y',
    load: () => import('../../playwright.a11y.config'),
  },
  visual: {
    configFile: 'playwright.visual.config.ts',
    turboTask: 'test:visual',
    load: () => import('../../playwright.visual.config'),
  },
} as const;

type TierName = keyof typeof PLAYWRIGHT_TIERS;
const TIER_NAMES = Object.keys(PLAYWRIGHT_TIERS) as TierName[];

type TurboTaskDefinition = Record<string, unknown>;
type TurboDryRun = {
  tasks: { taskId: string; dependencies: string[]; resolvedTaskDefinition?: TurboTaskDefinition }[];
};

const SCOPED_OVERRIDE_TASKS = ['test:a11y', 'test:visual'] as const;

let unfilteredDefinitions: Map<string, TurboTaskDefinition> | undefined;

let resolvedGraph: Map<string, string[]> | undefined;

function turboOutputHead(stdout: string): string {
  if (stdout.length === 0) return 'empty';
  const head = stdout.slice(0, TURBO_OUTPUT_HEAD_CHARS);
  return `${stdout.length} chars, of which the first ${head.length} are:\n${head}`;
}

export function parseTurboDryRun(stdout: string, invocation: string): TurboDryRun {
  const objectStart = stdout.indexOf('{');
  if (objectStart < 0) {
    throw new Error(
      `${invocation} exited 0 but wrote no "{" to stdout, so the Playwright tiers' build ordering was never checked. turbo documents no stream or shape contract for --dry=json (its machine-readable guarantees attach to --json and --log-file), so an upgrade inside the declared ^2.7.0 range may have moved the payload to stderr or dropped it. stdout was ${turboOutputHead(stdout)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(objectStart));
  } catch (cause) {
    throw new Error(
      `${invocation} wrote stdout that is not JSON from its first "{" onward, so the Playwright tiers' build ordering was never checked. turbo documents no shape contract for --dry=json, so an upgrade inside the declared ^2.7.0 range may have interleaved log lines into the payload. stdout was ${turboOutputHead(stdout)}`,
      { cause },
    );
  }
  const tasks = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error(
      `${invocation} produced JSON with no "tasks" array, so the Playwright tiers' build ordering was never checked. turbo's --dry=json field list is explicitly non-exhaustive and carries no shape contract, so an upgrade inside the declared ^2.7.0 range may have renamed or nested it. stdout was ${turboOutputHead(stdout)}`,
    );
  }
  return parsed as TurboDryRun;
}

function turboResolvedGraph(): Map<string, string[]> {
  if (resolvedGraph) return resolvedGraph;
  const turboBin = join(WORKSPACE_ROOT, 'node_modules', '.bin', 'turbo');
  const turboArgs = [
    'run',
    ...TIER_NAMES.map((tier) => PLAYWRIGHT_TIERS[tier].turboTask),
    '--dry=json',
    `--filter=${APP_PACKAGE_NAME}`,
  ];
  const dryRun = spawnSync(turboBin, turboArgs, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf-8',
    timeout: TURBO_DRY_RUN_TIMEOUT_MS,
    maxBuffer: TURBO_DRY_RUN_MAX_BUFFER_BYTES,
  });
  if (dryRun.error || dryRun.status !== 0) {
    throw new Error(
      `could not resolve turbo's task graph, so this run cannot tell whether a Playwright tier races the app build that rewrites src/locales/*/messages.json — ${turboBin} exited ${String(dryRun.status)}${dryRun.signal ? ` on ${dryRun.signal}` : ''}${dryRun.error ? ` (${String(dryRun.error)})` : ''}:\n${dryRun.stderr ?? ''}${dryRun.stdout ?? ''}`,
    );
  }
  const parsed = parseTurboDryRun(
    dryRun.stdout ?? '',
    `${turboBin} ${turboArgs.join(' ')} (cwd ${WORKSPACE_ROOT})`,
  );
  resolvedGraph = new Map(parsed.tasks.map((task) => [task.taskId, task.dependencies]));
  return resolvedGraph;
}

function turboUnfilteredDefinitions(): Map<string, TurboTaskDefinition> {
  if (unfilteredDefinitions) return unfilteredDefinitions;
  const turboBin = join(WORKSPACE_ROOT, 'node_modules', '.bin', 'turbo');
  const turboArgs = ['run', ...SCOPED_OVERRIDE_TASKS, '--dry=json'];
  const dryRun = spawnSync(turboBin, turboArgs, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf-8',
    timeout: TURBO_DRY_RUN_TIMEOUT_MS,
    maxBuffer: TURBO_DRY_RUN_MAX_BUFFER_BYTES,
  });
  if (dryRun.error || dryRun.status !== 0) {
    throw new Error(
      `could not resolve turbo's unfiltered task graph, so this run cannot tell whether a scoped override has drifted from the global entry it replaces — ${turboBin} exited ${String(dryRun.status)}${dryRun.signal ? ` on ${dryRun.signal}` : ''}${dryRun.error ? ` (${String(dryRun.error)})` : ''}:\n${dryRun.stderr ?? ''}${dryRun.stdout ?? ''}`,
    );
  }
  const parsed = parseTurboDryRun(
    dryRun.stdout ?? '',
    `${turboBin} ${turboArgs.join(' ')} (cwd ${WORKSPACE_ROOT})`,
  );
  unfilteredDefinitions = new Map(
    parsed.tasks.flatMap((task) =>
      task.resolvedTaskDefinition ? [[task.taskId, task.resolvedTaskDefinition] as const] : [],
    ),
  );
  return unfilteredDefinitions;
}

function withoutDependsOn(definition: TurboTaskDefinition): TurboTaskDefinition {
  const { dependsOn: _dependsOn, ...rest } = definition;
  return rest;
}

function declaredGlobalSetups(globalSetup: string | string[] | undefined): string[] {
  if (globalSetup === undefined) return [];
  return Array.isArray(globalSetup) ? [...globalSetup] : [globalSetup];
}

describe('i18n catalog freshness gate wiring', () => {
  test.each(TIER_NAMES)(
    'turbo orders the %s tier behind the app build that rewrites the catalogs',
    (tier) => {
      const { turboTask } = PLAYWRIGHT_TIERS[tier];
      const taskId = `${APP_PACKAGE_NAME}#${turboTask}`;
      const dependencies = turboResolvedGraph().get(taskId);
      expect(
        dependencies,
        `turbo's resolved graph has no ${taskId}, so the ${tier} tier's ordering cannot be checked.`,
      ).toBeDefined();
      expect(
        dependencies,
        `${taskId} does not depend on ${APP_PACKAGE_NAME}#build, so turbo may run the app build concurrently with the ${tier} tier. That build runs "pnpm run i18n:compile", which truncates and rewrites all 13 src/locales/*/messages.json, and the ${tier} tier's globalSetup JSON.parses those same files. Add "build" to turbo.json "${turboTask}".dependsOn.`,
      ).toContain(`${APP_PACKAGE_NAME}#build`);
    },
    TURBO_DRY_RUN_TIMEOUT_MS,
  );

  test.each(TIER_NAMES)('the %s tier declares the catalog freshness globalSetup', async (tier) => {
    const { configFile, load } = PLAYWRIGHT_TIERS[tier];
    const declared = declaredGlobalSetups((await load()).default.globalSetup);
    expect(
      declared,
      `the ${tier} tier (packages/app/${configFile}) does not declare ${FRESHNESS_GLOBAL_SETUP} in globalSetup, so it would silently serve the committed src/locales/*/messages.json: every dev server it boots sets OK_TEST_SKIP_I18N_COMPILE, so nothing in the run recompiles them and every assertion reads the committed copy instead of the edit under test. Re-add that path to globalSetup in packages/app/${configFile}.`,
    ).toContain(FRESHNESS_GLOBAL_SETUP);
    expect(
      declared[0],
      `the ${tier} tier (packages/app/${configFile}) declares ${declared[0] ?? '(nothing)'} ahead of ${FRESHNESS_GLOBAL_SETUP} in globalSetup. Playwright runs globalSetup entries in declared order and skips every later one once an earlier one throws (playwright 1.59.1: lib/common/config.js:70 keeps the array's order, lib/runner/tasks.js:107 appends the setups in that order, lib/runner/taskRunner.js:53-76 awaits them one at a time and sets _interrupted on a throw), so anything ahead of the freshness gate either burns the run's setup budget before a failure that was deterministic from the first byte, or — if it writes src/locales/*/messages.json — repairs the staleness the gate exists to catch and leaves the gate reading what the entry ahead of it just wrote. Move ${FRESHNESS_GLOBAL_SETUP} back to the front of globalSetup in packages/app/${configFile}.`,
    ).toBe(FRESHNESS_GLOBAL_SETUP);
    expect(
      existsSync(join(APP_PACKAGE_ROOT, FRESHNESS_GLOBAL_SETUP)),
      `the ${tier} tier (packages/app/${configFile}) names ${FRESHNESS_GLOBAL_SETUP} in globalSetup but no such file exists under packages/app, so the tier declares a freshness gate Playwright cannot load and would silently serve the committed src/locales/*/messages.json under OK_TEST_SKIP_I18N_COMPILE. Point packages/app/${configFile} at the helper's real path.`,
    ).toBe(true);
  });
});

describe('turbo dry-run parse', () => {
  const INVOCATION = '/ok/node_modules/.bin/turbo run test:e2e --dry=json (cwd /ok)';

  function rejectionMessage(stdout: string): string {
    let raised: unknown;
    try {
      parseTurboDryRun(stdout, INVOCATION);
    } catch (error) {
      raised = error;
    }
    expect(
      raised,
      `parseTurboDryRun accepted ${JSON.stringify(stdout)}, so this test would pass without exercising anything`,
    ).toBeInstanceOf(Error);
    return (raised as Error).message;
  }

  test('names the invocation and the output when turbo wrote no JSON object', () => {
    const message = rejectionMessage('• turbo 2.10.4\n');
    expect(
      message,
      'indexOf misses, slice(-1) hands JSON.parse the final character, and the bare SyntaxError names neither the turbo invocation that produced the output nor the output itself',
    ).toContain(INVOCATION);
    expect(
      message,
      'without a head of what turbo actually wrote, an operator cannot tell a moved payload from an empty one',
    ).toContain('turbo 2.10.4');
  });

  test('names the invocation and the output when the JSON is malformed', () => {
    const message = rejectionMessage('{"tasks":');
    expect(
      message,
      "JSON.parse's bare SyntaxError reports a position in a string it does not quote and never names the turbo invocation that produced it",
    ).toContain(INVOCATION);
    expect(
      message,
      'a position offset into unquoted output is not a diagnosis; the head is what says whether turbo interleaved a log line into the payload',
    ).toContain('{"tasks":');
  });

  test('names the invocation and the output when the payload carries no tasks array', () => {
    const message = rejectionMessage('{"packages":[]}');
    expect(
      message,
      'a renamed field surfaces one line later as "Cannot read properties of undefined (reading \'map\')", which names neither the turbo invocation nor the payload that lacked the field',
    ).toContain(INVOCATION);
    expect(
      message,
      'the head is what shows an operator which fields turbo did send, so a rename is distinguishable from a truncation',
    ).toContain('{"packages":[]}');
  });
});

describe('scoped turbo overrides stay aligned with the global entries they replace', () => {
  test.each(SCOPED_OVERRIDE_TASKS)(
    "the app's %s override differs from the global entry only in dependsOn",
    (task) => {
      const definitions = turboUnfilteredDefinitions();
      const scoped = definitions.get(`${APP_PACKAGE_NAME}#${task}`);
      expect(
        scoped,
        `turbo resolved no definition for ${APP_PACKAGE_NAME}#${task}, so this row would certify nothing`,
      ).toBeDefined();

      const siblings = [...definitions.entries()].filter(
        ([taskId]) => taskId.endsWith(`#${task}`) && !taskId.startsWith(`${APP_PACKAGE_NAME}#`),
      );
      expect(
        siblings.length,
        `no package other than ${APP_PACKAGE_NAME} resolves ${task}, so there is no global entry to compare against and this row would pass on anything`,
      ).toBeGreaterThan(0);

      for (const [taskId, sibling] of siblings) {
        expect(
          withoutDependsOn(scoped as TurboTaskDefinition),
          `a root package#task entry overwrites the global task definition outright and inherits nothing, so "${APP_PACKAGE_NAME}#${task}" in turbo.json restates the global entry's fields by hand. ${taskId} resolves the global entry, and it has drifted from the scoped copy: a field added to one and not the other never reaches the package that actually runs this tier, and under turbo's strict env mode an undeclared variable is filtered out of the child process rather than merely omitted from the cache key`,
        ).toEqual(withoutDependsOn(sibling));
      }

      const scopedDependsOn = (scoped as TurboTaskDefinition).dependsOn as string[];
      expect(
        scopedDependsOn,
        `the scoped override exists to add the app build edge that keeps this tier from reading src/locales/*/messages.json while the build rewrites them, so dropping "build" from it silently restores the race`,
      ).toContain('build');
    },
  );
});
