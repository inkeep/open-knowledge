import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  HocuspocusAuthRejection,
  type HocuspocusAuthRejectionReason,
} from './auth-token-schema.ts';
import type { DiskEvent } from './file-watcher.ts';
import { createServer, type ServerInstance } from './server-factory.ts';

const watcher = vi.hoisted(() => ({
  deliver: null as null | ((event: DiskEvent) => Promise<void>),
}));

vi.mock('./file-watcher.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-watcher.ts')>();
  return {
    ...actual,
    startWatcher: (
      ...[contentDir, onDiskEvent, ...rest]: Parameters<typeof actual.startWatcher>
    ) => {
      watcher.deliver = onDiskEvent;
      return actual.startWatcher(contentDir, onDiskEvent, ...rest);
    },
  };
});

const fixtures: string[] = [];

afterEach(() => {
  watcher.deliver = null;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

async function guardOutcome(
  server: ServerInstance,
  documentName: string,
): Promise<HocuspocusAuthRejectionReason | 'admitted'> {
  const guard = server.hocuspocus.configuration.extensions.find(
    (extension) => (extension as { __kind?: string }).__kind === 'removal-redirect-guard',
  ) as { onAuthenticate: (payload: { documentName: string }) => Promise<void> } | undefined;
  if (!guard) throw new Error('expected the removal-redirect guard on hocuspocus');
  try {
    await guard.onAuthenticate({ documentName });
    return 'admitted';
  } catch (err) {
    if (err instanceof HocuspocusAuthRejection) return err.kind;
    throw err;
  }
}

describe('removal guard and watcher updates', () => {
  test('a watcher update at a renamed-away name stops redirecting that name', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-removal-update-'));
    const home = mkdtempSync(join(tmpdir(), 'ok-removal-update-home-'));
    fixtures.push(contentDir, home);
    const server = createServer({
      contentDir,
      quiet: true,
      gitEnabled: false,
      configHomedirOverride: home,
      skipStateManifestCheck: true,
    });
    try {
      await server.ready;
      const deliver = watcher.deliver;
      if (!deliver) throw new Error('expected the server to start a watcher');

      writeFileSync(join(contentDir, 'successor.md'), '# Successor\n');
      await deliver({
        kind: 'rename',
        oldPath: join(contentDir, 'original.md'),
        newPath: join(contentDir, 'successor.md'),
        oldDocName: 'original',
        newDocName: 'successor',
        content: '# Successor\n',
      });
      expect(await guardOutcome(server, 'original')).toBe('rename-redirect');

      await deliver({
        kind: 'update',
        path: join(contentDir, 'original.md'),
        docName: 'original',
        content: '# Recreated\n',
      });
      expect(await guardOutcome(server, 'original')).toBe('admitted');
    } finally {
      await server.destroy();
    }
  });
});
