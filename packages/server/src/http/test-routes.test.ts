import type { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { loggerFactory } from '../logger.ts';
import { createTestRoutes } from './test-routes.ts';

type Deps = Parameters<typeof createTestRoutes>[0];

function buildGroup() {
  const deps = {
    resetDocumentDurability: undefined,
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
  } satisfies Deps;
  return createTestRoutes(deps);
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
