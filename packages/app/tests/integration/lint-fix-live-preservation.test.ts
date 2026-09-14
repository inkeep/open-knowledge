import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentUndoSuccessSchema,
  LINT_PLUGINS,
  LintFixResultSchema,
  PrincipalSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  __formatContributorsForTests,
  __resetContributorsForTests,
} from '../../../server/src/contributor-tracker.ts';
import { writeTracker } from '../../../server/src/file-watcher.ts';
import { contentHash } from '../../../server/src/version-hash.ts';
import {
  agentWriteMd,
  assertAllConverged,
  assertBridgeInvariant,
  awaitConvergedServerText,
  createTestClients,
  createTestServer,
  getServerState,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const TABBED_BODY = '# Doc\n\n\tindented with a hard tab\n';

interface ContributorPayload {
  id: string;
  docs: string[];
  summaries?: string[];
}

let server: TestServer | undefined;
let clients: TestClient[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OK_TEST_STORE_DIVERGENCE;
  delete process.env.OK_TEST_STORE_FAULT;
  await Promise.all(clients.map((client) => client.cleanup()));
  clients = [];
  await server?.cleanup();
  server = undefined;
  __resetContributorsForTests();
});

function postFix(body: Record<string, unknown>): Promise<Response> {
  if (!server) throw new Error('Test server is not running');
  return fetch(`${server.baseUrl}/api/lint/fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function contributors(): ContributorPayload[] {
  return __formatContributorsForTests()
    .split('\n')
    .filter((line) => line.startsWith('ok-contributors: '))
    .map((line) => JSON.parse(line.slice('ok-contributors: '.length)) as ContributorPayload);
}

function markdownlintPlugin() {
  const plugin = LINT_PLUGINS.find((candidate) => candidate.id === 'markdownlint');
  if (!plugin) throw new Error('markdownlint plugin missing');
  return plugin;
}

describe('lint fix live-write preservation', () => {
  test('fixes live source through the frozen session origin and converges peers, fragment and disk', async () => {
    server = await createTestServer({
      markdownlintEnabled: true,
      debounce: 300_000,
      maxDebounce: 600_000,
    });
    const docName = `lint-live-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, TABBED_BODY, 'utf-8');
    clients = await createTestClients(server.port, { count: 2, docName });
    const writer = clients[0];
    if (!writer) throw new Error('Expected a writer client');
    for (const client of clients) {
      await pollUntil(() => client.ytext.toString() === TABBED_BODY);
    }

    const session = await server.instance.sessionManager.getSession(docName, 'agent-lint-live', {
      displayName: 'Codex Live',
      colorSeed: 'lint-live',
      clientName: 'codex',
    });
    const origins: unknown[] = [];
    const observeOrigin = (event: { transaction: { origin: unknown } }): void => {
      origins.push(event.transaction.origin);
    };
    session.dc.document.getText('source').observe(observeOrigin);

    try {
      writer.doc.transact(() => {
        writer.ytext.insert(writer.ytext.length, '\nLive peer edit.\n');
      });
      await pollUntil(() =>
        getServerState(server as TestServer, docName)
          ?.ytext.toString()
          .includes('Live peer edit'),
      );
      await assertAllConverged(clients);
      expect(readFileSync(file, 'utf-8')).toBe(TABBED_BODY);

      __resetContributorsForTests();
      const response = await postFix({
        docName,
        agentId: 'lint-live',
        agentName: 'Codex Live',
        clientName: 'codex',
        summary: '  Fix the live source  ',
      });
      expect(response.status).toBe(200);
      const result = LintFixResultSchema.parse(await response.json());
      expect(result.fixedCount).toBeGreaterThanOrEqual(1);

      const settled = await awaitConvergedServerText(server, writer);
      await assertAllConverged(clients);
      const state = getServerState(server, docName);
      if (state === null) throw new Error('Expected a loaded server document');
      expect(settled).toBe(state.ytext.toString());
      expect(settled).toContain('Live peer edit.');
      expect(settled).not.toContain('\t');
      expect(readFileSync(file, 'utf-8')).toBe(settled);
      assertBridgeInvariant(state.ytext, state.fragment);
      expect(origins).toContain(session.origin);
      expect(Object.isFrozen(session.origin)).toBe(true);
      expect(Object.isFrozen(session.origin.context)).toBe(true);
      expect(session.origin.context).toMatchObject({
        origin: 'agent-write',
        paired: true,
        session_id: 'lint-live',
        agent_type: 'codex',
      });

      const contributors = __formatContributorsForTests();
      expect(contributors).toContain('"id":"agent-lint-live"');
      expect(contributors).toContain('"summaries":["  Fix the live source  "]');
      expect(
        server.instance.agentPresenceBroadcaster.getPresenceMap()['agent-lint-live'],
      ).toMatchObject({ currentDoc: docName, mode: 'idle' });

      const undoResponse = await fetch(`${server.baseUrl}/api/agent-undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          connectionId: 'agent-lint-live',
          agentId: 'lint-live',
          agentName: 'Codex Live',
          clientName: 'codex',
          scope: 'last',
        }),
      });
      expect(undoResponse.status).toBe(200);
      expect(AgentUndoSuccessSchema.parse(await undoResponse.json())).toMatchObject({
        docName,
        scope: 'last',
        undone: true,
      });
      const undone = await awaitConvergedServerText(server, writer);
      await assertAllConverged(clients);
      expect(undone).toContain('\tindented with a hard tab');
      expect(undone).toContain('Live peer edit.');
      expect(readFileSync(file, 'utf-8')).toBe(undone);
    } finally {
      session.dc.document.getText('source').unobserve(observeOrigin);
    }
  });

  test('records the current two-identity attribution split for a principal', async () => {
    server = await createTestServer({ markdownlintEnabled: true });
    const docName = `lint-principal-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, TABBED_BODY, 'utf-8');

    const principalResponse = await fetch(`${server.baseUrl}/api/principal`);
    expect(principalResponse.status).toBe(200);
    const principal = PrincipalSuccessSchema.parse(await principalResponse.json());
    __resetContributorsForTests();

    const response = await postFix({
      docName,
      principalId: 'principal-forged',
      summary: 'Principal lint fix',
    });
    expect(response.status).toBe(200);
    expect(LintFixResultSchema.parse(await response.json()).fixedCount).toBeGreaterThanOrEqual(1);
    expect(readFileSync(file, 'utf-8')).not.toContain('\t');

    expect(contributors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: principal.id,
          docs: [docName],
          summaries: ['Principal lint fix'],
        }),
        expect.objectContaining({ id: `agent-${principal.id}`, docs: [docName] }),
      ]),
    );
    expect(__formatContributorsForTests()).not.toContain('principal-forged');

    const session = server.instance.sessionManager.getLiveSession(docName, principal.id);
    if (!session) throw new Error('Expected the principal lint session');
    expect(session.origin.context.session_id).toBe(principal.id);
    expect(session.um.trackedOrigins.has(session.origin)).toBe(true);
    expect(session.um.undoStack.length).toBeGreaterThan(0);
    expect(server.instance.agentPresenceBroadcaster.getPresenceMap()[principal.id]).toBeUndefined();
  });

  test('records the current anonymous direct and persistence attribution split', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lint-anonymous-')));
    mkdirSync(join(root, '.ok', 'local', 'principal.json'), { recursive: true });
    writeFileSync(
      join(root, '.ok', 'config.yml'),
      'contentRules:\n  markdownlint:\n    enabled: true\n',
      'utf-8',
    );
    const docName = `lint-anonymous-${randomUUID()}`;
    const file = join(root, `${docName}.md`);
    writeFileSync(file, TABBED_BODY, 'utf-8');
    server = await createTestServer({ contentDir: root, projectDir: root });
    __resetContributorsForTests();

    const response = await postFix({ docName, principalId: 'principal-forged' });
    expect(response.status).toBe(200);
    expect(LintFixResultSchema.parse(await response.json()).fixedCount).toBeGreaterThanOrEqual(1);
    expect(readFileSync(file, 'utf-8')).not.toContain('\t');

    expect(contributors()).toEqual([
      expect.objectContaining({ id: 'agent-principal-anonymous', docs: [docName] }),
    ]);
    const session = server.instance.sessionManager.getLiveSession(docName, 'principal-anonymous');
    if (!session) throw new Error('Expected the anonymous lint session');
    expect(session.origin.context.session_id).toBe('principal-anonymous');
    expect(session.um.trackedOrigins.has(session.origin)).toBe(true);
    expect(session.um.undoStack.length).toBeGreaterThan(0);
    expect(
      server.instance.agentPresenceBroadcaster.getPresenceMap()['principal-anonymous'],
    ).toBeUndefined();
  });

  test('a no-op performs one lint pass without a write, contributor, presence or disk flush', async () => {
    server = await createTestServer({ markdownlintEnabled: true });
    const docName = `lint-noop-${randomUUID()}`;
    const clean = '# Clean\n\nNo problems here.\n';
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, clean, 'utf-8');
    const session = await server.instance.sessionManager.getSession(docName, 'agent-lint-noop', {
      displayName: 'Noop Agent',
      colorSeed: 'lint-noop',
      clientName: 'codex',
    });
    const origins: unknown[] = [];
    const observeOrigin = (event: { transaction: { origin: unknown } }): void => {
      origins.push(event.transaction.origin);
    };
    session.dc.document.getText('source').observe(observeOrigin);
    const lint = vi.spyOn(markdownlintPlugin(), 'lint');
    process.env.OK_TEST_STORE_FAULT = docName;
    __resetContributorsForTests();

    try {
      const response = await postFix({
        docName,
        agentId: 'lint-noop',
        agentName: 'Noop Agent',
        clientName: 'codex',
        summary: 'Should not be recorded',
      });
      expect(response.status).toBe(200);
      const result = LintFixResultSchema.parse(await response.json());
      expect(result.fixedCount).toBe(0);
      expect(lint).toHaveBeenCalledTimes(1);
      expect(origins).not.toContain(session.origin);
      expect(readFileSync(file, 'utf-8')).toBe(clean);
      expect(contributors()).toEqual([]);
      expect(
        server.instance.agentPresenceBroadcaster.getPresenceMap()['agent-lint-noop'],
      ).toBeUndefined();
    } finally {
      session.dc.document.getText('source').unobserve(observeOrigin);
    }
  });

  test('a failed disk flush retains the session-origin edit and direct contribution but reports 507', async () => {
    server = await createTestServer({ markdownlintEnabled: true });
    const docName = `lint-storage-fault-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, TABBED_BODY, 'utf-8');
    const session = await server.instance.sessionManager.getSession(docName, 'agent-lint-fault', {
      displayName: 'Fault Agent',
      colorSeed: 'lint-fault',
      clientName: 'codex',
    });
    const origins: unknown[] = [];
    const observeOrigin = (event: { transaction: { origin: unknown } }): void => {
      origins.push(event.transaction.origin);
    };
    session.dc.document.getText('source').observe(observeOrigin);
    const lint = vi.spyOn(markdownlintPlugin(), 'lint');
    process.env.OK_TEST_STORE_FAULT = docName;
    __resetContributorsForTests();

    try {
      const response = await postFix({
        docName,
        agentId: 'lint-fault',
        agentName: 'Fault Agent',
        clientName: 'codex',
        summary: 'Failed durability',
      });
      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({ type: 'urn:ok:error:storage-full' });
      expect(session.dc.document.getText('source').toString()).not.toContain('\t');
      expect(readFileSync(file, 'utf-8')).toBe(TABBED_BODY);
      expect(origins).toContain(session.origin);
      expect(lint).toHaveBeenCalledTimes(1);
      expect(contributors()).toEqual([
        expect.objectContaining({
          id: 'agent-lint-fault',
          docs: [docName],
          summaries: ['Failed durability'],
        }),
      ]);
      expect(
        server.instance.agentPresenceBroadcaster.getPresenceMap()['agent-lint-fault'],
      ).toMatchObject({ currentDoc: docName, mode: 'idle' });
    } finally {
      session.dc.document.getText('source').unobserve(observeOrigin);
    }
  });

  test.each([
    {
      name: 'disjoint append',
      marker: 'Peer disjoint append.',
      apply: (client: TestClient) => {
        client.ytext.insert(client.ytext.length, '\nPeer disjoint append.\n');
      },
    },
    {
      name: 'overlapping line edit',
      marker: 'peer overlapping wording',
      apply: (client: TestClient) => {
        const start = client.ytext.toString().indexOf('indented with a hard tab');
        client.ytext.delete(start, 'indented with a hard tab'.length);
        client.ytext.insert(start, 'peer overlapping wording');
      },
    },
  ])(
    'retains the baseline snapshot outcome for a $name during the lint barrier',
    async (scenario) => {
      server = await createTestServer({
        markdownlintEnabled: true,
        debounce: 300_000,
        maxDebounce: 600_000,
      });
      const docName = `lint-peer-${randomUUID()}`;
      const file = join(server.contentDir, `${docName}.md`);
      writeFileSync(file, TABBED_BODY, 'utf-8');
      clients = await createTestClients(server.port, {
        count: 2,
        docName,
        perClientOptions: { syncControl: true },
      });
      const writer = clients[0];
      if (!writer) throw new Error('Expected a writer client');
      for (const client of clients) {
        await pollUntil(() => client.ytext.toString() === TABBED_BODY);
      }

      const plugin = markdownlintPlugin();
      const originalLint = plugin.lint;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      vi.spyOn(plugin, 'lint').mockImplementation(async (text, slice, context) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await release.promise;
        }
        return originalLint.call(plugin, text, slice, context);
      });

      writer.pauseSync();
      try {
        const request = postFix({ docName, agentId: 'lint-peer', clientName: 'codex' });
        await started.promise;
        writer.doc.transact(() => scenario.apply(writer));
        await pollUntil(() =>
          Boolean(
            getServerState(server as TestServer, docName)
              ?.ytext.toString()
              .includes(scenario.marker),
          ),
        );
        release.resolve();

        const response = await request;
        expect(response.status).toBe(200);
        expect(LintFixResultSchema.parse(await response.json()).fixedCount).toBeGreaterThanOrEqual(
          1,
        );
        writer.resumeSync();
        await assertAllConverged(clients, { timeout: 5_000 });
        const settled = await awaitConvergedServerText(server, writer);
        expect(settled).not.toContain('\t');
        expect(settled).not.toContain(scenario.marker);
        expect(settled).toContain('indented with a hard tab');
        expect(readFileSync(file, 'utf-8')).toBe(settled);
      } finally {
        release.resolve();
        writer.resumeSync();
      }
    },
  );

  test('a disk divergence returns 409 and realigns the live document to the injected disk state', async () => {
    server = await createTestServer({ markdownlintEnabled: true });
    const docName = `lint-divergence-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, TABBED_BODY, 'utf-8');
    process.env.OK_TEST_STORE_DIVERGENCE = docName;
    __resetContributorsForTests();

    const response = await postFix({
      docName,
      agentId: 'lint-divergence',
      agentName: 'Divergence Agent',
      summary: 'Divergent durability',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ type: 'urn:ok:error:disk-divergence' });

    await pollUntil(() => readFileSync(file, 'utf-8').includes('native-divergence-injected'));
    await pollUntil(() =>
      Boolean(
        getServerState(server as TestServer, docName)
          ?.ytext.toString()
          .includes('native-divergence-injected'),
      ),
    );
    const state = getServerState(server, docName);
    if (state === null) throw new Error('Expected a realigned server document');
    expect(state.ytext.toString()).toBe(readFileSync(file, 'utf-8'));
    expect(state.ytext.toString()).toBe('# NATIVE\n\nnative-divergence-injected\n');
    expect(contributors()).toEqual([
      expect.objectContaining({
        id: 'agent-lint-divergence',
        docs: [docName],
        summaries: ['Divergent durability'],
      }),
    ]);
    expect(
      server.instance.agentPresenceBroadcaster.getPresenceMap()['agent-lint-divergence'],
    ).toMatchObject({ currentDoc: docName, mode: 'idle' });
  });

  test('a stale external write returns 409 while retaining the fixed live source for recovery', async () => {
    server = await createTestServer({
      markdownlintEnabled: true,
      debounce: 50,
      maxDebounce: 200,
    });
    const docName = `lint-stale-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, TABBED_BODY, 'utf-8');
    const stale = readFileSync(file, 'utf-8');
    await agentWriteMd(server.port, 'Acknowledged before lint.\n', {
      docName,
      position: 'append',
      agentId: 'seed-lint-stale',
    });
    await pollUntil(() => readFileSync(file, 'utf-8').includes('Acknowledged before lint.'));
    await pollUntil(
      () => !writeTracker.get(file)?.some((entry) => entry.hash === contentHash(stale)),
    );
    const state = getServerState(server, docName);
    if (state === null) throw new Error('Expected a loaded stale-write document');
    const restoreStale = (): void => {
      if (state.ytext.toString().includes('\t')) return;
      state.ytext.unobserve(restoreStale);
      writeFileSync(file, stale, 'utf-8');
    };
    state.ytext.observe(restoreStale);
    __resetContributorsForTests();

    try {
      const response = await postFix({
        docName,
        agentId: 'lint-stale',
        agentName: 'Stale Agent',
        summary: 'Retain stale-race fix',
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ type: 'urn:ok:error:stale-external-write' });
      expect(readFileSync(file, 'utf-8')).toBe(stale);
      expect(state.ytext.toString()).not.toContain('\t');
      expect(state.ytext.toString()).toContain('Acknowledged before lint.');
      expect(server.instance.durabilityState.getStaleExternalWrite(docName)?.retainedContent).toBe(
        state.ytext.toString(),
      );
      expect(
        readFileSync(join(server.instance.lockDir, 'stale-external-writes.json'), 'utf-8'),
      ).toContain('Acknowledged before lint.');
      expect(contributors()).toEqual([
        expect.objectContaining({
          id: 'agent-lint-stale',
          docs: [docName],
          summaries: ['Retain stale-race fix'],
        }),
      ]);
      expect(
        server.instance.agentPresenceBroadcaster.getPresenceMap()['agent-lint-stale'],
      ).toMatchObject({ currentDoc: docName, mode: 'idle' });
    } finally {
      state.ytext.unobserve(restoreStale);
    }
  });

  test.each([
    { name: 'missing document', body: {}, type: 'urn:ok:error:invalid-request' },
    { name: 'empty document', body: { docName: '' }, type: 'urn:ok:error:invalid-request' },
    {
      name: 'system document',
      body: { docName: '__system__' },
      type: 'urn:ok:error:reserved-doc-name',
    },
    {
      name: 'config document',
      body: { docName: '__config__/project' },
      type: 'urn:ok:error:reserved-doc-name',
    },
    {
      name: 'unknown document',
      body: { docName: `missing-${randomUUID()}` },
      type: 'urn:ok:error:doc-not-found',
    },
  ])('retains the ordered 400 or 404 problem for a $name', async ({ body, type }) => {
    server = await createTestServer({ markdownlintEnabled: true });
    const response = await postFix(body);
    expect(response.status).toBe(type === 'urn:ok:error:doc-not-found' ? 404 : 400);
    expect(await response.json()).toMatchObject({ type });
    expect(contributors()).toEqual([]);
  });

  test('an active conflict refuses the fix before it mutates source, disk or attribution', async () => {
    server = await createTestServer({ markdownlintEnabled: true });
    const docName = `lint-conflict-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, TABBED_BODY, 'utf-8');
    const session = await server.instance.sessionManager.getSession(
      docName,
      'agent-lint-conflict',
      {
        displayName: 'Conflict Agent',
        colorSeed: 'lint-conflict',
        clientName: 'codex',
      },
    );
    session.dc.document.getMap('lifecycle').set('status', 'conflict');
    __resetContributorsForTests();

    const response = await postFix({
      docName,
      agentId: 'lint-conflict',
      agentName: 'Conflict Agent',
      clientName: 'codex',
      summary: 'Must not land',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ type: 'urn:ok:error:doc-in-conflict' });
    expect(session.dc.document.getText('source').toString()).toBe(TABBED_BODY);
    expect(readFileSync(file, 'utf-8')).toBe(TABBED_BODY);
    expect(contributors()).toEqual([]);
    expect(
      server.instance.agentPresenceBroadcaster.getPresenceMap()['agent-lint-conflict'],
    ).toMatchObject({ currentDoc: docName, mode: 'idle' });
  });

  test('a malformed snapshot frontmatter refuses the patch when live frontmatter changes mid-fix', async () => {
    server = await createTestServer({
      markdownlintEnabled: true,
      debounce: 300_000,
      maxDebounce: 600_000,
    });
    const docName = `lint-malformed-${randomUUID()}`;
    const malformed = `---\ntitle: [unterminated\n---\n\n${TABBED_BODY}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, malformed, 'utf-8');
    clients = await createTestClients(server.port, { count: 1, docName });
    const writer = clients[0];
    if (!writer) throw new Error('Expected a writer client');
    await pollUntil(() => writer.ytext.toString() === malformed);

    const plugin = markdownlintPlugin();
    const originalLint = plugin.lint;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    vi.spyOn(plugin, 'lint').mockImplementation(async (text, slice, context) => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return originalLint.call(plugin, text, slice, context);
    });
    __resetContributorsForTests();

    try {
      const request = postFix({
        docName,
        agentId: 'lint-malformed',
        clientName: 'codex',
        summary: 'Must refuse malformed frontmatter',
      });
      await started.promise;
      const start = writer.ytext.toString().indexOf('[unterminated');
      writer.doc.transact(() => {
        writer.ytext.delete(start, '[unterminated'.length);
        writer.ytext.insert(start, 'Valid now');
      });
      await pollUntil(() =>
        Boolean(
          getServerState(server as TestServer, docName)
            ?.ytext.toString()
            .includes('Valid now'),
        ),
      );
      release.resolve();

      const response = await request;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ type: 'urn:ok:error:frontmatter-malformed' });
      const state = getServerState(server, docName);
      if (state === null) throw new Error('Expected the live malformed-frontmatter document');
      expect(state.ytext.toString()).toContain('title: Valid now');
      expect(state.ytext.toString()).toContain('\t');
      expect(readFileSync(file, 'utf-8')).toBe(malformed);
      expect(contributors()).toEqual([]);
      expect(
        server.instance.agentPresenceBroadcaster.getPresenceMap()['agent-lint-malformed'],
      ).toMatchObject({ currentDoc: docName, mode: 'idle' });
    } finally {
      release.resolve();
    }
  });

  test('an indexed in-root alias fixes the canonical document and reports its canonical path', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lint-alias-')));
    mkdirSync(join(root, '.ok'), { recursive: true });
    writeFileSync(
      join(root, '.ok', 'config.yml'),
      'contentRules:\n  markdownlint:\n    enabled: true\n',
      'utf-8',
    );
    const canonicalName = `lint-canonical-${randomUUID()}`;
    const aliasName = `lint-alias-${randomUUID()}`;
    const canonicalFile = join(root, `${canonicalName}.md`);
    writeFileSync(canonicalFile, TABBED_BODY, 'utf-8');
    symlinkSync(canonicalFile, join(root, `${aliasName}.md`));
    server = await createTestServer({ contentDir: root, projectDir: root });

    const response = await postFix({ docName: aliasName, agentId: 'lint-alias' });
    expect(response.status).toBe(200);
    const result = LintFixResultSchema.parse(await response.json());
    expect(result.file).toBe(`${canonicalName}.md`);
    expect(result.fixedCount).toBeGreaterThanOrEqual(1);
    expect(readFileSync(canonicalFile, 'utf-8')).not.toContain('\t');
  });
});
