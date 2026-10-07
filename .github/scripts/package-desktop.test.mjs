import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { packagingInvocation, SINGLE_NOTARIZER_ARG } from './package-desktop.mjs';

const script = fileURLToPath(new URL('./package-desktop.mjs', import.meta.url));

function launcherFixture(body) {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-package-failure-'));
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, 'scripts', 'run-electron-builder.mjs'), body);
  return cwd;
}

const wrapperEnv = {
  ...process.env,
  npm_config_user_agent: 'pnpm/10.33.0',
  OK_DESKTOP_VARIANT: 'beta',
};

test.each(
  [false, true].flatMap((modern) =>
    ['--mac', '--win', '--linux'].map((platform) => [modern, platform]),
  ),
)(
  'packages source with variant launcher present=%s on %s without changing its identity',
  (modern, platform) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-package-source-'));
    try {
      const launcher = modern
        ? join(cwd, 'scripts', 'run-electron-builder.mjs')
        : join(cwd, 'node_modules', 'electron-builder', 'cli.js');
      mkdirSync(join(launcher, '..'), { recursive: true });
      writeFileSync(join(cwd, 'package.json'), '{}');
      const output = join(cwd, 'observed.json');
      writeFileSync(
        launcher,
        `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),pm:process.env.npm_config_user_agent,variant:process.env.OK_DESKTOP_VARIANT}));`.replace(
          "require('node:fs')",
          modern ? "(await import('node:fs'))" : "require('node:fs')",
        ),
      );
      const args = [platform, '--publish', 'never', '--config.extraMetadata.version=0.77.9'];
      execFileSync(process.execPath, [script, ...args], {
        cwd,
        env: {
          ...process.env,
          npm_config_user_agent: 'pnpm/10.33.0',
          OK_DESKTOP_VARIANT: modern ? 'beta' : 'stable',
        },
      });
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        args:
          modern || platform !== '--linux'
            ? args
            : [...args, '--config', 'electron-builder.linux.yml'],
        pm: 'pnpm/10.33.0',
        variant: modern ? 'beta' : 'stable',
      });
      if (!modern)
        expect(() => packagingInvocation({ cwd, args, variant: 'beta' })).toThrow(
          'original Stable identity',
        );
      const failed = spawnSync(process.execPath, [script, ...args], {
        cwd,
        env: { ...process.env, npm_config_user_agent: '' },
        encoding: 'utf8',
      });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain('pnpm exec node');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test('a launcher that fails fails the wrapper with its exit status', () => {
  const cwd = launcherFixture('process.exit(7);');
  try {
    const result = spawnSync(process.execPath, [script, '--linux', '--publish', 'never'], {
      cwd,
      env: wrapperEnv,
      encoding: 'utf8',
    });
    expect(result.status).toBe(7);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'a launcher killed by a signal fails the wrapper and names the signal',
  () => {
    const cwd = launcherFixture("process.kill(process.pid, 'SIGTERM');");
    try {
      const result = spawnSync(process.execPath, [script, '--linux', '--publish', 'never'], {
        cwd,
        env: wrapperEnv,
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Desktop packaging terminated by SIGTERM');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test('an npm user agent is refused before the launcher runs', () => {
  const cwd = launcherFixture("(await import('node:fs')).writeFileSync('launched', '');");
  try {
    const result = spawnSync(process.execPath, [script, '--linux', '--publish', 'never'], {
      cwd,
      env: {
        ...wrapperEnv,
        npm_config_user_agent: 'npm/10.9.2 node/v24.21.0 linux x64 workspaces/false',
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pnpm exec node');
    expect(existsSync(join(cwd, 'launched'))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function sourceFixture({ launcher, afterSign }) {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-package-notarizer-'));
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  if (launcher) writeFileSync(join(cwd, 'scripts', 'run-electron-builder.mjs'), '');
  if (afterSign !== undefined) writeFileSync(join(cwd, 'scripts', 'afterSign.mjs'), afterSign);
  return cwd;
}

const NOTARIZING_AFTER_SIGN = "import { notarize } from '@electron/notarize';\n";

test.each([true, false])(
  'a macOS package of a source whose afterSign notarizes turns off the built-in notarizer (variant launcher present=%s)',
  (launcher) => {
    const cwd = sourceFixture({ launcher, afterSign: NOTARIZING_AFTER_SIGN });
    try {
      const args = ['--mac', '--publish', 'never', '--config.extraMetadata.version=0.83.0'];
      const invocation = packagingInvocation({ cwd, args, variant: 'stable' });
      expect(invocation.slice(1)).toEqual([...args, SINGLE_NOTARIZER_ARG]);
      expect(args).not.toContain(SINGLE_NOTARIZER_ARG);
      expect(
        packagingInvocation({ cwd, args: [...args, SINGLE_NOTARIZER_ARG], variant: 'stable' })
          .slice(1)
          .filter((arg) => arg === SINGLE_NOTARIZER_ARG),
      ).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test.each([
  ['--win', NOTARIZING_AFTER_SIGN],
  ['--linux', NOTARIZING_AFTER_SIGN],
  ['--mac', "console.log('fuse verification only');\n"],
  ['--mac', undefined],
])(
  'packaging %s leaves electron-builder notarization untouched when afterSign is %j',
  (platform, afterSign) => {
    const cwd = sourceFixture({ launcher: true, afterSign });
    try {
      const args = [platform, '--publish', 'never'];
      expect(packagingInvocation({ cwd, args, variant: 'beta' }).slice(1)).toEqual(args);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test('electron-builder reads the single-notarizer argument as notarize: false', async () => {
  let yargs;
  let configureBuildCommand;
  let normalizeOptions;
  let validateConfiguration;
  try {
    const desktopRequire = createRequire(
      fileURLToPath(new URL('../../packages/desktop/package.json', import.meta.url)),
    );
    const builderDir = dirname(desktopRequire.resolve('electron-builder/package.json'));
    const builderRequire = createRequire(join(builderDir, 'package.json'));
    yargs = builderRequire('yargs');
    ({ configureBuildCommand, normalizeOptions } = builderRequire('./out/builder.js'));
    const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
    ({ validateConfiguration } = appBuilderRequire('./out/util/config/config.js'));
    for (const fn of [yargs, configureBuildCommand, normalizeOptions, validateConfiguration]) {
      if (typeof fn !== 'function') throw new TypeError('an expected export is not a function');
    }
  } catch (error) {
    throw new Error(
      `This test proves ${SINGLE_NOTARIZER_ARG} reaches electron-builder as notarize: false, so a macOS release submits to Apple once. It reads electron-builder 26.16.1 internals that this electron-builder no longer has; re-point it at the CLI argument parser and config validator, do not delete it.`,
      { cause: error },
    );
  }

  const argv = configureBuildCommand(
    yargs([
      '--mac',
      '--publish',
      'never',
      '--config.extraMetadata.version=0.83.0',
      SINGLE_NOTARIZER_ARG,
      '--config',
      '.variant-build/electron-builder.yml',
    ]),
  ).parseSync();
  const { config } = normalizeOptions(argv);
  const merged = { appId: 'ai.openknowledge.test', ...config, extends: undefined };
  await validateConfiguration(merged, { add() {}, isEnabled: false });

  expect(config.extends).toBe('.variant-build/electron-builder.yml');
  expect(merged.mac.notarize).toBe(false);
});
