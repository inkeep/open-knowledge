import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTerminalConsented,
  isTerminalConsentedWithGrace,
} from '../../src/main/terminal-consent.ts';

const created: string[] = [];

function makeProject(localConfigYaml: string | null): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-terminal-consent-'));
  created.push(projectDir);
  if (localConfigYaml !== null) {
    const localDir = join(projectDir, '.ok', 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'config.yml'), localConfigYaml, 'utf-8');
  }
  return projectDir;
}

function writeLocalConfig(projectDir: string, yaml: string): void {
  const localDir = join(projectDir, '.ok', 'local');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, 'config.yml'), yaml, 'utf-8');
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isTerminalConsented', () => {
  test('false only when terminal.enabled is explicitly false (opted out)', () => {
    expect(isTerminalConsented(makeProject('terminal:\n  enabled: false\n'))).toBe(false);
  });

  test('true when terminal.enabled is true', () => {
    expect(isTerminalConsented(makeProject('terminal:\n  enabled: true\n'))).toBe(true);
  });

  test('true when terminal.enabled is null', () => {
    expect(isTerminalConsented(makeProject('terminal:\n  enabled: null\n'))).toBe(true);
  });

  test('true when the leaf is absent (default-on)', () => {
    expect(isTerminalConsented(makeProject('git:\n  autoSync:\n    enabled: true\n'))).toBe(true);
  });

  test('true when the project-local config file is missing (default-on)', () => {
    expect(isTerminalConsented(makeProject(null))).toBe(true);
  });

  test('true on malformed YAML (fails open, not closed)', () => {
    expect(isTerminalConsented(makeProject('terminal: {{{ not yaml'))).toBe(true);
  });

  test('true when terminal.enabled is a non-boolean (only literal false opts out)', () => {
    expect(isTerminalConsented(makeProject('terminal:\n  enabled: "false"\n'))).toBe(true);
  });
});

describe('isTerminalConsentedWithGrace', () => {
  test('resolves true immediately when the project is not opted out', async () => {
    const projectDir = makeProject('terminal:\n  enabled: true\n');
    expect(await isTerminalConsentedWithGrace(projectDir, { timeoutMs: 300, intervalMs: 20 })).toBe(
      true,
    );
  });

  test('resolves true once a re-enable lands partway through the grace window', async () => {
    const projectDir = makeProject('terminal:\n  enabled: false\n');
    setTimeout(() => writeLocalConfig(projectDir, 'terminal:\n  enabled: true\n'), 120);
    expect(await isTerminalConsentedWithGrace(projectDir, { timeoutMs: 750, intervalMs: 25 })).toBe(
      true,
    );
  });

  test('resolves false when the leaf stays false (opted out) through the window', async () => {
    const projectDir = makeProject('terminal:\n  enabled: false\n');
    expect(await isTerminalConsentedWithGrace(projectDir, { timeoutMs: 200, intervalMs: 25 })).toBe(
      false,
    );
  });
});
