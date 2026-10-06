import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { installPackedCli } from './packed-install.test-helper';

function createDiagnosticFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ok-cli-npm-diagnostics-'));
  const packageDir = join(root, 'package');
  const packDest = join(root, 'pack');
  const installPrefix = join(root, 'install');
  for (const dir of [packageDir, packDest, installPrefix]) mkdirSync(dir);
  return {
    root,
    packageDir,
    packDest,
    installPrefix,
    mode: 'fresh' as const,
    env: {
      ...process.env,
      npm_config_cache: join(root, 'inherited-cache'),
      npm_config_logs_dir: join(root, 'inherited-logs'),
      npm_config_userconfig: join(root, 'empty.npmrc'),
      npm_config_ignore_scripts: 'false',
      npm_config_loglevel: 'error',
    },
  };
}

function writeLocalPackage(packageDir: string, failingInstall = false) {
  for (const dir of ['dist/public', 'dist/assets/skills'])
    mkdirSync(join(packageDir, dir), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@inkeep/open-knowledge',
      version: '1.0.0',
      bin: { ok: 'dist/cli.mjs' },
      ...(failingInstall ? { scripts: { postinstall: 'node install-failure.cjs' } } : {}),
    }),
  );
  writeFileSync(
    join(packageDir, 'dist/cli.mjs'),
    '#!/usr/bin/env node\nconsole.log("diagnostic fixture ready");\n',
  );
  writeFileSync(join(packageDir, 'dist/public/index.html'), '<title>CLI fixture</title>');
  writeFileSync(join(packageDir, 'dist/assets/skills/SKILL.md'), '# CLI fixture\n');
  if (failingInstall)
    writeFileSync(
      join(packageDir, 'install-failure.cjs'),
      `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.INIT_CWD, 'npm-context.json'), JSON.stringify({ cache: process.env.npm_config_cache, logs: process.env.npm_config_logs_dir }));
process.stderr.write('NPMPACK_INSTALL_CONTROL\\n');
process.exit(23);
`,
    );
}

function npmFailure(failure: unknown): Error {
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected real npm failure');
  return failure;
}

function npmDebugStack(root: string, command: 'pack' | 'install') {
  const log = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-debug-0.log'))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .find((content) => content.includes(`verbose title npm ${command}`));
  expect(log).toBeTypeOf('string');
  if (typeof log !== 'string') throw new Error(`Expected real npm ${command} debug log`);
  const stack = log.split('\n').find((line) => line.includes('verbose stack'));
  expect(stack).toBeTypeOf('string');
  if (typeof stack !== 'string') throw new Error(`Expected real npm ${command} debug stack`);
  return stack;
}

test('retains npm pack stderr and debug details after fixture cleanup', async () => {
  const fixture = createDiagnosticFixture();
  let failure: unknown;
  let debugStack = '';
  try {
    writeFileSync(join(fixture.packageDir, 'package.json'), '{"name":');
    failure = await installPackedCli(fixture).catch((error: unknown) => error);
    debugStack = npmDebugStack(fixture.root, 'pack');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected real npm pack failure');
  expect(failure.message).toContain('EJSONPARSE');
  expect(failure.message).toMatch(/npm (?:error|ERR!)/);
  expect(failure.message).toContain('verbose stack');
  expect(failure.message).toContain(debugStack);
});

test('retains npm pack debug details when stderr is silent', async () => {
  const fixture = createDiagnosticFixture();
  let failure: unknown;
  let debugStack = '';
  try {
    writeFileSync(join(fixture.packageDir, 'package.json'), '{"name":');
    failure = await installPackedCli({
      ...fixture,
      env: { ...fixture.env, npm_config_loglevel: 'silent' },
    }).catch((error: unknown) => error);
    debugStack = npmDebugStack(fixture.root, 'pack');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  const error = npmFailure(failure);
  expect(error.message).toContain('EJSONPARSE');
  expect(error.message).toContain('verbose stack');
  expect(error.message).toContain(debugStack);
});

test('retains npm install stderr and debug details after fixture cleanup', async () => {
  const fixture = createDiagnosticFixture();
  let failure: unknown;
  let debugStack = '';
  try {
    writeLocalPackage(fixture.packageDir, true);
    failure = await installPackedCli(fixture).catch((error: unknown) => error);
    debugStack = npmDebugStack(fixture.root, 'install');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  const error = npmFailure(failure);
  expect(error.message).toContain('NPMPACK_INSTALL_CONTROL');
  expect(error.message).toMatch(/npm (?:error|ERR!) code 23/);
  expect(error.message).toContain('verbose stack');
  expect(error.message).toContain(debugStack);
});

test('keeps concurrent invocations npm caches and logs private', async () => {
  const fixture = createDiagnosticFixture();
  const inheritedEnv = { ...fixture.env };
  const inheritedDirs = [fixture.env.npm_config_cache, fixture.env.npm_config_logs_dir];
  for (const dir of inheritedDirs) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'sentinel'), 'caller-owned evidence');
  }
  try {
    writeLocalPackage(fixture.packageDir, true);
    const calls = ['first', 'second'].map((name) => {
      const packDest = join(fixture.root, `${name}-pack`);
      const installPrefix = join(fixture.root, `${name}-install`);
      mkdirSync(packDest);
      mkdirSync(installPrefix);
      return { ...fixture, packDest, installPrefix };
    });
    const failures = await Promise.all(
      calls.map((call) => installPackedCli(call).catch((error: unknown) => error)),
    );
    for (const failure of failures)
      expect(npmFailure(failure).message).toContain('NPMPACK_INSTALL_CONTROL');
    const contexts = calls.map(({ installPrefix }) =>
      z
        .object({ cache: z.string(), logs: z.string() })
        .parse(JSON.parse(readFileSync(join(installPrefix, 'npm-context.json'), 'utf8'))),
    );
    expect(new Set(contexts.map(({ cache }) => cache)).size).toBe(2);
    expect(new Set(contexts.map(({ logs }) => logs)).size).toBe(2);
    for (const [index, { cache, logs }] of contexts.entries()) {
      for (const dir of [cache, logs]) {
        const path = relative(realpathSync(fixture.root), realpathSync(dir));
        expect(isAbsolute(path)).toBe(false);
        expect(path.split(/[\\/]/)).not.toContain('..');
        expect(inheritedDirs).not.toContain(dir);
      }
      const debugLogs = readdirSync(logs).filter((name) => name.endsWith('-debug-0.log'));
      const contents = debugLogs.map((name) => readFileSync(join(logs, name), 'utf8'));
      expect(contents).toHaveLength(2);
      expect(contents).toContainEqual(expect.stringMatching(/verbose title npm pack\b/));
      expect(contents).toContainEqual(expect.stringMatching(/verbose title npm install\b/));
      expect(contents.join('\n')).toContain(calls[index].installPrefix);
      expect(contents.join('\n')).not.toContain(calls[1 - index].installPrefix);
    }
    for (const dir of inheritedDirs) {
      expect(readdirSync(dir)).toEqual(['sentinel']);
      expect(readFileSync(join(dir, 'sentinel'), 'utf8')).toBe('caller-owned evidence');
    }
    expect(fixture.env).toEqual(inheritedEnv);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installs a valid local packed CLI', async () => {
  const fixture = createDiagnosticFixture();
  try {
    writeLocalPackage(fixture.packageDir);
    const installed = await installPackedCli(fixture);
    expect(existsSync(installed.binShim)).toBe(true);
    const result = await promisify(execFile)(process.execPath, [installed.cliPath]);
    expect(result.stdout.trim()).toBe('diagnostic fixture ready');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
