import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { describe, expect, test } from 'vitest';
import { resolveSkillInstallReportSettings } from './skill-install-report-config.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-report-config-'));
}

function writeUserConfig(home: string, yaml: string): string {
  const path = resolveConfigPath('user', home, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

describe('resolveSkillInstallReportSettings', () => {
  test('no user config at all → the schema default (on)', () => {
    expect(resolveSkillInstallReportSettings(freshHome()).enabled).toBe(true);
  });

  test('config present but silent on the key → the schema default (on)', () => {
    const home = freshHome();
    writeUserConfig(home, 'appearance:\n  theme: dark\n');
    expect(resolveSkillInstallReportSettings(home).enabled).toBe(true);
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
