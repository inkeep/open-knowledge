import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LAUNCH_CONFIG_NAME } from './init.ts';
import { removeOwnLaunchEntry } from './launch-json-removal.ts';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-launch-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  return dir;
}

function writeLaunch(projectRoot: string, value: unknown): string {
  const p = join(projectRoot, '.claude', 'launch.json');
  writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}

describe('removeOwnLaunchEntry', () => {
  test('surgically removes OK’s entry, preserving a user’s other configuration', () => {
    const dir = project();
    try {
      const p = writeLaunch(dir, {
        version: '0.2.0',
        configurations: [
          { name: 'My App', type: 'node', request: 'launch' },
          {
            name: LAUNCH_CONFIG_NAME,
            runtimeExecutable: '/bin/sh',
            runtimeArgs: ['-l', '-c', 'x'],
          },
        ],
      });
      const outcome = removeOwnLaunchEntry(dir);
      expect(outcome.kind).toBe('removed');
      const after = JSON.parse(readFileSync(p, 'utf-8'));
      expect(after.configurations).toHaveLength(1);
      expect(after.configurations[0].name).toBe('My App');
      expect(after.version).toBe('0.2.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deletes the whole file when OK’s entry was the only configuration', () => {
    const dir = project();
    try {
      const p = writeLaunch(dir, {
        version: '0.2.0',
        configurations: [
          {
            name: LAUNCH_CONFIG_NAME,
            runtimeExecutable: '/bin/sh',
            runtimeArgs: ['-l', '-c', 'x'],
          },
        ],
      });
      const outcome = removeOwnLaunchEntry(dir);
      expect(outcome.kind).toBe('removed-file');
      expect(existsSync(p)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('not-present when there is no file, no configurations, or no OK entry', () => {
    const dir = project();
    try {
      expect(removeOwnLaunchEntry(dir).kind).toBe('not-present'); // no file
      writeLaunch(dir, { configurations: [{ name: 'Only Mine', type: 'node' }] });
      expect(removeOwnLaunchEntry(dir).kind).toBe('not-present'); // no OK entry
      writeLaunch(dir, { version: '0.2.0' });
      expect(removeOwnLaunchEntry(dir).kind).toBe('not-present'); // no configurations array
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preserves a leading BOM while surgically removing OK’s entry', () => {
    const dir = project();
    try {
      const p = join(dir, '.claude', 'launch.json');
      const body = JSON.stringify(
        {
          version: '0.2.0',
          configurations: [
            { name: 'My App', type: 'node' },
            {
              name: LAUNCH_CONFIG_NAME,
              runtimeExecutable: '/bin/sh',
              runtimeArgs: ['-l', '-c', 'x'],
            },
          ],
        },
        null,
        2,
      );
      writeFileSync(p, `\uFEFF${body}`);
      expect(removeOwnLaunchEntry(dir).kind).toBe('removed');
      const after = readFileSync(p, 'utf-8');
      expect(after.charCodeAt(0)).toBe(0xfeff); // BOM preserved
      const parsed = JSON.parse(after.slice(1));
      expect(parsed.configurations).toHaveLength(1);
      expect(parsed.configurations[0].name).toBe('My App');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('declines a malformed launch.json, leaving it byte-identical', () => {
    const dir = project();
    try {
      const p = join(dir, '.claude', 'launch.json');
      const raw = '{ not valid json ]';
      writeFileSync(p, raw);
      expect(removeOwnLaunchEntry(dir).kind).toBe('declined');
      expect(readFileSync(p, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
