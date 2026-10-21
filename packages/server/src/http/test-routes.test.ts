import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Document, Hocuspocus } from '@hocuspocus/server';
import { type AgentPresenceEntry, SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { AgentPresenceBroadcaster } from '../agent-presence.ts';
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
      title: 'scope must be one of document, server, presence.',
    });
    expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe('kept\n');
  });
});

function presenceEntry(displayName: string): AgentPresenceEntry {
  return {
    displayName,
    icon: 'claude',
    color: '#D97757',
    currentDoc: 'seeded.md',
    mode: 'writing',
    ts: Date.now(),
  };
}

function presenceResetRig() {
  const contentDir = contentDirWithTestDoc('kept\n');
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(
    join(contentDir, '.ok', 'config.yml'),
    'contentRules:\n  markdownlint:\n    enabled: true\n',
    'utf-8',
  );
  writeFileSync(join(contentDir, '.okignore'), 'kept-by-caller/\n', 'utf-8');

  let awarenessState: Record<string, unknown> | null = null;
  const awareness = {
    getLocalState: () => awarenessState,
    setLocalState: (next: Record<string, unknown> | null) => {
      awarenessState = next;
    },
  };
  const documents = new Map<string, Document>([
    [SYSTEM_DOC_NAME, { name: SYSTEM_DOC_NAME, awareness } as unknown as Document],
    ['test-doc', { name: 'test-doc', getConnections: () => [{}] } as unknown as Document],
    ['seeded', { name: 'seeded', getConnections: () => [{}] } as unknown as Document],
  ]);
  const closedConnections: Array<string | undefined> = [];
  const closedSessions: Array<string | undefined> = [];
  const unloadedDocuments: string[] = [];
  let settingsResets = 0;
  const hocuspocus = {
    documents,
    debouncer: { isDebounced: () => false, executeNow: async () => {} },
    closeConnections: (docName?: string) => {
      closedConnections.push(docName);
    },
    unloadDocument: async (document: Document) => {
      unloadedDocuments.push(document.name);
    },
  } as unknown as Hocuspocus;
  const agentPresence = new AgentPresenceBroadcaster(hocuspocus);
  agentPresence.setPresence('claude-1', presenceEntry('Claude'));
  agentPresence.setPresence('agent-seeded', presenceEntry('Seeded agent'));

  const group = buildGroup({
    contentDir,
    agentPresence,
    hocuspocus,
    resetSettingsForTest: () => {
      settingsResets++;
    },
    forceUnloadDocument: async (document: Document) => {
      unloadedDocuments.push(document.name);
    },
    sessionManager: {
      closeAll: async (docName?: string) => {
        closedSessions.push(docName);
      },
      liveSessionCount: 1,
    } as unknown as AgentSessionManager,
    durabilityState: {
      deleteReconciledBase: () => {},
      listStaleExternalWrites: () => [],
    } as unknown as TestRouteDeps['durabilityState'],
    conflicts: { dissolveReconcile: () => {} } as unknown as ConflictAuthority,
  });

  return {
    group,
    contentDir,
    agentPresence,
    documents,
    closedConnections,
    closedSessions,
    unloadedDocuments,
    settingsResets: () => settingsResets,
  };
}

describe('POST /api/test-reset scope=presence', () => {
  test('clears every agent presence and leaves sessions, connections, loaded documents, settings and files as the caller left them', async () => {
    const rig = presenceResetRig();
    expect(Object.keys(rig.agentPresence.getPresenceMap()).sort()).toEqual([
      'agent-seeded',
      'claude-1',
    ]);

    const captured = await postTestReset(rig.group, '?scope=presence');

    expect(captured.status).toBe(200);
    expect(rig.agentPresence.getPresenceMap()).toEqual({});
    expect(rig.closedSessions).toEqual([]);
    expect(rig.closedConnections).toEqual([]);
    expect(rig.unloadedDocuments).toEqual([]);
    expect([...rig.documents.keys()].sort()).toEqual(
      [SYSTEM_DOC_NAME, 'seeded', 'test-doc'].sort(),
    );
    expect(rig.settingsResets()).toBe(0);
    expect(readFileSync(join(rig.contentDir, 'test-doc.md'), 'utf-8')).toBe('kept\n');
    expect(readFileSync(join(rig.contentDir, '.ok', 'config.yml'), 'utf-8')).toBe(
      'contentRules:\n  markdownlint:\n    enabled: true\n',
    );
    expect(readFileSync(join(rig.contentDir, '.okignore'), 'utf-8')).toBe('kept-by-caller/\n');
  });

  test.each([
    ['docName', 'docName=seeded'],
    ['reset-okignore', 'reset-okignore=false'],
  ])(
    'a presence-scope reset naming %s is refused before anything is reset',
    async (parameter, query) => {
      const rig = presenceResetRig();

      const captured = await postTestReset(rig.group, `?scope=presence&${query}`);

      expect(captured.status).toBe(400);
      expect(JSON.parse(captured.body)).toMatchObject({
        type: 'urn:ok:error:invalid-request',
        title: `${parameter} cannot be combined with scope=presence: a presence-scope reset clears agent presence only.`,
      });
      expect(Object.keys(rig.agentPresence.getPresenceMap()).sort()).toEqual([
        'agent-seeded',
        'claude-1',
      ]);
      expect(rig.closedSessions).toEqual([]);
      expect(rig.closedConnections).toEqual([]);
      expect(rig.unloadedDocuments).toEqual([]);
      expect(readFileSync(join(rig.contentDir, 'test-doc.md'), 'utf-8')).toBe('kept\n');
    },
  );
});
