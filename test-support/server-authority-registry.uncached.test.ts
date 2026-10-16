import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';
import { createVitest, type Reporter, type TestModule } from 'vitest/node';
import type {} from './fixtures/server-authority-observation.test-helper.ts';
import { withTempDir } from './temp-dir.test-helper.ts';
import { trackedFiles } from './vitest-configs.test-helper.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ownerPreload = new URL('./fixtures/server-authority-owner.test-helper.mjs', import.meta.url)
  .href;
const observationSetup = fileURLToPath(
  new URL('./fixtures/server-authority-observation.test-helper.ts', import.meta.url),
);
const observationOverrides: ViteUserConfig = { test: { setupFiles: [observationSetup] } };
const scriptsConfig = 'vitest.scripts.config.ts';
const serverConfig = 'packages/server/vitest.config.ts';
const helperFixture = relative(
  root,
  fileURLToPath(new URL('./fixtures/server-authority-registry.fixture.ts', import.meta.url)),
)
  .split(sep)
  .join('/');

function createRegistryRunner(
  temp: string,
  file: string,
  testNamePattern: string,
  config: string,
  reporter: Reporter,
) {
  const configPath = join(root, config);
  const projectRoot = dirname(configPath);
  return createVitest(
    {
      root: projectRoot,
      config: configPath,
      watch: false,
      include: [relative(projectRoot, join(root, file)).split(sep).join('/')],
      testNamePattern,
      maxWorkers: 1,
      pool: 'forks',
      fsModuleCache: true,
      execArgv: ['--import', ownerPreload],
      env: { TMPDIR: temp, TMP: temp, TEMP: temp },
      reporters: [reporter],
    },
    observationOverrides,
  );
}

async function runConsumer(
  temp: string,
  file: string,
  name: string,
  config: string,
): Promise<Set<string>> {
  const allocated = new Set<string>();
  let testModules: TestModule[] = [];
  const runner = await createRegistryRunner(temp, file, `^${name}$`, config, {});
  try {
    const result = await runner.start();
    expect(result.unhandledErrors).toEqual([]);
    testModules = result.testModules;
  } finally {
    await runner.close();
  }
  const executed = testModules
    .flatMap((module) => [...module.children.allTests()])
    .filter((testCase) => testCase.name === name);
  expect(
    executed.map((testCase) => ({
      name: testCase.name,
      state: testCase.result().state,
      errors: testCase.result().errors?.map(({ message }) => message) ?? [],
    })),
  ).toEqual([{ name, state: 'passed', errors: [] }]);
  for (const testCase of executed) {
    const directories = testCase.meta().authorityRegistryDirectories;
    if (directories === undefined) throw new Error(`No registry observation recorded for ${name}`);
    for (const directory of directories) allocated.add(directory);
  }
  return allocated;
}

test.each([
  {
    consumer: 'composition rig',
    file: helperFixture,
    name: 'composition rig uses the shared authority registry',
    config: scriptsConfig,
  },
  {
    consumer: 'integration server',
    file: helperFixture,
    name: 'integration server uses the shared authority registry',
    config: scriptsConfig,
  },
  {
    consumer: 'restartable server',
    file: helperFixture,
    name: 'restartable server uses the shared authority registry',
    config: scriptsConfig,
  },
  {
    consumer: 'nested project authority',
    file: 'packages/server/src/nested-project-authority.test.ts',
    name: 'missing cached documents wait for offline removal reconciliation, not existing documents',
    config: serverConfig,
  },
])(
  'Vitest releases the shared authority registry after $consumer completes',
  async ({ file, name, config }) => {
    await withTempDir('ok-registry-lifecycle-', async (temp) => {
      const allocated = await runConsumer(temp, file, name, config);
      expect(allocated.size).toBeGreaterThan(0);
      expect([...allocated].filter((directory) => existsSync(directory))).toEqual([]);
    });
  },
);

test('native upload fixture remains usable through the composition rig', async () => {
  await withTempDir('ok-registry-native-consumer-', async (temp) => {
    await runConsumer(
      temp,
      'packages/server/src/api-skill-import-composition.test.ts',
      'disconnect during an incomplete multipart request retains staging while the listener stays usable',
      serverConfig,
    );
  });
});

test('Vitest leaves no authority directory when every importing fixture test is filtered out', async () => {
  await withTempDir('ok-registry-filtered-', async (temp) => {
    const previousExitCode = process.exitCode;
    const runner = await createRegistryRunner(
      temp,
      helperFixture,
      '^no authority fixture test has this name$',
      scriptsConfig,
      {},
    );
    try {
      const result = await runner.start();
      expect(result.unhandledErrors).toEqual([]);
      expect(
        result.testModules.map((module) => ({
          file: relative(root, module.moduleId).split(sep).join('/'),
          state: module.state(),
          errors: module.errors(),
          cases: [...module.children.allTests()].map((testCase) => ({
            name: testCase.name,
            state: testCase.result().state,
          })),
        })),
      ).toEqual([
        {
          file: helperFixture,
          state: 'skipped',
          errors: [],
          cases: [
            { name: 'composition rig uses the shared authority registry', state: 'skipped' },
            { name: 'integration server uses the shared authority registry', state: 'skipped' },
            { name: 'restartable server uses the shared authority registry', state: 'skipped' },
          ],
        },
      ]);
    } finally {
      try {
        await runner.close();
      } finally {
        process.exitCode = previousExitCode;
      }
    }
    expect(readdirSync(temp).filter((entry) => entry.startsWith('ok-test-authority-'))).toEqual([]);
  });
});

test('Vitest leaves no authority directory after an importing fixture fails collection', async () => {
  await withTempDir('ok-registry-collection-', async (temp) => {
    const file = relative(
      root,
      fileURLToPath(
        new URL('./fixtures/server-authority-collection-failure.fixture.ts', import.meta.url),
      ),
    )
      .split(sep)
      .join('/');
    const previousExitCode = process.exitCode;
    const runner = await createRegistryRunner(temp, file, '.*', scriptsConfig, {});
    try {
      const result = await runner.start();
      expect(result.unhandledErrors).toEqual([]);
      expect(
        result.testModules.map((module) => ({
          file: relative(root, module.moduleId).split(sep).join('/'),
          state: module.state(),
          errors: module.errors().map(({ message, cause }) => ({ message, cause })),
          cases: [...module.children.allTests()],
        })),
      ).toEqual([
        {
          file,
          state: 'failed',
          errors: [
            {
              message: 'Registry fixture collection failed after import',
              cause: expect.stringContaining(join(temp, 'ok-test-authority-')),
            },
          ],
          cases: [],
        },
      ]);
    } finally {
      try {
        await runner.close();
      } finally {
        process.exitCode = previousExitCode;
      }
    }
    expect(readdirSync(temp).filter((entry) => entry.startsWith('ok-test-authority-'))).toEqual([]);
  });
});

test.each([
  ...trackedFiles(root, ['vitest.config.ts']),
  scriptsConfig,
  serverConfig,
  'packages/app/vitest.config.ts',
  'packages/cli/vitest.config.ts',
])('Vitest releases the shared authority registry under %s', async (config) => {
  await withTempDir('ok-registry-config-', async (temp) => {
    const allocated = await runConsumer(
      temp,
      helperFixture,
      'composition rig uses the shared authority registry',
      config,
    );
    expect(allocated.size).toBeGreaterThan(0);
    expect([...allocated].filter((directory) => existsSync(directory))).toEqual([]);
  });
});
