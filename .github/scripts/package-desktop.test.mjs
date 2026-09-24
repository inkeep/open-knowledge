import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { packagingInvocation } from './package-desktop.mjs';

const script = fileURLToPath(new URL('./package-desktop.mjs', import.meta.url));

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
