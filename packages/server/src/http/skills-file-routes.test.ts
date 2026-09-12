import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { AgentSessionManager } from '../agent-sessions.ts';
import { loggerFactory } from '../logger.ts';
import { createSkillsFileRoutes } from './skills-file-routes.ts';

function buildGroup() {
  return createSkillsFileRoutes({
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
    recordDerivedMutationsBestEffort: () => Promise.resolve(),
  });
}

describe('createSkillsFileRoutes table', () => {
  test('registers exactly the two skill-file paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      ['/api/skill-file', '/api/skill-file/rename'].sort(),
    );
  });

  test('every skill-file path is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of ['/api/skill-file', '/api/skill-file/rename']) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});
