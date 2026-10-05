import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const cliFile = fileURLToPath(
  new URL('../support/windows-os-state-cli.test-helper.ts', import.meta.url),
);
const INVALID_RECORD = '{"version":1,"status":"unavailable","reason":"invalid-shape"}\n';
const OFF_WINDOWS = [
  '--import',
  'data:text/javascript,Object.defineProperty(process,"platform",{value:"linux"})',
];

function runCli(args: string[], nodeArgs: string[] = []): { code: number | null; stdout: string } {
  const run = spawnSync(process.execPath, [...nodeArgs, cliFile, ...args], { encoding: 'utf8' });
  return { code: run.status, stdout: run.stdout };
}

const pidFlags = (count: number, first = 4_100): string[] =>
  Array.from({ length: count }, (_, index) => ['--pid', String(first + index)]).flat();

test.each([
  { caseName: 'nine targets', args: pidFlags(9, 731_000), rejected: '731008' },
  {
    caseName: 'a budget above the ceiling',
    args: ['--pid', '42', '--budget-ms', '5001'],
    rejected: '5001',
  },
  { caseName: 'a zero budget', args: ['--pid', '42', '--budget-ms', '0'], rejected: '"0"' },
  { caseName: 'a zero PID', args: ['--pid', '0', '--pid', '731111'], rejected: '731111' },
  { caseName: 'a zero-padded PID', args: ['--pid', '0731222'], rejected: '731222' },
  { caseName: 'a fractional PID', args: ['--pid', '7313.5'], rejected: '7313' },
  {
    caseName: 'a repeated parent PID',
    args: ['--pid', '42', '--parent-pid', '731444', '--parent-pid', '731445'],
    rejected: '73144',
  },
  {
    caseName: 'an unknown flag',
    args: ['--pid', '42', '--private-flag-731', '1'],
    rejected: 'private-flag',
  },
  { caseName: 'a flag without a value', args: ['--pid', '42', '--budget-ms'], rejected: 'budget' },
  { caseName: 'no target', args: ['--parent-pid', '731555'], rejected: '731555' },
])('$caseName exits 2 with the fixed record and no echo', ({ args, rejected }) => {
  const result = runCli(args);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe(INVALID_RECORD);
  expect(result.stdout).not.toContain(rejected);
});

test('eight targets at the budget ceiling are accepted and exit 1 off Windows', () => {
  const result = runCli([...pidFlags(8), '--budget-ms', '5000'], OFF_WINDOWS);
  expect(result.code).toBe(1);
  const record = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(record).toEqual(
    expect.objectContaining({ version: 1, status: 'unavailable', reason: 'unsupported-platform' }),
  );
  expect(record.targets).toHaveLength(8);
});
