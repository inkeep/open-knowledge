import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SUBTREE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT_TASK = '//#typecheck:no-net-connect';
const TSCONFIG = 'test-support/tsconfig.no-net-connect.json';

type TurboConfig = {
  tasks: Record<string, { dependsOn?: string[]; inputs?: string[] }>;
};

function turboConfig(): TurboConfig {
  return JSON.parse(readFileSync(resolve(SUBTREE_ROOT, 'turbo.json'), 'utf8')) as TurboConfig;
}

const TSC = resolve(
  SUBTREE_ROOT,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);

function programFiles(): string[] {
  const run = spawnSync(TSC, ['--noEmit', '-p', TSCONFIG, '--listFiles'], {
    cwd: SUBTREE_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(
      `${TSC} exited ${run.status} on ${TSCONFIG}; its diagnostics (stdout) follow, and the ` +
        `typecheck cell reports the same program:\n${run.stdout}${run.stderr}`,
    );
  }
  return run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('/node_modules/'))
    .map((absolute) => relative(SUBTREE_ROOT, absolute))
    .filter((path) => !path.startsWith('..'));
}

function matchesInput(file: string, pattern: string): boolean {
  const deep = '/**/*.ts';
  if (pattern.endsWith(deep)) {
    const prefix = pattern.slice(0, -deep.length + 1);
    return file.startsWith(prefix) && file.endsWith('.ts');
  }
  const flat = '/*.ts';
  if (pattern.endsWith(flat)) {
    const dir = pattern.slice(0, -flat.length);
    return dirname(file) === dir && file.endsWith('.ts');
  }
  return file === pattern;
}

describe('the guard typecheck task is attached and its cache key covers its program', () => {
  test('tasks.typecheck.dependsOn carries the root task', () => {
    const { tasks } = turboConfig();
    expect(
      tasks.typecheck?.dependsOn,
      `dropping ${ROOT_TASK} from tasks.typecheck.dependsOn takes the only compiler that reads ` +
        'the network guard out of every caller of turbo run typecheck, which still exits 0',
    ).toContain(ROOT_TASK);
  });

  test('the root task declares inputs matching every file in its tsc program', () => {
    const inputs = turboConfig().tasks[ROOT_TASK]?.inputs;
    expect(inputs, `${ROOT_TASK} must declare inputs`).toBeDefined();
    const files = programFiles();
    expect(files.length, 'the tsc program resolved no first-party files').toBeGreaterThan(0);
    const uncovered = files.filter(
      (file) => !(inputs ?? []).some((pattern) => matchesInput(file, pattern)),
    );
    expect(
      uncovered,
      `${TSCONFIG} compiles these files, and they match no declared input, so editing one ` +
        `changes no hash and ${ROOT_TASK} can replay a cached pass`,
    ).toEqual([]);
  });

  test('the tsconfig the program extends is itself an input', () => {
    const inputs = turboConfig().tasks[ROOT_TASK]?.inputs ?? [];
    const program = JSON.parse(readFileSync(resolve(SUBTREE_ROOT, TSCONFIG), 'utf8')) as {
      extends?: string;
    };
    expect(
      program.extends,
      'the program must extend a tsconfig for this assertion to mean anything',
    ).toBeDefined();
    const extended = relative(
      SUBTREE_ROOT,
      resolve(dirname(resolve(SUBTREE_ROOT, TSCONFIG)), program.extends ?? ''),
    );
    expect(
      inputs.some((pattern) => matchesInput(extended, pattern)),
      `${extended} sets the compiler options the program runs under and matches no declared input`,
    ).toBe(true);
  });
});
