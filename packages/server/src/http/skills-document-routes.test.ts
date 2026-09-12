import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { AgentSessionManager } from '../agent-sessions.ts';
import { loggerFactory } from '../logger.ts';
import { createSkillsDocumentRoutes } from './skills-document-routes.ts';

function buildGroup() {
  return createSkillsDocumentRoutes({
    validateSkillName: () => true,
    parseSkillScope: () => 'project',
    skillsHome: '/nonexistent-skills-home',
    projectDir: undefined,
    resolveBuiltinSkillDir: () => null,
    resolveSkillDirForRead: () => null,
    derivedDocumentIndex: undefined,
    getPrincipal: undefined,
    rejectReservedBuiltinSkill: () => false,
    contentDir: '/nonexistent-content',
    attributeOkArtifactWrite: () => {},
    signalChannel: undefined,
    checkSkillDocConflictGate: () => false,
    extractAgentIdentity: () => ({
      rawAgentId: undefined,
      agentId: 'test',
      agentName: 'test',
      colorSeed: 'test',
      clientName: undefined,
      clientVersion: undefined,
      label: undefined,
    }),
    sessionManager: new AgentSessionManager(new Hocuspocus({ quiet: true })),
    flushDiskAndDetectOutcome: () => Promise.resolve(null),
    respondStaleExternalWrite: () => {},
    respondPersistenceFailure: () => {},
    respondDiskDivergence: () => {},
    okArtifactKey: () => '',
    resolveSkillsRoot: () => '/nonexistent-skills',
    extractActorIdentityFromQuery: () => ({ kind: 'invalid-summary' }),
    captureAndCloseDocuments: () => Promise.resolve(new Map()),
    log: loggerFactory.getLogger('test'),
    commitOkArtifactWrite: () => Promise.resolve(),
    parseFrontmatterDoc: () => ({ frontmatter: {}, body: '' }),
    skillRelPath: (path) => path,
    contentFilter: undefined,
    bumpSkillsCatalogGen: () => {},
    scheduleDeferredIgnoreRebuild: () => {},
    recordDerivedDocumentBestEffort: () => Promise.resolve(),
    scheduleOkArtifactFlush: () => {},
    skillInstallBase: () => undefined,
    uninstallSkillFromHostDirs: () => Promise.resolve(false),
    renameTrackedPathInGit: () => Promise.resolve(false),
    renamePathOnDisk: () => {},
    localSkillHash: () => undefined,
    shadowHeadSha: () => Promise.resolve(undefined),
    artifactWriterId: () => undefined,
    checkLocalOpSecurity: () => true,
    effectiveSkillRoot: () => ({ root: '/nonexistent-skills', dirRel: '', realDir: null }),
  });
}

describe('createSkillsDocumentRoutes table', () => {
  test('registers exactly the four skill-document paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/skill',
        '/api/skill/edit-external',
        '/api/skill/duplicate',
        '/api/skill/move-scope',
      ].sort(),
    );
  });

  test('every skill-document path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of [
      '/api/skill',
      '/api/skill/edit-external',
      '/api/skill/duplicate',
      '/api/skill/move-scope',
    ]) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
