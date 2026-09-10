import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { AgentSessionManager } from '../agent-sessions.ts';
import { makeCaptureRes } from '../composition-rig.test-helper.ts';
import type { DocumentDurabilityState } from '../document-durability-state.ts';
import { loggerFactory } from '../logger.ts';
import { createAgentWriteRoutes } from './agent-write-routes.ts';

type Deps = Parameters<typeof createAgentWriteRoutes>[0];

function notDispatched(): never {
  throw new Error('Dependency is not used by this test');
}

function buildGroup(overrides: Partial<Deps> = {}) {
  const deps = {
    getLinkAdvisoryPolicy: () => ({ links: 'warning', suppressLogLinkAdvisories: false }),
    respondStaleExternalWrite: notDispatched,
    requireNonEmptyDocName: (docName) => docName ?? null,
    resolveAlias: (docName) => docName,
    extractAgentIdentity: () => ({
      rawAgentId: 'writer',
      agentId: 'agent-writer',
      agentName: 'Writer',
      colorSeed: 'writer',
      clientName: undefined,
      clientVersion: undefined,
      label: undefined,
    }),
    docNameExistsWithAnySupportedExtension: notDispatched,
    contentDir: '/nonexistent-content',
    summaryResponseFields: () => ({ stored: undefined }),
    sessionManager: {} as AgentSessionManager,
    durabilityState: {} as DocumentDurabilityState,
    hocuspocus: {} as Hocuspocus,
    options: {},
    getBridgeLossReporter: undefined,
    agentPresenceBroadcaster: undefined,
    recordContentDivergenceGate: notDispatched,
    buildAgentActor: notDispatched,
    countNormalizedSummary: notDispatched,
    flushDiskAndDetectOutcome: notDispatched,
    respondPersistenceFailure: notDispatched,
    respondDiskDivergence: notDispatched,
    flushDocToDisk: notDispatched,
    agentFocusBroadcaster: undefined,
    onAgentWrite: undefined,
    computeOrphanHints: notDispatched,
    registerWrittenDocInFileIndex: notDispatched,
    collectAdmittedDocNames: notDispatched,
    createLinkedFileExists: notDispatched,
    createLinkedFolderExists: notDispatched,
    buildReconcileWarning: notDispatched,
    computeLintViolations: notDispatched,
    log: loggerFactory.getLogger('test'),
    flushDocToGit: notDispatched,
    isSafeDocName: notDispatched,
    shadowRef: undefined,
    getPrincipal: undefined,
    contentRoot: undefined,
    safeDocPath: notDispatched,
    getCurrentBranch: undefined,
    docTreePathCandidates: notDispatched,
    stripDefaultPathTruncation: notDispatched,
    renameAttributionCounter: notDispatched,
    ...overrides,
  } satisfies Deps;
  return createAgentWriteRoutes(deps);
}

const WRITES = [
  '/api/agent-write-md',
  '/api/frontmatter-patch',
  '/api/agent-patch',
  '/api/agent-undo',
  '/api/save-version',
  '/api/rollback',
];
const READS = ['/api/agent-activity', '/api/agent-burst-diff'];

describe('createAgentWriteRoutes table', () => {
  test('registers exactly the eight agent-write paths', () => {
    expect([...buildGroup().paths].sort()).toEqual([...WRITES, ...READS].sort());
  });

  test('classifies the six writes as mutating and the two reads as non-mutating', () => {
    const { table } = buildGroup();
    for (const path of WRITES) expect(table.isMutating(path), path).toBe(true);
    for (const path of READS) expect(table.isMutating(path), path).toBe(false);
  });
});

function makeReq(url: string, body: unknown): IncomingMessage {
  const req = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  req.method = 'POST';
  req.url = url;
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

describe('agent-write session capacity responses', () => {
  test.each([
    ['/api/agent-write-md', { docName: 'note', markdown: '# Note', position: 'replace' }],
    ['/api/frontmatter-patch', { docName: 'note', patch: { title: 'Note' } }],
    ['/api/agent-patch', { docName: 'note', find: 'old', replace: 'new' }],
  ])('%s returns the retryable problem when the session limit is full', async (path, body) => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus, {
      maxSessions: 1,
      minEvictableIdleMs: Number.POSITIVE_INFINITY,
    });
    try {
      await sessionManager.getSession('occupied', 'agent-occupant');
      const group = buildGroup({ hocuspocus, sessionManager });
      const route = group.table.resolve(path);
      if (!route?.dispatch) throw new Error(`${path} did not resolve to a dispatch handler`);
      const { res, captured } = makeCaptureRes();
      await route.dispatch(makeReq(path, body), res);
      expect(captured.status).toBe(503);
      expect(captured.headers['content-type']).toContain('application/problem+json');
      expect(captured.headers['retry-after']).toBe('10');
      expect(JSON.parse(captured.body)).toMatchObject({
        status: 503,
        type: 'urn:ok:error:too-many-agent-sessions',
      });
    } finally {
      await sessionManager.closeAll();
    }
  });
});
