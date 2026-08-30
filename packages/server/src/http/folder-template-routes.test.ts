import type { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { loggerFactory } from '../logger.ts';
import { createFolderTemplateRoutes } from './folder-template-routes.ts';

/**
 * Table-level pins for the folder-template group's mutating declaration. The
 * wire cannot pin this: the read half of the DNS-rebinding defense applies
 * the identical loopback + workspace-Host checks to every `/api/*` request,
 * so an emptied mutating set changes no composition-suite response — only
 * which gate (and telemetry tag) fires first. The declared membership is
 * pinned here directly against the legacy `MUTATING_ROUTES` membership it
 * reproduces — all three paths were members (any-verb-mutates ⇒ every verb,
 * GET arms included).
 */

function buildGroup() {
  return createFolderTemplateRoutes({
    contentDir: '/nonexistent-content',
    projectDir: undefined,
    ephemeral: true,
    log: loggerFactory.getLogger('test'),
    // Never dispatched by these pins; the table declaration is what's under test.
    hocuspocus: {} as Hocuspocus,
    sessionManager: {} as AgentSessionManager,
    getPrincipal: undefined,
    signalChannel: undefined,
    getSyncEngine: undefined,
    recentlyRemovedDocs: undefined,
    isSafeDocName: () => false,
    resolveAlias: (docName) => docName,
    resolveContentEntryPath: () => '/nonexistent-content/none',
    validateFolderRel: () => null,
    extractAgentIdentity: () => ({
      agentId: 'test',
      agentName: 'test',
      colorSeed: 'test',
      clientName: undefined,
    }),
    extractActorIdentityFromQuery: () => ({ kind: 'invalid-summary' as const }),
    okArtifactKey: () => '',
    attributeOkArtifactWrite: () => {},
    scheduleOkArtifactFlush: () => {},
    flushDiskAndDetectOutcome: () => Promise.resolve(null),
    respondPersistenceFailure: () => {},
    respondDiskDivergence: () => {},
    registerWrittenDocInFileIndex: () => {},
    captureAndCloseDocuments: () => Promise.resolve(new Map()),
    renameTrackedPathInGit: () => Promise.resolve(false),
    renamePathOnDisk: () => {},
    splitContentPath: (path) => ({ parent: '', basename: path }),
    mutateFileIndex: undefined,
  });
}

describe('createFolderTemplateRoutes table', () => {
  test('registers exactly the three folder-template paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      ['/api/folder-config', '/api/template', '/api/template/import'].sort(),
    );
  });

  test('every path reproduces its legacy MUTATING_ROUTES membership (all three mutating)', () => {
    const { table } = buildGroup();
    for (const path of ['/api/folder-config', '/api/template', '/api/template/import']) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
