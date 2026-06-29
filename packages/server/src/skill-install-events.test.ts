
import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordSkillInstallEvent,
  SKILL_INSTALL_EVENTS_FILE_REL,
  type SkillInstallEvent,
} from './skill-install-events.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-skill-install-events-'));
}

function eventsFilePath(home: string): string {
  return join(home, ...SKILL_INSTALL_EVENTS_FILE_REL);
}

function makeEvent(overrides: Partial<SkillInstallEvent> = {}): SkillInstallEvent {
  return {
    ts: '2026-05-04T12:00:00.000Z',
    surface: 'electron-build-and-open',
    target: 'claude-cowork',
    outcome: 'installed',
    version: '0.3.0',
    ...overrides,
  };
}

describe('recordSkillInstallEvent — happy path', () => {
  test('appends one JSONL line per call to ~/.ok/skill-install-events.jsonl', async () => {
    const home = freshHome();
    try {
      await recordSkillInstallEvent(makeEvent({ outcome: 'installed', version: '1.0.0' }), {
        homedir: () => home,
      });
      await recordSkillInstallEvent(makeEvent({ outcome: 'skip-current', version: '1.0.0' }), {
        homedir: () => home,
      });

      const raw = readFileSync(eventsFilePath(home), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(2);
      const first = JSON.parse(lines[0] as string) as SkillInstallEvent;
      const second = JSON.parse(lines[1] as string) as SkillInstallEvent;
      expect(first.outcome).toBe('installed');
      expect(second.outcome).toBe('skip-current');
      expect(first.target).toBe('claude-cowork');
      expect(second.version).toBe('1.0.0');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('appends to a pre-existing file without truncating', async () => {
    const home = freshHome();
    try {
      await mkdir(join(home, '.ok'), { recursive: true });
      await writeFile(eventsFilePath(home), '{"existing":"line"}\n', 'utf-8');

      await recordSkillInstallEvent(makeEvent(), { homedir: () => home });

      const raw = readFileSync(eventsFilePath(home), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe('{"existing":"line"}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('recordSkillInstallEvent — fail-soft contract', () => {
  test('no HOME → warns + resolves; never throws', async () => {
    const warnRecorder: ((data: unknown, message: string) => void) & {
      mock: { calls: ReadonlyArray<readonly [unknown, string]> };
    } = mock((_data: unknown, _message: string) => {}) as unknown as typeof warnRecorder;
    await expect(
      recordSkillInstallEvent(makeEvent(), {
        homedir: () => '',
        warn: warnRecorder,
      }),
    ).resolves.toBeUndefined();
    expect(warnRecorder).toHaveBeenCalledTimes(1);
    const callArgs = warnRecorder.mock.calls[0];
    expect(callArgs?.[1]).toContain('HOME not resolvable');
  });

  test('mkdir failure → warns + resolves; no JSONL written', async () => {
    const home = freshHome();
    try {
      const blocker = join(home, 'blocker-file');
      await writeFile(blocker, 'not a directory', 'utf-8');

      const warnRecorder: ((data: unknown, message: string) => void) & {
        mock: { calls: ReadonlyArray<readonly [unknown, string]> };
      } = mock((_data: unknown, _message: string) => {}) as unknown as typeof warnRecorder;
      await expect(
        recordSkillInstallEvent(makeEvent(), {
          homedir: () => blocker,
          warn: warnRecorder,
        }),
      ).resolves.toBeUndefined();
      expect(warnRecorder).toHaveBeenCalledTimes(1);
      const msg = warnRecorder.mock.calls[0]?.[1];
      expect(msg).toContain('mkdir failed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('append failure → warns + resolves', async () => {
    const home = freshHome();
    try {
      await mkdir(eventsFilePath(home), { recursive: true });

      const warnRecorder: ((data: unknown, message: string) => void) & {
        mock: { calls: ReadonlyArray<readonly [unknown, string]> };
      } = mock((_data: unknown, _message: string) => {}) as unknown as typeof warnRecorder;
      await expect(
        recordSkillInstallEvent(makeEvent(), {
          homedir: () => home,
          warn: warnRecorder,
        }),
      ).resolves.toBeUndefined();
      expect(warnRecorder).toHaveBeenCalledTimes(1);
      const msg = warnRecorder.mock.calls[0]?.[1];
      expect(msg).toContain('append failed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
