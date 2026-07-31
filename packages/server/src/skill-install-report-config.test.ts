/**
 * This resolver IS the user's opt-out. Its three branches — absent file,
 * explicit `false`, unreadable file — decide whether anything leaves the
 * machine, so each one is pinned here rather than left to inspection.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { describe, expect, test } from 'vitest';
import { resolveSkillInstallReportSettings } from './skill-install-report-config.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-report-config-'));
}

/** Write a user config with the given YAML body. */
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

  // The safe-fail direction for a setting that governs what leaves the machine.
  // A file that EXISTS but cannot be read may hold an explicit decline, and
  // assuming consent because we couldn't check is the wrong way to be wrong.
  test('a config that exists but cannot be read → OFF, not the default', () => {
    const home = freshHome();
    const path = resolveConfigPath('user', home, home);
    // A directory where the file belongs: every read fails with EISDIR.
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
