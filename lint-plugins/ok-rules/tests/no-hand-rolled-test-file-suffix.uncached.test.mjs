import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-hand-rolled-test-file-suffix';
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const README = 'lint-plugins/ok-rules/README.md';

function lint(args) {
  const result = spawnSync(join(ROOT, 'node_modules/.bin/oxlint'), ['-f', 'json', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(typeof result.status).toBe('number');
  const output = JSON.parse(result.stdout);
  expect(output.number_of_files).toBe(1);
  expect(output.number_of_rules).toBeGreaterThan(0);
  return {
    status: result.status,
    diagnostics: output.diagnostics.filter((diagnostic) => diagnostic.code === `ok(${RULE})`),
  };
}

describe('shared test-file predicate enforcement', () => {
  test('fires on all 15 positives and none of the adjacent negatives', () => {
    const fires = lintOkRulesFixture(FIXTURE).filter((fire) => fire.code === `ok(${RULE})`);
    expect(fires.map((fire) => fire.position)).toEqual([
      '6:20',
      '7:21',
      '8:20',
      '9:20',
      '11:20',
      '12:20',
      '13:20',
      '14:20',
      '15:20',
      '16:20',
      '17:20',
      '18:20',
      '19:20',
      '20:20',
      '21:20',
    ]);
    const source = readFileSync(join(ROOT, FIXTURE), 'utf8').split('\n');
    const positiveLines = source.flatMap((line, index) =>
      /^export const p\d+ =/.test(line) ? [index + 1] : [],
    );
    expect(fires.map((fire) => Number(fire.position.split(':')[0]))).toEqual(positiveLines);
    for (const fire of fires) {
      expect(fire.message).toContain('Use isTestOnlySourceFile');
      expect(fire.message).toContain(`${README}#${RULE}`);
    }
  });

  test('the real lint configuration rejects a planted check and accepts the shared predicate', () => {
    const dir = mkdtempSync(join(ROOT, 'scripts/test-file-predicate-'));
    const file = join(dir, 'probe.ts');
    try {
      writeFileSync(file, "export const probe = (path: string) => path.endsWith('.test.ts');\n");
      const positive = lint(['--max-warnings', '0', file]);
      expect(positive.status).toBe(1);
      expect(positive.diagnostics).toHaveLength(1);
      writeFileSync(
        file,
        "import { isTestOnlySourceFile } from '../../test-support/test-only-source-file.mjs';\nexport const probe = (path: string) => isTestOnlySourceFile(path);\n",
      );
      const negative = lint(['--max-warnings', '0', file]);
      expect(negative.status).toBe(0);
      expect(negative.diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('registration, narrow exemptions, and both prose links remain live', async () => {
    expect(await readRegisteredRuleNames(ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(ROOT)).toContain(`ok/${RULE}`);
    expect(readRuleScope(ROOT, RULE)).toEqual([
      '**/*.ts',
      '**/*.tsx',
      '**/*.mts',
      '**/*.cts',
      '**/*.js',
      '**/*.jsx',
      '**/*.mjs',
      '**/*.cjs',
      '!test-support/test-only-source-file.mjs',
      '!lint-plugins/no-comments/portability.test.mjs',
      'lint-plugins/ok-rules/__fixtures__/no-hand-rolled-test-file-suffix.fixture.tsx',
    ]);
    const prose = readFileSync(join(ROOT, README), 'utf8');
    expect(prose).toContain(`### \`${RULE}\``);
    expect(prose).toContain(`rules/${RULE}.mjs`);
    expect(prose).toContain('Scanners classify test-only TypeScript through');
    const excluded = lint(['--max-warnings', '0', 'lint-plugins/no-comments/portability.test.mjs']);
    expect(excluded.status).toBe(0);
    expect(excluded.diagnostics).toEqual([]);
  });
});
