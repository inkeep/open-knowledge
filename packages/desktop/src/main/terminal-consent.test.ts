import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { describe, expect, test } from 'vitest';
import {
  isTerminalConsented,
  isTerminalConsentedWithGrace,
  readTerminalShellSetting,
  TERMINAL_CONSENT_GRACE_TIMEOUT_MS,
} from './terminal-consent.ts';

const STORE_DEBOUNCE_MS = 2000;

function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'ok-terminal-consent-'));
}

function writeConsent(projectDir: string, value: unknown): void {
  writeRaw(projectDir, `terminal:\n  enabled: ${JSON.stringify(value)}\n`);
}

function writeRaw(projectDir: string, yaml: string): void {
  const path = resolveConfigPath('project-local', projectDir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, yaml, 'utf-8');
}

describe('isTerminalConsented (fail-open backstop)', () => {
  test('explicit terminal.enabled: false → refused (the only refusal)', () => {
    const dir = makeProjectDir();
    try {
      writeConsent(dir, false);
      expect(isTerminalConsented(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent file → allowed', () => {
    const dir = makeProjectDir();
    try {
      expect(isTerminalConsented(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('terminal.enabled: true → allowed', () => {
    const dir = makeProjectDir();
    try {
      writeConsent(dir, true);
      expect(isTerminalConsented(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('terminal.enabled: null → allowed', () => {
    const dir = makeProjectDir();
    try {
      writeConsent(dir, null);
      expect(isTerminalConsented(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent leaf (terminal block with no enabled) → allowed', () => {
    const dir = makeProjectDir();
    try {
      writeRaw(dir, 'terminal: {}\n');
      expect(isTerminalConsented(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no terminal block at all → allowed', () => {
    const dir = makeProjectDir();
    try {
      writeRaw(dir, 'git:\n  autoSync:\n    enabled: true\n');
      expect(isTerminalConsented(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed YAML → allowed (parse error fails open, not closed)', () => {
    const dir = makeProjectDir();
    try {
      writeRaw(dir, 'terminal:\n  enabled: [1, 2');
      expect(isTerminalConsented(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-boolean enabled (string "false") → allowed; only the literal boolean false refuses', () => {
    const dir = makeProjectDir();
    try {
      writeConsent(dir, 'false');
      expect(isTerminalConsented(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readTerminalShellSetting', () => {
  test('reads a configured non-empty string from project-local config', () => {
    const dir = makeProjectDir();
    try {
      writeRaw(dir, 'terminal:\n  shell: C:\\Tools\\pwsh.exe\n');
      expect(readTerminalShellSetting(dir)).toEqual({
        kind: 'configured',
        shell: 'C:\\Tools\\pwsh.exe',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(['', '   '])('treats %j as unset', (shell) => {
    const dir = makeProjectDir();
    try {
      writeRaw(dir, `terminal:\n  shell: ${JSON.stringify(shell)}\n`);
      expect(readTerminalShellSetting(dir)).toEqual({ kind: 'unset' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('classifies a present non-string override as invalid', () => {
    const dir = makeProjectDir();
    try {
      writeRaw(dir, 'terminal:\n  shell: 42\n');
      expect(readTerminalShellSetting(dir)).toEqual({
        kind: 'invalid',
        reason: 'invalid-value',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing and absent settings are unset while malformed YAML is diagnosed', () => {
    const missing = makeProjectDir();
    const malformed = makeProjectDir();
    const absent = makeProjectDir();
    try {
      writeRaw(malformed, 'terminal:\n  shell: [');
      writeRaw(absent, 'terminal:\n  enabled: true\n');
      expect(readTerminalShellSetting(missing)).toEqual({ kind: 'unset' });
      expect(readTerminalShellSetting(malformed)).toEqual({
        kind: 'invalid',
        reason: 'config-unreadable',
      });
      expect(readTerminalShellSetting(absent)).toEqual({ kind: 'unset' });
    } finally {
      for (const dir of [missing, malformed, absent]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('grace budget vs. store debounce', () => {
  test('default grace budget exceeds the 2000ms store debounce', () => {
    expect(TERMINAL_CONSENT_GRACE_TIMEOUT_MS).toBeGreaterThan(STORE_DEBOUNCE_MS);
  });

  test('a just-lifted opt-out resolves true the moment the re-enable write lands', async () => {
    const dir = makeProjectDir();
    try {
      writeConsent(dir, false);
      setTimeout(() => writeConsent(dir, true), 120);
      expect(isTerminalConsented(dir)).toBe(false);
      const allowed = await isTerminalConsentedWithGrace(dir, {
        timeoutMs: 1000,
        intervalMs: 20,
      });
      expect(allowed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a project that stays opted out (enabled: false) keeps refusing across the window', async () => {
    const dir = makeProjectDir();
    try {
      writeConsent(dir, false);
      const allowed = await isTerminalConsentedWithGrace(dir, {
        timeoutMs: 100,
        intervalMs: 20,
      });
      expect(allowed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
