import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  appendProjectionParagraph,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

interface WriteBody {
  docName: string;
  markdown: string;
  position: 'append' | 'prepend' | 'replace';
  agentId?: string;
}

async function setupDoc(server: TestServer, docName: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${docName}.md` }),
  });
  expect(response.status).toBe(200);
}

function write(server: TestServer, body: WriteBody): Promise<Response> {
  return fetch(`${server.baseUrl}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function expectHumanWriteRefused(
  server: TestServer,
  docName: string,
  edit: (client: TestClient) => void,
  agentId: string | undefined = 'agent-after-human',
): Promise<void> {
  await setupDoc(server, docName);
  const client = await createTestClient(server.port, docName);
  try {
    edit(client);
    await pollUntil(() => {
      const document = server.instance.hocuspocus.documents.get(docName);
      return document?.getText('source').toString().includes('Human edit') ?? false;
    });
    const before = server.instance.hocuspocus.documents.get(docName)?.getText('source').toString();
    const response = await write(server, {
      docName,
      markdown: '# Agent replacement\n',
      position: 'replace',
      agentId,
    });
    expect(response.status).toBe(409);
    expect(server.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
      before,
    );
  } finally {
    await client.cleanup();
  }
}

describe('concurrent whole-document replace refusal', () => {
  test('two identified agents cannot replace the same document concurrently', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      const docName = `agent-race-${crypto.randomUUID()}`;
      await setupDoc(server, docName);
      const [first, second] = await Promise.all([
        write(server, {
          docName,
          markdown: '# From A\n\nAlpha.\n',
          position: 'replace',
          agentId: 'agent-a',
        }),
        write(server, {
          docName,
          markdown: '# From B\n\nBeta.\n',
          position: 'replace',
          agentId: 'agent-b',
        }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const refused = first.status === 409 ? first : second;
      const problem = (await refused.json()) as Record<string, unknown>;
      expect(problem.type).toBe('urn:ok:error:concurrent-overwrite-refused');
      expect(problem.title).toBe('Concurrent overwrite refused.');
      expect(problem.status).toBe(409);
      expect(problem.file).toBe(`${docName}.md`);
      expect(problem.retryAfterSeconds).toBe(3);
      expect(refused.headers.get('Retry-After')).toBe('3');
      expect(Object.keys(problem).sort()).toEqual([
        'detail',
        'file',
        'instance',
        'retryAfterSeconds',
        'status',
        'title',
        'type',
      ]);
    } finally {
      await server.cleanup();
    }
  });

  test('an identified agent can replace its own recent write', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      const docName = `same-agent-${crypto.randomUUID()}`;
      await setupDoc(server, docName);
      expect(
        (
          await write(server, {
            docName,
            markdown: '# First\n',
            position: 'replace',
            agentId: 'agent-solo',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await write(server, {
            docName,
            markdown: '# Second\n',
            position: 'replace',
            agentId: 'agent-solo',
          })
        ).status,
      ).toBe(200);
    } finally {
      await server.cleanup();
    }
  });

  test('an identified patch arms the refusal against a different writer', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      const docName = `patch-seed-${crypto.randomUUID()}`;
      await setupDoc(server, docName);
      expect(
        (
          await write(server, {
            docName,
            markdown: '# Patch target\n\nOriginal body.\n',
            position: 'replace',
          })
        ).status,
      ).toBe(200);

      const patch = await fetch(`${server.baseUrl}/api/agent-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          find: 'Original body.',
          replace: 'Patched body.',
          agentId: 'patch-writer',
        }),
      });
      expect(patch.status).toBe(200);

      const before = server.instance.hocuspocus.documents
        .get(docName)
        ?.getText('source')
        .toString();
      const response = await write(server, {
        docName,
        markdown: '# Peer replacement\n\nReplaced.\n',
        position: 'replace',
        agentId: 'peer-writer',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as Record<string, unknown>).type).toBe(
        'urn:ok:error:concurrent-overwrite-refused',
      );
      expect(server.instance.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
        before,
      );
      expect(before).toContain('Patched body.');
    } finally {
      await server.cleanup();
    }
  });

  test('a write that supplies no agentId does not arm the refusal against an identified agent', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      const docName = `unattributed-seed-${crypto.randomUUID()}`;
      await setupDoc(server, docName);
      expect(
        (
          await write(server, {
            docName,
            markdown: '# Unattributed seed\n\nSeeded.\n',
            position: 'replace',
          })
        ).status,
      ).toBe(200);
      const response = await write(server, {
        docName,
        markdown: '# Identified replacement\n\nReplaced.\n',
        position: 'replace',
        agentId: 'agent-after-unattributed',
      });
      expect(response.status).toBe(200);
      expect(
        server.instance.hocuspocus.documents.get(docName)?.getText('source').toString(),
      ).toContain('Identified replacement');
    } finally {
      await server.cleanup();
    }
  });

  test('a write that supplies no agentId is refused against a recent identified agent', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      const docName = `identified-seed-${crypto.randomUUID()}`;
      await setupDoc(server, docName);
      expect(
        (
          await write(server, {
            docName,
            markdown: '# Identified seed\n\nSeeded.\n',
            position: 'replace',
            agentId: 'agent-before-unattributed',
          })
        ).status,
      ).toBe(200);
      const response = await write(server, {
        docName,
        markdown: '# Unattributed replacement\n\nReplaced.\n',
        position: 'replace',
      });
      expect(response.status).toBe(409);
      expect(
        server.instance.hocuspocus.documents.get(docName)?.getText('source').toString(),
      ).toContain('Identified seed');
    } finally {
      await server.cleanup();
    }
  });

  test('two writes that both supply no agentId are not refused against each other', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      const docName = `unattributed-pair-${crypto.randomUUID()}`;
      await setupDoc(server, docName);
      expect(
        (
          await write(server, {
            docName,
            markdown: '# First unattributed\n\nAlpha.\n',
            position: 'replace',
          })
        ).status,
      ).toBe(200);
      const second = await write(server, {
        docName,
        markdown: '# Second unattributed\n\nBeta.\n',
        position: 'replace',
      });
      expect(second.status).toBe(200);
      expect(
        server.instance.hocuspocus.documents.get(docName)?.getText('source').toString(),
      ).toContain('Second unattributed');
    } finally {
      await server.cleanup();
    }
  });

  test('an anonymous lint fix does not arm the refusal against an anonymous replace', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-anonymous-lint-')));
    mkdirSync(join(root, '.ok', 'local', 'principal.json'), { recursive: true });
    writeFileSync(
      join(root, '.ok', 'config.yml'),
      'contentRules:\n  markdownlint:\n    enabled: true\n',
      'utf-8',
    );
    const docName = `anonymous-lint-${crypto.randomUUID()}`;
    writeFileSync(join(root, `${docName}.md`), '# Doc\n\n\tindented with a hard tab\n', 'utf-8');
    const server = await createTestServer({
      contentDir: root,
      projectDir: root,
      debounce: 50,
      maxDebounce: 200,
    });
    try {
      const fix = await fetch(`${server.baseUrl}/api/lint/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName }),
      });
      expect(fix.status).toBe(200);
      expect(((await fix.json()) as { fixedCount: number }).fixedCount).toBeGreaterThanOrEqual(1);
      expect(
        server.instance.sessionManager.getLiveSession(docName, 'principal-anonymous'),
      ).toBeDefined();

      const response = await write(server, {
        docName,
        markdown: '# Anonymous replacement\n\nReplaced.\n',
        position: 'replace',
      });
      expect(response.status).toBe(200);
      expect(
        server.instance.hocuspocus.documents.get(docName)?.getText('source').toString(),
      ).toContain('Anonymous replacement');
    } finally {
      await server.cleanup();
    }
  });

  test('an identified lint fix arms the refusal against an unattributed replace', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-identified-lint-')));
    mkdirSync(join(root, '.ok'), { recursive: true });
    writeFileSync(
      join(root, '.ok', 'config.yml'),
      'contentRules:\n  markdownlint:\n    enabled: true\n',
      'utf-8',
    );
    const docName = `identified-lint-${crypto.randomUUID()}`;
    writeFileSync(join(root, `${docName}.md`), '# Doc\n\n\tindented with a hard tab\n', 'utf-8');
    const server = await createTestServer({
      contentDir: root,
      projectDir: root,
      debounce: 50,
      maxDebounce: 200,
    });
    try {
      const fix = await fetch(`${server.baseUrl}/api/lint/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, agentId: 'lint-writer' }),
      });
      expect(fix.status).toBe(200);
      expect(((await fix.json()) as { fixedCount: number }).fixedCount).toBeGreaterThanOrEqual(1);
      expect(
        server.instance.sessionManager.getLiveSession(docName, 'agent-lint-writer'),
      ).toBeDefined();

      const response = await write(server, {
        docName,
        markdown: '# Identified lint replacement\n\nReplaced.\n',
        position: 'replace',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as Record<string, unknown>).type).toBe(
        'urn:ok:error:concurrent-overwrite-refused',
      );
      expect(
        server.instance.hocuspocus.documents.get(docName)?.getText('source').toString(),
      ).not.toContain('Identified lint replacement');
    } finally {
      await server.cleanup();
    }
  });

  test('a connected client that made no edit does not arm the refusal', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      const docName = `idle-client-${crypto.randomUUID()}`;
      await setupDoc(server, docName);
      const client = await createTestClient(server.port, docName);
      try {
        const response = await write(server, {
          docName,
          markdown: '# Agent seed\n',
          position: 'replace',
          agentId: 'agent-after-idle-connect',
        });
        expect(response.status).toBe(200);
      } finally {
        await client.cleanup();
      }
    } finally {
      await server.cleanup();
    }
  });

  test('recent source and rich-text edits are protected', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      await expectHumanWriteRefused(server, `source-human-${crypto.randomUUID()}`, (client) =>
        client.ytext.insert(client.ytext.length, '\nHuman edit in source.\n'),
      );
      await expectHumanWriteRefused(server, `wysiwyg-human-${crypto.randomUUID()}`, (client) =>
        appendProjectionParagraph(client, 'Human edit in rich text.'),
      );
    } finally {
      await server.cleanup();
    }
  });

  test('a write that supplies no agentId is still refused by a recent editor change', async () => {
    const server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    try {
      await expectHumanWriteRefused(
        server,
        `source-human-unattributed-${crypto.randomUUID()}`,
        (client) => client.ytext.insert(client.ytext.length, '\nHuman edit in source.\n'),
        undefined,
      );
    } finally {
      await server.cleanup();
    }
  });
});
