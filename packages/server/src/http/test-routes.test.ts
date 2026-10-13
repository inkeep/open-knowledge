import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import type { ConflictAuthority } from '../conflict-authority.ts';
import { loggerFactory } from '../logger.ts';
import { createTestRoutes, type TestRouteDeps } from './test-routes.ts';

const contentDirs: string[] = [];

afterEach(() => {
  for (const dir of contentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildGroup(overrides: Partial<TestRouteDeps> = {}) {
  const deps = {
    agentPresence: undefined,
    resetSettingsForTest: undefined,
    settleDiskEvents: undefined,
    recentlyRemovedDocs: undefined,
    conflicts: {} as ConflictAuthority,
    durabilityState: {} as TestRouteDeps['durabilityState'],
    resolveAlias: (docName) => docName,
    contentDir: '/nonexistent-content',
    log: loggerFactory.getLogger('test'),
    sessionManager: {} as AgentSessionManager,
    hocuspocus: {} as Hocuspocus,
    forceUnloadDocument: undefined,
    derivedDocumentIndex: undefined,
    contentFilter: undefined,
    bumpSkillsCatalogGen: () => {},
    signalChannel: undefined,
    flushGitCommit: undefined,
    rescanFiles: undefined,
    ...overrides,
  } satisfies TestRouteDeps;
  return createTestRoutes(deps);
}

async function postTestReset(group: ReturnType<typeof buildGroup>, query: string) {
  const resolved = group.table.resolve('/api/test-reset');
  if (resolved === null) throw new Error('/api/test-reset is not registered');
  const { res, captured } = makeCaptureRes();
  await resolved.dispatch(
    makeSyntheticReq({ method: 'POST', url: `/api/test-reset${query}` }),
    res,
  );
  return captured;
}

function contentDirWithTestDoc(text: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'test-routes-')));
  contentDirs.push(dir);
  writeFileSync(join(dir, 'test-doc.md'), text, 'utf-8');
  return dir;
}

const FAMILY_PATHS = [
  '/api/test-reset',
  '/api/test-flush-git',
  '/api/test-rescan-backlinks',
  '/api/test-rescan-files',
];

describe('createTestRoutes table', () => {
  test('registers exactly the four conditional test paths', () => {
    expect([...buildGroup().paths].sort()).toEqual([...FAMILY_PATHS].sort());
  });

  test('classifies every test path as mutating', () => {
    const { table } = buildGroup();
    for (const path of FAMILY_PATHS) expect(table.isMutating(path), path).toBe(true);
  });
});

describe('POST /api/test-reset scope', () => {
  test('a server-scope reset on a server without an isolated config home is refused before anything is reset', async () => {
    const contentDir = contentDirWithTestDoc('the developer’s own notes\n');
    const closedSessions: Array<string | undefined> = [];
    const group = buildGroup({
      contentDir,
      sessionManager: {
        closeAll: async (docName?: string) => {
          closedSessions.push(docName);
        },
      } as AgentSessionManager,
    });

    const captured = await postTestReset(group, '?scope=server');

    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'scope=server needs a server started with an isolated config home.',
    });
    expect(closedSessions).toEqual([]);
    expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe(
      'the developer’s own notes\n',
    );
  });

  test.each(['false', 'true', ''])(
    'a server-scope reset naming reset-okignore=%s is refused before anything is reset',
    async (value) => {
      const contentDir = contentDirWithTestDoc('kept\n');
      writeFileSync(join(contentDir, '.okignore'), 'kept-by-request/\n', 'utf-8');
      const closedSessions: Array<string | undefined> = [];
      const group = buildGroup({
        contentDir,
        resetSettingsForTest: () => {},
        sessionManager: {
          closeAll: async (docName?: string) => {
            closedSessions.push(docName);
          },
        } as AgentSessionManager,
      });

      const captured = await postTestReset(group, `?scope=server&reset-okignore=${value}`);

      expect(captured.status).toBe(400);
      expect(JSON.parse(captured.body)).toMatchObject({
        type: 'urn:ok:error:invalid-request',
        title:
          'reset-okignore cannot be combined with scope=server: a server-scope reset always restores .okignore.',
      });
      expect(closedSessions).toEqual([]);
      expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe('kept\n');
      expect(readFileSync(join(contentDir, '.okignore'), 'utf-8')).toBe('kept-by-request/\n');
    },
  );

  test('an unknown scope is rejected as an invalid request before anything is reset', async () => {
    const contentDir = contentDirWithTestDoc('kept\n');
    const group = buildGroup({ contentDir, resetSettingsForTest: () => {} });

    const captured = await postTestReset(group, '?scope=everything');

    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'scope must be one of document, server.',
    });
    expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe('kept\n');
  });
});
