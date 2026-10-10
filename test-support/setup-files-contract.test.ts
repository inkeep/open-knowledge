import { existsSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { createTempDirFactory } from './temp-dir.test-helper';
import { okVitestBase } from './vitest.base';
import {
  isTestConfig,
  type ProjectReading,
  readConfigProjects,
  trackedConfigs,
  trackedFiles,
} from './vitest-configs.test-helper';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const BASE_MODULE = fileURLToPath(new URL('./vitest.base.ts', import.meta.url))
  .split(sep)
  .join('/');

const KNOWN_TEST_PROJECTS = [
  'docs/vitest.config.ts',
  'docs/vitest.real-source.config.mts',
  'packages/app/tests/foundation/fixtures/vitest.browser-fixture.config.ts',
  'packages/app/tests/foundation/fixtures/vitest.node-fixture.config.ts',
  'packages/app/tests/foundation/vitest.browser-reverse.config.ts',
  'packages/app/vitest.browser.config.ts',
  'packages/app/vitest.config.ts',
  'packages/app/vitest.dom.config.ts',
  'packages/app/vitest.fidelity.config.ts',
  'packages/app/vitest.integration.config.ts',
  'packages/app/vitest.node.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/cli/vitest.e2e.config.ts',
  'packages/core/vitest.config.ts',
  'packages/desktop/vitest.config.ts',
  'packages/server/vitest.config.ts',
  'packages/server/vitest.network.config.ts',
  'test-support/fixtures/no-net-connect/vitest.no-net-connect-fixture.config.ts',
  'vitest.scripts.config.ts',
  'vitest.uncached.config.ts',
];

const TEST_PROJECTS_OUTSIDE_THE_PUBLIC_TREE = [
  'packages/md-conformance/md-audit/vitest.config.ts',
  'packages/md-conformance/vitest.config.ts',
  'vitest.config.ts',
];

const KNOWN_BUILD_CONFIGS = [
  'packages/app/vite.config.ts',
  'packages/desktop/electron.vite.config.ts',
];

const REQUIRED_BASE_SETUP_FILES = ['bun-global-shim.ts', 'no-net-connect.ts'];

const BROWSER_PROJECT_SETUP_FILES: Readonly<Record<string, readonly string[]>> = {
  'packages/app/tests/foundation/fixtures/vitest.browser-fixture.config.ts': ['browser-setup.ts'],
  'packages/app/tests/foundation/vitest.browser-reverse.config.ts': ['browser-setup.ts'],
  'packages/app/vitest.browser.config.ts': ['browser-setup.ts'],
};

const isBrowserProject = (relPath: string): boolean =>
  Object.hasOwn(BROWSER_PROJECT_SETUP_FILES, relPath);

const tracksFilesThePublicTreeOmits = trackedFiles(REPO_ROOT, ['*.private.*']).length > 0;

const EXPECTED_TEST_PROJECTS = tracksFilesThePublicTreeOmits
  ? [...KNOWN_TEST_PROJECTS, ...TEST_PROJECTS_OUTSIDE_THE_PUBLIC_TREE]
  : KNOWN_TEST_PROJECTS;

function setupFileList(setupFiles: unknown): string[] {
  if (setupFiles === undefined) return [];
  return (Array.isArray(setupFiles) ? setupFiles : [setupFiles]).map(String);
}

const readSetupFiles = (root: string, relPath: string): Promise<Array<ProjectReading<string>>> =>
  readConfigProjects(root, relPath, (options) => setupFileList(options.test?.setupFiles));

const unresolvedProblem = (project: string, reference: string): string =>
  `${project} is resolved from ${reference}, which this check does not follow; declare the project inline.`;

function sharedSetupProblems(reading: ProjectReading<string>): string[] {
  if (reading.kind === 'unresolved') return [unresolvedProblem(reading.project, reading.reference)];
  const missing = okVitestBase.test.setupFiles.filter((entry) => !reading.values.includes(entry));
  if (missing.length === 0) return [];
  return [
    `${reading.project} omits [${missing.join(', ')}], which the shared base installs; it resolves ` +
      `[${reading.values.join(', ')}]. Build it from okVitestBase.test.setupFiles rather than listing entries by hand.`,
  ];
}

function browserSetupProblems(
  reading: ProjectReading<string>,
  required: readonly string[],
): string[] {
  if (reading.kind === 'unresolved') return [unresolvedProblem(reading.project, reading.reference)];
  const names = reading.values.map((entry) => basename(entry));
  const absent = required.filter((name) => !names.includes(name));
  const nodeOnly = reading.values.filter((entry) => okVitestBase.test.setupFiles.includes(entry));
  return [
    ...(absent.length === 0
      ? []
      : [
          `${reading.project} resolves [${reading.values.join(', ')}] without its browser setup [${absent.join(', ')}].`,
        ]),
    ...(nodeOnly.length === 0
      ? []
      : [
          `${reading.project} loads the Node-only shared setup file(s) [${nodeOnly.join(', ')}] into the browser.`,
        ]),
  ];
}

const makeTempDir = createTempDirFactory(afterAll);

function plantConfig(name: string, body: readonly string[]): string {
  const root = makeTempDir('ok-setup-files-contract-');
  writeFileSync(
    join(root, name),
    [`import { okVitestBase } from ${JSON.stringify(BASE_MODULE)};`, ...body, ''].join('\n'),
  );
  return root;
}

const configs = trackedConfigs(REPO_ROOT);

describe('vitest setupFiles contract', () => {
  test('every tracked config is present in the working tree', () => {
    const missing = configs.filter((relPath) => !existsSync(join(REPO_ROOT, relPath)));
    expect(
      missing,
      `git lists these configs but they are absent from the working tree: ${missing.join(', ')}. ` +
        'The sweep reads the index, so a vitest one fails below as module-not-found, and a ' +
        'build config passes every other assertion here, because the index still lists it.',
    ).toEqual([]);
  });

  test('the shared base itself still installs every required setup file', () => {
    for (const required of REQUIRED_BASE_SETUP_FILES) {
      expect(
        okVitestBase.test.setupFiles.some((entry) => basename(entry) === required),
        `okVitestBase.test.setupFiles no longer installs ${required}, so every project ` +
          'below would agree with a base that stopped installing it.',
      ).toBe(true);
    }
  });

  test('the sweep sees exactly the vitest projects the repo tracks', () => {
    expect(
      configs.filter(isTestConfig).sort(),
      'A vitest project appeared or disappeared. Confirm the new one is covered, then update ' +
        'this list; a lower bound would have let a disappearing project pass silently.',
    ).toEqual([...EXPECTED_TEST_PROJECTS].sort());
  });

  test('every non-vitest config in the sweep is a known build config', () => {
    expect(configs.filter((relPath) => !isTestConfig(relPath)).sort()).toEqual(
      [...KNOWN_BUILD_CONFIGS].sort(),
    );
  });

  test('every browser project is a tracked vitest project', () => {
    expect(
      Object.keys(BROWSER_PROJECT_SETUP_FILES).filter((relPath) => !configs.includes(relPath)),
    ).toEqual([]);
  });

  test.each(configs.filter((relPath) => isTestConfig(relPath) && !isBrowserProject(relPath)))(
    '%s resolves setupFiles containing every entry the shared base installs',
    async (relPath) => {
      const readings = await readSetupFiles(REPO_ROOT, relPath);
      expect(readings.length, `${relPath} resolved no project`).toBeGreaterThan(0);
      expect(readings.flatMap(sharedSetupProblems)).toEqual([]);
    },
  );

  test.each(Object.entries(BROWSER_PROJECT_SETUP_FILES))(
    '%s resolves its browser setup files and none of the Node-only setup files the shared base installs',
    async (relPath, required) => {
      const readings = await readSetupFiles(REPO_ROOT, relPath);
      expect(readings.length, `${relPath} resolved no project`).toBeGreaterThan(0);
      expect(readings.flatMap((reading) => browserSetupProblems(reading, required))).toEqual([]);
    },
  );
});

describe('a projects config is judged by the setup files Vitest gives each project', () => {
  test('a project inherits the setup files of the config that declares it, before its own, and one that sets extends: false does not', async () => {
    const config = 'vitest.projects.config.mjs';
    const root = plantConfig(config, [
      'export default {',
      '  test: {',
      '    setupFiles: okVitestBase.test.setupFiles,',
      '    projects: [',
      "      { test: { name: 'inherits', setupFiles: ['./project-setup.ts'] } },",
      "      { extends: false, test: { name: 'extends-false', setupFiles: ['./project-setup.ts'] } },",
      '    ],',
      '  },',
      '};',
    ]);
    const readings = await readSetupFiles(root, config);
    expect(readings).toEqual([
      {
        kind: 'resolved',
        project: `${config} project inherits`,
        values: [...okVitestBase.test.setupFiles, './project-setup.ts'],
      },
      {
        kind: 'resolved',
        project: `${config} project extends-false`,
        values: ['./project-setup.ts'],
      },
    ]);
    expect(readings.map(sharedSetupProblems)).toEqual([
      [],
      [
        expect.stringContaining(
          `${config} project extends-false omits [${okVitestBase.test.setupFiles.join(', ')}]`,
        ),
      ],
    ]);
  });

  test('a project named by a path, or one that extends another config file, is reported as unresolved rather than judged', async () => {
    const config = 'vitest.by-reference.config.mjs';
    const root = plantConfig(config, [
      'export default {',
      '  test: {',
      '    setupFiles: okVitestBase.test.setupFiles,',
      '    projects: [',
      "      './vitest.other.config.mjs',",
      "      { extends: './vitest.other.config.mjs', test: { name: 'extends-file' } },",
      '    ],',
      '  },',
      '};',
    ]);
    const readings = await readSetupFiles(root, config);
    const unresolved = [
      `${config} project 0 is resolved from ./vitest.other.config.mjs`,
      `${config} project extends-file is resolved from ./vitest.other.config.mjs`,
    ].map((problem) => [expect.stringContaining(problem)]);
    expect(readings.map(sharedSetupProblems)).toEqual(unresolved);
    expect(readings.map((reading) => browserSetupProblems(reading, ['browser-setup.ts']))).toEqual(
      unresolved,
    );
  });

  test('a browser project is reported when it lacks its browser setup or resolves a Node-only shared setup file', async () => {
    const config = 'vitest.browser.config.mjs';
    const root = plantConfig(config, [
      'export default {',
      '  test: {',
      '    setupFiles: okVitestBase.test.setupFiles,',
      '    projects: [',
      "      { extends: false, test: { name: 'browser-only', setupFiles: ['./browser-setup.ts'] } },",
      "      { test: { name: 'inherits-node-only', setupFiles: ['./browser-setup.ts'] } },",
      "      { extends: false, test: { name: 'no-browser-setup', setupFiles: ['./other-setup.ts'] } },",
      '    ],',
      '  },',
      '};',
    ]);
    const readings = await readSetupFiles(root, config);
    expect(readings.map((reading) => browserSetupProblems(reading, ['browser-setup.ts']))).toEqual([
      [],
      [
        expect.stringContaining(
          `${config} project inherits-node-only loads the Node-only shared setup file(s) [${okVitestBase.test.setupFiles.join(', ')}]`,
        ),
      ],
      [
        expect.stringContaining(
          `${config} project no-browser-setup resolves [./other-setup.ts] without its browser setup [browser-setup.ts]`,
        ),
      ],
    ]);
  });
});
