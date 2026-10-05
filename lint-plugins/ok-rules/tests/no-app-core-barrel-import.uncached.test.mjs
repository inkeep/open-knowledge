import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';
import {
  isTestOnlySourceFile,
  TEST_ONLY_SOURCE_SUFFIXES,
} from '../../../test-support/test-only-source-file.mjs';
import { TAG_SURFACE_FILENAME } from '../../no-comments/tag-scope.mjs';
import { rules } from '../index.mjs';
import { isInScope } from '../scope.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-app-core-barrel-import';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const README = 'lint-plugins/ok-rules/README.md';
const BARE_IMPORT = "import { sharedExtensions } from '@inkeep/open-knowledge-core';\n";
const SUBPATH_IMPORT =
  "import { sharedExtensions } from '@inkeep/open-knowledge-core/extensions/shared';\n";
const PRODUCTION_SHAPED = [
  'packages/app/src/App.tsx',
  'packages/app/src/server/hocuspocus-plugin.ts',
  'packages/app/src/lib/handoff/targets.ts',
  'packages/app/src/a-directory-added-later/nested/module.ts',
  'packages/app/src/build/rejection-loop-guard-script.js',
  'packages/app/src/workers/new-worker.mjs',
  'packages/app/src/types/ambient.d.ts',
];

const REPO_LINT_INPUTS = [
  'oxlint.config.ts',
  'tsconfig.json',
  'no-comments.config.jsonc',
  'PRECEDENTS.md',
  'lint-plugins',
  'test-support/test-only-source-file.mjs',
];
const OPTIONAL_REPO_LINT_INPUTS = [TAG_SURFACE_FILENAME];

function copyRepoLintConfig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-core-barrel-lint-')));
  const present = OPTIONAL_REPO_LINT_INPUTS.filter((input) => existsSync(join(ROOT, input)));
  for (const input of [...REPO_LINT_INPUTS, ...present]) {
    mkdirSync(dirname(join(root, input)), { recursive: true });
    cpSync(join(ROOT, input), join(root, input), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

function lintWithRepoConfig(root, files) {
  const result = spawnSync(
    join(ROOT, 'node_modules/.bin/oxlint'),
    ['-f', 'json', '--max-warnings', '0', ...files],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(typeof result.status).toBe('number');
  const output = JSON.parse(result.stdout);
  expect(output.number_of_files).toBe(files.length);
  return {
    status: result.status,
    diagnostics: output.diagnostics.map((diagnostic) => {
      const span = diagnostic.labels[0]?.span;
      return `${diagnostic.code} ${diagnostic.filename} ${span?.line}:${span?.column}`;
    }),
  };
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at the module specifier of each of its 19 positive forms, by its own code, and on no negative', () => {
    const fires = lintOkRulesFixture(FIXTURE).filter((fire) => fire.code === CODE);
    expect(fires.map((fire) => fire.position)).toEqual([
      '13:34',
      '14:35',
      '15:49',
      '16:32',
      '17:8',
      '18:25',
      '19:31',
      '20:35',
      '21:35',
      '22:15',
      '23:27',
      '24:40',
      '25:33',
      '26:38',
      '27:39',
      '28:39',
      '29:21',
      '30:8',
      '31:35',
    ]);
    const lines = readFileSync(join(ROOT, FIXTURE), 'utf8').split('\n');
    const positiveLines = lines.flatMap((line, index) => (/\/\/ p /.test(line) ? [index + 1] : []));
    expect(fires.map((fire) => Number(fire.position.split(':')[0]))).toEqual(positiveLines);
    for (const fire of fires) {
      const [line, column] = fire.position.split(':').map(Number);
      expect(lines[line - 1].slice(column - 1)).toMatch(
        /^['`]@inkeep\/open-knowledge-core(?:[?#][^'`]*)?['`]/,
      );
      expect(fire.message).toContain('Import each binding from the core subpath');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(`${README}#${RULE}`);
    }
  });

  test('rule is registered and enabled at error in oxlint.config.ts', async () => {
    expect(await readRegisteredRuleNames(ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope is app production source by pattern, minus every canonical test-only suffix', () => {
    expect(readRuleScope(ROOT, RULE)).toEqual([
      'packages/app/src/**/*.ts',
      'packages/app/src/**/*.tsx',
      'packages/app/src/**/*.mts',
      'packages/app/src/**/*.cts',
      'packages/app/src/**/*.js',
      'packages/app/src/**/*.jsx',
      'packages/app/src/**/*.mjs',
      'packages/app/src/**/*.cjs',
      '!**/*.test.ts',
      '!**/*.test.tsx',
      '!**/*.test-helper.ts',
      '!**/*.test-helper.tsx',
      '!**/*.type-tests.ts',
      '!**/*.type-tests.tsx',
      '!**/*.e2e.ts',
      FIXTURE,
    ]);
    for (const path of PRODUCTION_SHAPED) expect(isInScope(RULE, path), path).toBe(true);
    expect(TEST_ONLY_SOURCE_SUFFIXES.length).toBeGreaterThan(0);
    for (const suffix of TEST_ONLY_SOURCE_SUFFIXES) {
      const path = `packages/app/src/components/Widget${suffix}`;
      expect(isTestOnlySourceFile(path), path).toBe(true);
      expect(isInScope(RULE, path), path).toBe(false);
    }
    for (const path of [
      'packages/app/tests/integration/audit-barrier.test-helper.ts',
      'packages/app/tests/stress/_helpers/fixtures.ts',
      'packages/server/src/lint/audit.ts',
      'packages/desktop/src/main/index.ts',
      'docs/src/components/docs-sidebar-item.ts',
      'lint-plugins/ok-rules/__fixtures__/no-uninstall-forbidden-import.fixture.tsx',
    ]) {
      expect(isInScope(RULE, path), path).toBe(false);
    }
  });

  test('the registered scoped wrapper visits production files and skips test-only ones', () => {
    const rule = rules[RULE];
    const visitorsFor = (path) =>
      Object.keys(
        rule.create({
          physicalFilename: join(ROOT, path),
          filename: join(ROOT, path),
          report() {},
        }),
      );
    expect(visitorsFor('packages/app/src/server/hocuspocus-plugin.ts')).toContain(
      'ImportDeclaration',
    );
    expect(visitorsFor('packages/app/src/components/HelpPopover.dom.test.tsx')).toEqual([]);
    expect(visitorsFor('packages/server/src/lint/audit.ts')).toEqual([]);
  });

  test('a copy of the repository lint configuration rejects a planted app import and accepts its subpath form', () => {
    const root = copyRepoLintConfig();
    const production = 'packages/app/src/core-barrel-probe/probe.ts';
    const testOnly = 'packages/app/src/core-barrel-probe/probe.test.ts';
    try {
      mkdirSync(join(root, dirname(production)), { recursive: true });
      writeFileSync(
        join(root, production),
        `${BARE_IMPORT}export const probe = sharedExtensions;\n`,
      );
      writeFileSync(join(root, testOnly), `${BARE_IMPORT}export const probe = sharedExtensions;\n`);
      const positive = lintWithRepoConfig(root, [production, testOnly]);
      expect(positive.status).toBe(1);
      expect(positive.diagnostics).toEqual([`${CODE} ${production} 1:34`]);
      writeFileSync(
        join(root, production),
        `${SUBPATH_IMPORT}export const probe = sharedExtensions;\n`,
      );
      const negative = lintWithRepoConfig(root, [production]);
      expect(negative.status).toBe(0);
      expect(negative.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the README documents the rule at the anchor its message links to', () => {
    const prose = readFileSync(join(ROOT, README), 'utf8');
    expect(prose).toContain(`### \`${RULE}\``);
    expect(prose).toContain(`rules/${RULE}.mjs`);
    expect(prose).toContain(`tests/${RULE}.uncached.test.mjs`);
  });
});
