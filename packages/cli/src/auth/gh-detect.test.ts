import { describe, expect, test } from 'bun:test';
import type { ExecFileSyncFn } from './gh-detect.ts';
import { detectGh } from './gh-detect.ts';

function makeExec(responses: Record<string, { token?: string; error?: NodeJS.ErrnoException }>): {
  exec: ExecFileSyncFn;
  calls: string[];
} {
  const calls: string[] = [];
  const exec = ((cmd: string, args: readonly string[]) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    const r = responses[cmd];
    if (!r) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    if (r.error) throw r.error;
    return r.token ?? '';
  }) as unknown as ExecFileSyncFn;
  return { exec, calls };
}

describe('detectGh', () => {
  test('returns available:true with token when bare `gh` works', () => {
    const { exec, calls } = makeExec({ gh: { token: 'ghu_abc123' } });
    const result = detectGh(undefined, { _exec: exec, _fileExists: () => false });
    expect(result).toEqual({ available: true, token: 'ghu_abc123' });
    expect(calls).toEqual(['gh auth token']);
  });

  test('passes --hostname when host is supplied', () => {
    const { exec, calls } = makeExec({ gh: { token: 'ghu_xyz' } });
    detectGh('github.acme.com', { _exec: exec, _fileExists: () => false });
    expect(calls[0]).toBe('gh auth token --hostname github.acme.com');
  });

  test('hides Windows console windows when probing gh auth token', () => {
    let seenOptions: unknown;
    const exec = ((_cmd: string, _args: readonly string[], options?: unknown) => {
      seenOptions = options;
      return 'ghu_hidden';
    }) as unknown as ExecFileSyncFn;

    const result = detectGh(undefined, { _exec: exec, _fileExists: () => false });

    expect(result).toEqual({ available: true, token: 'ghu_hidden' });
    expect(seenOptions).toMatchObject({
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    expect((seenOptions as { stdio?: unknown }).stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  test('returns available:false when bare gh and no known paths exist', () => {
    const { exec } = makeExec({});
    const result = detectGh(undefined, { _exec: exec, _fileExists: () => false });
    expect(result).toEqual({ available: false });
  });

  test('falls back to /opt/homebrew/bin/gh when bare `gh` ENOENTs (Electron PATH case)', () => {
    const { exec, calls } = makeExec({
      '/opt/homebrew/bin/gh': { token: 'ghu_homebrew' },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/opt/homebrew/bin/gh',
    });
    expect(result).toEqual({ available: true, token: 'ghu_homebrew' });
    expect(calls).toEqual(['gh auth token', '/opt/homebrew/bin/gh auth token']);
  });

  test('skips absolute paths that do not exist on disk', () => {
    const { exec, calls } = makeExec({
      '/usr/local/bin/gh': { token: 'ghu_intel' },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/usr/local/bin/gh',
    });
    expect(result).toEqual({ available: true, token: 'ghu_intel' });
    expect(calls).toEqual(['gh auth token', '/usr/local/bin/gh auth token']);
  });

  test('treats empty-string token from gh as unauthenticated and tries next candidate', () => {
    const { exec, calls } = makeExec({
      gh: { token: '   \n' },
      '/opt/homebrew/bin/gh': { token: 'ghu_real' },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/opt/homebrew/bin/gh',
    });
    expect(result).toEqual({ available: true, token: 'ghu_real' });
    expect(calls).toHaveLength(2);
  });

  test('returns available:false when every candidate fails', () => {
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    const { exec } = makeExec({
      gh: { error: enoent },
      '/opt/homebrew/bin/gh': { error: enoent },
    });
    const result = detectGh(undefined, {
      _exec: exec,
      _fileExists: (p) => p === '/opt/homebrew/bin/gh',
    });
    expect(result).toEqual({ available: false });
  });
});
