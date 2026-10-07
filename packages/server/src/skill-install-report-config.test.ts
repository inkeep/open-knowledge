import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { createTempDirFactory } from '../../../test-support/temp-dir.test-helper.ts';
import { resolveSkillInstallReportSettings } from './skill-install-report-config.ts';

const makeTempDir = createTempDirFactory(afterAll);

function freshHome(): string {
  return makeTempDir('ok-report-config-');
}

function writeUserConfig(home: string, yaml: string): string {
  const path = resolveConfigPath('user', home, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

describe('resolveSkillInstallReportSettings', () => {
  test('no user config at all → the schema default (off)', () => {
    expect(resolveSkillInstallReportSettings(freshHome()).enabled).toBe(false);
  });

  test('config present but silent on the key → the schema default (off)', () => {
    const home = freshHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    expect(resolveSkillInstallReportSettings(home).enabled).toBe(false);
  });

  test('a skillInstallReports block without the enabled leaf → the schema default (off)', () => {
    const home = freshHome();
    writeUserConfig(home, 'telemetry:\n  skillInstallReports: {}\n');
    expect(resolveSkillInstallReportSettings(home).enabled).toBe(false);
  });

  test('the fallback follows the schema default rather than a literal of its own', async () => {
    vi.resetModules();
    vi.doMock('@inkeep/open-knowledge-core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@inkeep/open-knowledge-core')>();
      return {
        ...actual,
        ConfigSchema: {
          parse: () => ({ telemetry: { skillInstallReports: { enabled: true } } }),
        },
      };
    });
    try {
      const { resolveSkillInstallReportSettings: resolveWithFlippedDefault } = await import(
        './skill-install-report-config.ts'
      );
      expect(resolveWithFlippedDefault(freshHome()).enabled).toBe(true);
      const home = freshHome();
      writeUserConfig(home, 'appearance:\n  theme: dark\n');
      expect(resolveWithFlippedDefault(home).enabled).toBe(true);
    } finally {
      vi.doUnmock('@inkeep/open-knowledge-core');
      vi.resetModules();
    }
  });

  test('explicit false is honored', () => {
    const home = freshHome();
    writeUserConfig(home, 'telemetry:\n  skillInstallReports:\n    enabled: false\n');
    expect(resolveSkillInstallReportSettings(home).enabled).toBe(false);
  });

  test('explicit true is honored', () => {
    const home = freshHome();
    writeUserConfig(home, 'telemetry:\n  skillInstallReports:\n    enabled: true\n');
    expect(resolveSkillInstallReportSettings(home).enabled).toBe(true);
  });

  test('a config that exists but cannot be read → OFF, not the default', () => {
    const home = freshHome();
    const path = resolveConfigPath('user', home, home);
    mkdirSync(path, { recursive: true });
    expect(resolveSkillInstallReportSettings(home).enabled).toBe(false);
  });

  test('malformed YAML → OFF', () => {
    const home = freshHome();
    writeUserConfig(home, 'telemetry:\n  skillInstallReports:\n   enabled: [unclosed\n');
    expect(resolveSkillInstallReportSettings(home).enabled).toBe(false);
  });

  test('reports the home it resolved against', () => {
    const home = freshHome();
    expect(resolveSkillInstallReportSettings(home).home).toBe(home);
  });
});
