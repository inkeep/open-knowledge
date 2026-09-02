import type { ILink, ILinkProvider } from '@xterm/xterm';
import { describe, expect, test, vi } from 'vitest';
import type { CheckTargetExistsResult } from '@/lib/desktop-bridge-types';
import type { PageListCacheSnapshot } from '../editor/page-list-cache';
import {
  createTerminalFileLinkProvider,
  type TerminalFileLinkProviderDeps,
} from './terminal-link-provider';
import type { TerminalLinkTarget } from './terminal-links';

const PROJECT = '/Users/me/project';

function snapshot(partial: Partial<PageListCacheSnapshot> = {}): PageListCacheSnapshot {
  return { pages: new Set(), folderPaths: new Set(), pagesBySlug: new Map(), ...partial };
}

function makeProvider(overrides: Partial<TerminalFileLinkProviderDeps> = {}) {
  const activated: TerminalLinkTarget[] = [];
  const checkTargetExists = vi.fn(
    async (_kind: 'doc' | 'folder', _path: string): Promise<CheckTargetExistsResult> => 'exists',
  );
  const deps: TerminalFileLinkProviderDeps = {
    projectPath: PROJECT,
    readLogicalLine: () => undefined,
    getSnapshot: () => null,
    checkTargetExists,
    onActivate: (t) => activated.push(t),
    ...overrides,
  };
  return { provider: createTerminalFileLinkProvider(deps), activated, checkTargetExists };
}

function row(text: string): TerminalFileLinkProviderDeps['readLogicalLine'] {
  return (bufferLine: number) => ({ text, startLine: bufferLine, cols: 80 });
}

function provide(provider: ILinkProvider, line: number): Promise<ILink[] | undefined> {
  return new Promise((resolve) => provider.provideLinks(line, resolve));
}

describe('createTerminalFileLinkProvider', () => {
  test('returns a link for an existing path with a correct 1-based range', async () => {
    const { provider } = makeProvider({ readLogicalLine: row('see src/foo.ts here') });
    const links = await provide(provider, 3);
    expect(links).toHaveLength(1);
    const link = links?.[0];
    expect(link?.text).toBe('src/foo.ts');
    expect(link?.range).toEqual({ start: { x: 5, y: 3 }, end: { x: 14, y: 3 } });
  });

  test('activating a markdown path routes a doc target', async () => {
    const { provider, activated } = makeProvider({ readLogicalLine: row('edited notes/a.md') });
    const links = await provide(provider, 1);
    links?.[0]?.activate({} as MouseEvent, links[0].text);
    expect(activated).toEqual([{ kind: 'doc', relPath: 'notes/a.md' }]);
  });

  test('activating a non-doc path routes an asset target', async () => {
    const { provider, activated } = makeProvider({ readLogicalLine: row('wrote data/x.csv') });
    const links = await provide(provider, 1);
    links?.[0]?.activate({} as MouseEvent, links[0].text);
    expect(activated[0]).toEqual({ kind: 'asset', relPath: 'data/x.csv' });
  });

  test('links an out-of-project absolute path as external, without any probe', async () => {
    const { provider, activated, checkTargetExists } = makeProvider({
      readLogicalLine: row('built /tmp/out/report.pdf'),
    });
    const links = await provide(provider, 1);
    expect(links).toHaveLength(1);
    expect(checkTargetExists).not.toHaveBeenCalled();
    links?.[0]?.activate({} as MouseEvent, links[0].text);
    expect(activated[0]).toEqual({ kind: 'external', absPath: '/tmp/out/report.pdf' });
  });

  test('does not link a path the probe reports missing', async () => {
    const { provider } = makeProvider({
      readLogicalLine: row('missing gone/file.md'),
      checkTargetExists: async () => 'missing',
    });
    expect(await provide(provider, 1)).toBeUndefined();
  });

  test('does not link a relative path that escapes the project (ambiguous once cd-ed)', async () => {
    const { provider, checkTargetExists } = makeProvider({
      readLogicalLine: row('cat ../../etc/passwd.md'),
    });
    expect(await provide(provider, 1)).toBeUndefined();
    expect(checkTargetExists).not.toHaveBeenCalled();
  });

  test('resolves known content from the snapshot without any probe', async () => {
    const { provider, checkTargetExists } = makeProvider({
      readLogicalLine: row('open guides/setup.md'),
      getSnapshot: () => snapshot({ pages: new Set(['guides/setup']) }),
    });
    const links = await provide(provider, 1);
    expect(links).toHaveLength(1);
    expect(checkTargetExists).not.toHaveBeenCalled();
  });

  test('caches probe results across hovers of the same path', async () => {
    const { provider, checkTargetExists } = makeProvider({ readLogicalLine: row('x src/a.ts') });
    await provide(provider, 1);
    await provide(provider, 1);
    expect(checkTargetExists).toHaveBeenCalledTimes(1);
  });

  test('returns undefined for a blank line', async () => {
    const { provider } = makeProvider({ readLogicalLine: row('') });
    expect(await provide(provider, 1)).toBeUndefined();
  });

  test('honors the per-line link cap', async () => {
    const line = Array.from({ length: 8 }, (_, i) => `dir/f${i}.md`).join(' ');
    const { provider, checkTargetExists } = makeProvider({
      readLogicalLine: row(line),
      maxLinksPerLine: 3,
    });
    const links = await provide(provider, 1);
    expect(links).toHaveLength(3);
    expect(checkTargetExists).toHaveBeenCalledTimes(3);
  });

  test('a probe failure fails safe (no link)', async () => {
    const { provider } = makeProvider({
      readLogicalLine: row('x src/a.ts'),
      checkTargetExists: async () => {
        throw new Error('ipc down');
      },
    });
    expect(await provide(provider, 1)).toBeUndefined();
  });

  test('maps a path that wraps across rows to a multi-row range', async () => {
    const { provider } = makeProvider({
      readLogicalLine: () => ({ text: 'see docs/guide/very-long.md end', startLine: 1, cols: 20 }),
    });
    const links = await provide(provider, 2);
    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe('docs/guide/very-long.md');
    expect(links?.[0]?.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 7, y: 2 } });
  });

  test('a slash-bearing directory without a trailing slash falls back to a folder link', async () => {
    const checkTargetExists = vi.fn(
      async (kind: 'doc' | 'folder'): Promise<CheckTargetExistsResult> =>
        kind === 'folder' ? 'exists' : 'missing',
    );
    const { provider, activated } = makeProvider({
      readLogicalLine: row('cd packages/app now'),
      checkTargetExists,
    });
    const links = await provide(provider, 1);
    expect(links).toHaveLength(1);
    links?.[0]?.activate({} as MouseEvent, links[0].text);
    expect(activated[0]).toEqual({ kind: 'folder', relPath: 'packages/app' });
    expect(checkTargetExists.mock.calls.map((c) => c[0])).toEqual(['doc', 'folder']);
  });

  test('a missing path WITH an extension does not waste a folder retry', async () => {
    const checkTargetExists = vi.fn(async (): Promise<CheckTargetExistsResult> => 'missing');
    const { provider } = makeProvider({
      readLogicalLine: row('open gone/file.md'),
      checkTargetExists,
    });
    expect(await provide(provider, 1)).toBeUndefined();
    expect(checkTargetExists).toHaveBeenCalledTimes(1);
  });
});
