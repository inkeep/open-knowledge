import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { packagingInvocation } from './package-desktop.mjs';

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
