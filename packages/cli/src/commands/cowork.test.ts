import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCoworkSkill } from './cowork.ts';

/**
 * Tests for `ok cowork` (hidden).
 *
 * Coverage:
 *   - Default output path goes to a Downloads-like dir
 *   - Custom --out path wins
 *   - --no-open produces `status: 'built'` without spawning anything
 *   - File-association invocation spawns `open`/`start`/`xdg-open` per platform
 *   - Unsupported platform falls back to `built` with a helpful message
 *   - Output file is a valid ZIP wrapping `open-knowledge/SKILL.md`
 */

// Minimal ChildProcess-like stub for spawnFn tests. We only use `unref()`
// and don't need the full ChildProcess surface.
function makeFakeSpawn(capture: {
  command?: string;
  args?: readonly string[];
  threw?: Error;
}): typeof spawn {
  return ((command: string, args: readonly string[]) => {
    if (capture.threw) throw capture.threw;
    capture.command = command;
    capture.args = args;
    return { unref: () => {} } as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn;
}

// picocolors emits ANSI codes when it detects color support (TTY or
// FORCE_COLOR=1, both common in CI). The composed message wraps individual
// words like `Customize` and `Skills` in their own `accent()` calls, which
// breaks contiguous-substring matching when codes are present. Strip codes
// before substring checks so the assertions are color-agnostic.
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('runCoworkSkill', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cowork-skill-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('builds to the provided --out path and exits without opening (--no-open)', async () => {
    const outPath = join(testDir, 'my-custom.skill');
    const result = await runCoworkSkill({ out: outPath, home: testDir, noOpen: true });

    expect(result.status).toBe('built');
    expect(result.exitCode).toBe(0);
    expect(result.outputPath).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.skillVersion).toMatch(/^\d+\.\d+\.\d+/);
    // With --no-open, message points at the Claude Desktop App manual
    // upload sequence (the 5-click Customize → Skills → + → ... flow).
    expect(result.message).toContain('Customize → Skills');
    expect(result.message).toContain('Upload skill');
  });

  it('spawns `open` on darwin when opening is allowed', async () => {
    const outPath = join(testDir, 'darwin.skill');
    const capture: { command?: string; args?: readonly string[] } = {};
    const result = await runCoworkSkill({
      out: outPath,
      home: testDir,
      platformName: 'darwin',
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('open');
    expect(capture.args).toEqual([outPath]);
    // Post-handoff message includes the 5-click upload sequence
    // (.skill opens the Claude Desktop App but doesn't auto-install).
    // Strip ANSI before substring checks: `Customize` and `Skills` are
    // each in their own `accent()` call, so colored output splits the
    // contiguous phrase. CI runs with FORCE_COLOR=1 / TTY; local typically
    // runs without — strip to make assertions color-agnostic.
    const plain = stripAnsi(result.message);
    expect(plain).toContain('Claude Desktop App opened');
    expect(plain).toContain('Customize (sidebar) → Skills');
    expect(plain).toContain('Upload skill');
  });

  it('spawns `cmd /c start` on win32', async () => {
    const outPath = join(testDir, 'win32.skill');
    const capture: { command?: string; args?: readonly string[] } = {};
    const result = await runCoworkSkill({
      out: outPath,
      home: testDir,
      platformName: 'win32',
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('cmd');
    expect(capture.args?.[0]).toBe('/c');
    expect(capture.args?.[1]).toBe('start');
    // Third arg is the empty-title placeholder; fourth is the path.
    expect(capture.args?.[3]).toBe(outPath);
  });

  it('spawns `xdg-open` on linux', async () => {
    const outPath = join(testDir, 'linux.skill');
    const capture: { command?: string; args?: readonly string[] } = {};
    const result = await runCoworkSkill({
      out: outPath,
      home: testDir,
      platformName: 'linux',
      spawnFn: makeFakeSpawn(capture),
    });

    expect(result.status).toBe('installed');
    expect(capture.command).toBe('xdg-open');
  });

  it('falls back to `built` with a helpful message on unsupported platforms', async () => {
    const outPath = join(testDir, 'aix.skill');
    const result = await runCoworkSkill({
      out: outPath,
      home: testDir,
      platformName: 'aix' as NodeJS.Platform,
      spawnFn: makeFakeSpawn({
        threw: new Error('spawn should not have been called'),
      }),
    });

    expect(result.status).toBe('built');
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('Handoff failed');
    expect(result.message).toContain("Platform 'aix' has no file-association invocation wired");
  });

  it('surfaces spawn errors as `built` (non-fatal)', async () => {
    const outPath = join(testDir, 'spawn-error.skill');
    const result = await runCoworkSkill({
      out: outPath,
      home: testDir,
      platformName: 'darwin',
      spawnFn: makeFakeSpawn({
        threw: new Error('EACCES: permission denied'),
      }),
    });

    // Build succeeded; handoff failed — user can still double-click manually.
    expect(result.status).toBe('built');
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('EACCES: permission denied');
    expect(existsSync(outPath)).toBe(true);
  });
});
