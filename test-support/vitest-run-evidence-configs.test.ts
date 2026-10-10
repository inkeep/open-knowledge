import { writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { createTempDirFactory } from './temp-dir.test-helper';
import {
  isTestConfig,
  type ProjectReading,
  readConfigProjects,
  trackedConfigs,
} from './vitest-configs.test-helper';
import { vitestRunEvidence } from './vitest-run-evidence';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const BASE_MODULE = fileURLToPath(new URL('./vitest.base.ts', import.meta.url))
  .split(sep)
  .join('/');

const RUN_EVIDENCE_PLUGIN = vitestRunEvidence().name;

type ContractReading = {
  configs: number;
  projects: number;
  findings: readonly ProjectReading<string>[];
};

async function pluginNames(option: unknown): Promise<string[]> {
  const value = await option;
  if (Array.isArray(value)) return (await Promise.all(value.map(pluginNames))).flat();
  return value ? [String((value as { name?: unknown }).name)] : [];
}

const omitsRunEvidence = (reading: ProjectReading<string>): boolean =>
  reading.kind === 'unresolved' || !reading.values.includes(RUN_EVIDENCE_PLUGIN);

function describeFinding(reading: ProjectReading<string>): string {
  switch (reading.kind) {
    case 'resolved':
      return `${reading.project} resolves plugins [${reading.values.join(', ')}] without ${RUN_EVIDENCE_PLUGIN}; spread okVitestBase.plugins into its plugins.`;
    case 'unresolved':
      return `${reading.project} is resolved from ${reading.reference}, which this check does not follow; declare the project inline.`;
  }
}

async function readRunEvidenceContract(
  root: string,
  relPaths: readonly string[],
): Promise<ContractReading> {
  const projects = (
    await Promise.all(
      relPaths.map((relPath) =>
        readConfigProjects(root, relPath, (options) => pluginNames(options.plugins)),
      ),
    )
  ).flat();
  return {
    configs: relPaths.length,
    projects: projects.length,
    findings: projects.filter(omitsRunEvidence),
  };
}

const makeTempDir = createTempDirFactory(afterAll);

function plantConfigs(configs: Record<string, string>): string {
  const root = makeTempDir('ok-vitest-run-evidence-configs-');
  for (const [name, body] of Object.entries(configs)) {
    writeFileSync(
      join(root, name),
      [
        `import { importMetaDirPlugin, okVitestBase } from ${JSON.stringify(BASE_MODULE)};`,
        "const extra = { name: 'ok-fixture:extra' };",
        body,
        '',
      ].join('\n'),
    );
  }
  return root;
}

describe('every Vitest config hands each of its projects the run-evidence plugin', () => {
  test('a config that sets its plugins without spreading the base plugins is named, and configs that spread them pass', async () => {
    const root = plantConfigs({
      'vitest.keeps-base.config.mjs': 'export default { ...okVitestBase };',
      'vitest.adds-plugin.config.mjs':
        'export default { ...okVitestBase, plugins: [...okVitestBase.plugins, extra] };',
      'vitest.drops-base.config.mjs': 'export default { ...okVitestBase, plugins: [extra] };',
      'vitest.lists-by-hand.config.mjs':
        'export default { ...okVitestBase, plugins: [importMetaDirPlugin, extra] };',
    });
    expect(
      await readRunEvidenceContract(root, [
        'vitest.keeps-base.config.mjs',
        'vitest.adds-plugin.config.mjs',
        'vitest.drops-base.config.mjs',
        'vitest.lists-by-hand.config.mjs',
      ]),
    ).toEqual({
      configs: 4,
      projects: 4,
      findings: [
        { kind: 'resolved', project: 'vitest.drops-base.config.mjs', values: ['ok-fixture:extra'] },
        {
          kind: 'resolved',
          project: 'vitest.lists-by-hand.config.mjs',
          values: ['ok-bun-import-meta-dir', 'ok-fixture:extra'],
        },
      ],
    });
  });

  test("plugins are read the way Vite resolves them, through a factory's nested, awaited and empty entries", async () => {
    const root = plantConfigs({
      'vitest.nested-keeps.config.mjs':
        'export default async () => ({ ...okVitestBase, plugins: [false, [Promise.resolve(okVitestBase.plugins)], null] });',
      'vitest.nested-drops.config.mjs':
        'export default async () => ({ ...okVitestBase, plugins: [false, [Promise.resolve([extra])], null] });',
    });
    expect(
      await readRunEvidenceContract(root, [
        'vitest.nested-keeps.config.mjs',
        'vitest.nested-drops.config.mjs',
      ]),
    ).toEqual({
      configs: 2,
      projects: 2,
      findings: [
        {
          kind: 'resolved',
          project: 'vitest.nested-drops.config.mjs',
          values: ['ok-fixture:extra'],
        },
      ],
    });
  });

  test('each project is read with the plugins Vitest gives it: the declaring config inherited unless extends is false, plus its own', async () => {
    const root = plantConfigs({
      'vitest.projects.config.mjs': [
        'export default {',
        '  plugins: okVitestBase.plugins,',
        '  test: {',
        '    projects: [',
        "      { test: { name: 'inherits' } },",
        "      { extends: true, test: { name: 'extends-true' } },",
        "      { extends: false, test: { name: 'extends-false' } },",
        "      { extends: false, plugins: okVitestBase.plugins, test: { name: 'extends-false-own' } },",
        "      () => ({ extends: false, plugins: [extra], test: { name: 'factory' } }),",
        '    ],',
        '  },',
        '};',
      ].join('\n'),
      'vitest.root-without.config.mjs': [
        'export default {',
        '  test: {',
        '    projects: [',
        "      { plugins: [...okVitestBase.plugins, extra], test: { name: 'own' } },",
        "      { test: { name: 'none' } },",
        '    ],',
        '  },',
        '};',
      ].join('\n'),
    });
    expect(
      await readRunEvidenceContract(root, [
        'vitest.projects.config.mjs',
        'vitest.root-without.config.mjs',
      ]),
    ).toEqual({
      configs: 2,
      projects: 7,
      findings: [
        {
          kind: 'resolved',
          project: 'vitest.projects.config.mjs project extends-false',
          values: [],
        },
        {
          kind: 'resolved',
          project: 'vitest.projects.config.mjs project factory',
          values: ['ok-fixture:extra'],
        },
        { kind: 'resolved', project: 'vitest.root-without.config.mjs project none', values: [] },
      ],
    });
  });

  test('a project named by a path, or one that extends another config file, is reported as unresolved rather than passed', async () => {
    const root = plantConfigs({
      'vitest.keeps-base.config.mjs': 'export default { ...okVitestBase };',
      'vitest.by-reference.config.mjs': [
        'export default {',
        '  plugins: okVitestBase.plugins,',
        '  test: {',
        '    projects: [',
        "      './vitest.keeps-base.config.mjs',",
        "      { extends: './vitest.keeps-base.config.mjs', test: { name: 'extends-file' } },",
        "      { test: { name: 'inline' } },",
        '    ],',
        '  },',
        '};',
      ].join('\n'),
    });
    expect(await readRunEvidenceContract(root, ['vitest.by-reference.config.mjs'])).toEqual({
      configs: 1,
      projects: 3,
      findings: [
        {
          kind: 'unresolved',
          project: 'vitest.by-reference.config.mjs project 0',
          reference: './vitest.keeps-base.config.mjs',
        },
        {
          kind: 'unresolved',
          project: 'vitest.by-reference.config.mjs project extends-file',
          reference: './vitest.keeps-base.config.mjs',
        },
      ],
    });
  });

  test('every tracked Vitest config on disk hands the plugin to each of its projects', async () => {
    const tracked = trackedConfigs(REPO_ROOT).filter(isTestConfig);
    const reading = await readRunEvidenceContract(REPO_ROOT, tracked);
    const examined = `the sweep read ${reading.configs} configs and ${reading.projects} projects`;
    expect(
      reading.findings,
      `${examined}; ${reading.findings.map(describeFinding).join(' ')}`,
    ).toEqual([]);
    expect(reading.configs, examined).toBe(tracked.length);
    expect(tracked, 'the sweep must reach the tier that composes projects').toContain(
      'vitest.uncached.config.ts',
    );
    expect(reading.projects, `${examined}, so it never walked into a project`).toBeGreaterThan(
      reading.configs,
    );
  });
});
