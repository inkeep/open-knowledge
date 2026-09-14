import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, describe, expect, test } from 'vitest';
import { AgentSessionManager } from '../agent-sessions.ts';
import { makeCaptureRes } from '../composition-rig.test-helper.ts';
import { loggerFactory } from '../logger.ts';
import { createLintWriteRoutes } from './lint-write-routes.ts';

type Deps = Parameters<typeof createLintWriteRoutes>[0];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function notDispatched(): never {
  throw new Error('Dependency is not used by this test');
}

function buildGroup(overrides: Partial<Deps> = {}) {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-lint-write-routes-'));
  roots.push(contentDir);
  const hocuspocus = new Hocuspocus({ quiet: true });
  const deps = {
    contentDir,
    projectDir: undefined,
    signalLintConfigChanged: notDispatched,
    getLinterBaseConfig: undefined,
    unmatchedGlobProblems: () => [],
    signalChannel: undefined,
    requireNonEmptyDocName: notDispatched,
    resolveAlias: (docName) => docName,
    getPrincipal: undefined,
    resolveDocFilePath: notDispatched,
    summaryResponseFields: () => ({ stored: undefined }),
    sessionManager: new AgentSessionManager(hocuspocus),
    options: {},
    agentPresenceBroadcaster: undefined,
    buildAgentActor: notDispatched,
    flushDiskAndDetectOutcome: notDispatched,
    respondPersistenceFailure: notDispatched,
    respondDiskDivergence: notDispatched,
    respondStaleExternalWrite: notDispatched,
    flushDocToDisk: notDispatched,
    log: loggerFactory.getLogger('test'),
    ...overrides,
  } satisfies Deps;
  return { contentDir, group: createLintWriteRoutes(deps), sessionManager: deps.sessionManager };
}

function makeReq(path: string, body: unknown): IncomingMessage {
  const req = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  req.method = 'POST';
  req.url = path;
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

async function dispatch(
  group: ReturnType<typeof createLintWriteRoutes>,
  path: string,
  body: unknown,
) {
  const route = group.table.resolve(path);
  if (!route?.dispatch) throw new Error(`${path} did not resolve to a dispatch handler`);
  const { res, captured } = makeCaptureRes();
  await route.dispatch(makeReq(path, body), res);
  return captured;
}

const PATHS = ['/api/lint/markdownlint-config', '/api/lint/frontmatter-schema', '/api/lint/fix'];

describe('createLintWriteRoutes table', () => {
  test('registers exactly the three lint write paths and classifies all three as mutating', async () => {
    const { group, sessionManager } = buildGroup();
    try {
      expect([...group.paths].sort()).toEqual([...PATHS].sort());
      for (const path of PATHS) expect(group.table.isMutating(path), path).toBe(true);
    } finally {
      await sessionManager.closeAll();
    }
  });
});

describe('createLintWriteRoutes config handlers', () => {
  test('persists a markdownlint rule before invalidating the shared config generation', async () => {
    const signals: string[] = [];
    const { contentDir, group, sessionManager } = buildGroup({
      signalLintConfigChanged: () => signals.push('lint-config'),
    });
    try {
      const response = await dispatch(group, '/api/lint/markdownlint-config', {
        ruleId: 'MD012',
        value: false,
      });
      expect(response.status).toBe(200);
      expect(readFileSync(join(contentDir, '.markdownlint.json'), 'utf8')).toContain(
        '"MD012": false',
      );
      expect(signals).toEqual(['lint-config']);
    } finally {
      await sessionManager.closeAll();
    }
  });

  test('creates a frontmatter schema and schedules files before lint invalidation', async () => {
    const signals: string[] = [];
    const { contentDir, group, sessionManager } = buildGroup({
      signalChannel: (channel) => signals.push(channel),
      signalLintConfigChanged: () => signals.push('lint-config'),
    });
    try {
      const response = await dispatch(group, '/api/lint/frontmatter-schema', {
        file: '.ok/schemas/native.schema.json',
      });
      expect(response.status).toBe(200);
      expect(
        JSON.parse(readFileSync(join(contentDir, '.ok/schemas/native.schema.json'), 'utf8')),
      ).toEqual({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' });
      expect(signals).toEqual(['files', 'lint-config']);
    } finally {
      await sessionManager.closeAll();
    }
  });

  test('rejects __proto__ schema fields with a caller-facing validation detail', async () => {
    const { group, sessionManager } = buildGroup();
    try {
      const response = await dispatch(group, '/api/lint/frontmatter-schema', {
        file: '.ok/schemas/native.schema.json',
        field: '__proto__',
        constraint: { type: 'string' },
      });
      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(JSON.parse(response.body)).toMatchObject({
        type: 'urn:ok:error:invalid-request',
        detail: 'field: schema property name cannot be __proto__',
      });
    } finally {
      await sessionManager.closeAll();
    }
  });
});

describe('createLintWriteRoutes lint-fix capacity response', () => {
  test('returns the retryable problem when the session limit is full', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus, {
      maxSessions: 1,
      minEvictableIdleMs: Number.POSITIVE_INFINITY,
    });
    try {
      await sessionManager.getSession('occupied', 'agent-occupant');
      const { contentDir, group } = buildGroup({
        sessionManager,
        requireNonEmptyDocName: (docName) => docName ?? null,
        resolveDocFilePath: () => 'note.md',
      });
      writeFileSync(join(contentDir, 'note.md'), '# Heading  \n');
      const response = await dispatch(group, '/api/lint/fix', { docName: 'note' });
      expect(response.status).toBe(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['retry-after']).toBe('10');
      expect(JSON.parse(response.body)).toMatchObject({
        status: 503,
        type: 'urn:ok:error:too-many-agent-sessions',
      });
    } finally {
      await sessionManager.closeAll();
    }
  });
});
