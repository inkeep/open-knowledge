import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDirectoryRoot } from './directory-root.ts';
import { getLogger } from './logger.ts';

describe('resolveDirectoryRoot', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'ok-directory-root-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
  });

  function diagnosticSpies() {
    const logger = getLogger('directory-root');
    const warn = vi.spyOn(logger, 'warn');
    const debug = vi.spyOn(logger, 'debug');
    return () => [...warn.mock.calls, ...debug.mock.calls].map(([fields]) => fields);
  }

  it('returns the native spelling of an existing directory reached through a link, without a diagnostic', () => {
    const target = join(scratch, 'target');
    mkdirSync(target);
    const link = join(scratch, 'link');
    symlinkSync(target, link, 'dir');
    const diagnostics = diagnosticSpies();

    const resolved = resolveDirectoryRoot(link, { root: 'content', component: 'asset-walk' });

    expect(resolved).toBe(realpathSync.native(target));
    expect(diagnostics()).toEqual([]);
  });

  it('keeps the given path and records which root stayed unresolved, with the errno, when native resolution fails', () => {
    const file = join(scratch, 'not-a-directory');
    writeFileSync(file, '');
    const unresolvable = join(file, 'sub');
    const diagnostics = diagnosticSpies();

    const resolved = resolveDirectoryRoot(unresolvable, {
      root: 'project',
      component: 'persistence',
    });

    expect(resolved).toBe(unresolvable);
    expect(diagnostics()).toEqual([
      expect.objectContaining({ root: 'project', component: 'persistence', code: 'ENOTDIR' }),
    ]);
  });
});
