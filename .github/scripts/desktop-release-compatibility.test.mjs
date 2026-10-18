import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { smokeHistoricalUpgrade } from './smoke-historical-upgrade.mjs';

const workflow = parse(
  readFileSync(new URL('../workflows/desktop-release.yml', import.meta.url), 'utf8'),
);
const releaseWorkflow = parse(
  readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8'),
);
const catalogCompileSteps = [
  ...Object.entries(workflow.jobs).map(([job, { steps }]) => [`desktop-release ${job}`, steps]),
  ...Object.entries(releaseWorkflow.jobs).map(([job, { steps }]) => [`release ${job}`, steps]),
].flatMap(([label, steps]) =>
  (steps ?? [])
    .filter((step) => step.name === 'Compile the i18n catalogs from the .po files this build ships')
    .map((step) => [label, step]),
);

function runCatalogCompileStep(step, i18nCompile) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-release-i18n-'));
  try {
    const app = join(dir, step['working-directory']);
    const calls = join(dir, 'calls');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ scripts: i18nCompile ? { 'i18n:compile': i18nCompile } : {} }),
    );
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\necho "pnpm $* with $pnpm_config_script_shell" >> '${calls}'\n`,
    );
    chmodSync(join(bin, 'pnpm'), 0o755);
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
      cwd: app,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const inventoryStep = workflow.jobs['publish-assets'].steps.find(
  (step) => step.name === 'Define the expected asset inventory',
);

function inventory(channel, required) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-release-inventory-'));
  try {
    const envFile = join(dir, 'env');
    const result = spawnSync('bash', ['-c', inventoryStep.run], {
      cwd: dir,
      env: {
        ...process.env,
        GITHUB_ENV: envFile,
        CHANNEL: channel,
        REQUIRED: required,
        ARTIFACT_NAME: channel === 'beta' ? 'OpenKnowledge-Beta' : 'OpenKnowledge',
        VERSION: channel === 'beta' ? '0.78.0-beta.6' : '0.78.0',
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const contents = readFileSync(envFile, 'utf8');
    return {
      required: contents
        .split('EXPECTED_ASSETS<<OK_INVENTORY_EOF\n')[1]
        .split('\nOK_INVENTORY_EOF')[0]
        .split('\n'),
      allowed: contents
        .split('ALLOWED_ASSETS<<OK_ALLOWED_EOF\n')[1]
        .split('\nOK_ALLOWED_EOF')[0]
        .split('\n'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('legacy desktop release compatibility', () => {
  test('the historical upgrade gate refuses a developer machine', async () => {
    vi.stubEnv('GITHUB_ACTIONS', undefined);
    try {
      await expect(smokeHistoricalUpgrade([])).rejects.toThrow('isolated GitHub macOS runner');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('requires both complete Beta product families before publishing', () => {
    const { required, allowed } = inventory('beta', 'mac,windows,linux');
    expect(required).toEqual(allowed);
    expect(required).toHaveLength(28);
    expect(new Set(required).size).toBe(28);
    for (const prefix of ['beta', 'beta-product']) {
      for (const suffix of ['.yml', '-mac.yml', '-linux.yml', '-linux-arm64.yml']) {
        expect(required).toContain(`${prefix}${suffix}`);
      }
    }
    for (const product of ['OpenKnowledge', 'OpenKnowledge-Beta']) {
      expect(required).toContain(`${product}-0.78.0-beta.6-arm64-mac.zip`);
      expect(required).toContain(`${product}-Setup-x64.exe`);
      expect(required).toContain(`${product}-arm64.deb`);
    }
  });

  test('does not change Stable asset names or manifests', () => {
    const { required } = inventory('latest', 'mac,windows,linux');
    expect(required).toHaveLength(14);
    expect(required).toContain('latest-mac.yml');
    expect(required).toContain('OpenKnowledge-0.78.0-arm64-mac.zip');
    expect(required.some((name) => name.includes('Beta') || name.includes('beta'))).toBe(false);
  });

  test('a platform override cannot drop legacy macOS compatibility', () => {
    const { required, allowed } = inventory('beta', 'mac');
    expect(required).toHaveLength(10);
    expect(required).toContain('beta-mac.yml');
    expect(required).toContain('beta-product-mac.yml');
    expect(allowed).toHaveLength(28);
  });

  test('all platform matrices build legacy and separate Beta, but only one Stable', () => {
    const matrices = ['build-macos', 'build-windows', 'build-linux'].map(
      (name) => workflow.jobs[name].strategy.matrix,
    );
    expect(new Set(matrices.map((matrix) => matrix.variant)).size).toBe(1);
    expect(matrices[0].variant).toContain('["legacy-beta","beta"]');
    expect(matrices[0].variant).toContain('["stable"]');
    expect(matrices[2].runner).toEqual(['ubuntu-26.04', 'ubuntu-24.04-arm']);
  });
});

describe('i18n catalog compile against the tag being built', () => {
  test('every build job compiles its catalogs', () => {
    expect(catalogCompileSteps.map(([label]) => label)).toEqual([
      'desktop-release prepare',
      'desktop-release build-macos',
      'desktop-release build-windows',
      'desktop-release build-linux',
      'release build',
    ]);
  });

  test.each(catalogCompileSteps)(
    '%s runs the compile script through bash, which expands its catalog glob on Windows too',
    (_label, step) => {
      const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
      expect(
        runCatalogCompileStep(
          step,
          'pnpm run i18n:compile:catalogs && biome format --write src/locales/*/messages.json',
        ),
      ).toEqual([`pnpm run i18n:compile with ${bash}`]);
    },
  );

  test.each(catalogCompileSteps)(
    '%s compiles nothing for a tag without a compile script',
    (_label, step) => {
      expect(runCatalogCompileStep(step, undefined)).toEqual([]);
    },
  );
});
