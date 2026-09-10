import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { __formatContributorsForTests } from './contributor-tracker.ts';

let root: string;
let server: BootedServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-agent-write-composition-'));
  server = await bootCompositionRig(root);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

async function request(path: string, body?: object) {
  const response = await rawRequest(server.port, path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, response.body).toBe(200);
  return JSON.parse(response.body);
}

test('write, patch, activity, diff and undo share the live session and preserve disk bytes', async () => {
  const docName = 'native-spine';
  const agentId = 'spine-writer';
  const markdown = '# Exact bytes\n\nBackslash \\* and <custom>raw</custom>.\n\n';
  await request('/api/agent-write-md', { docName, agentId, markdown, position: 'replace' });
  const session = await server.serverInstance.sessionManager.getSession(
    docName,
    `agent-${agentId}`,
  );
  expect(session.dc.document.getText('source').toString()).toBe(markdown);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(markdown);
  session.um.stopCapturing();
  const origins: unknown[] = [];
  const observe = (event: { transaction: { origin: unknown } }) =>
    origins.push(event.transaction.origin);
  session.dc.document.getText('source').observe(observe);
  try {
    await request('/api/agent-patch', {
      docName,
      agentId,
      find: 'Exact bytes',
      replace: 'Changed bytes',
    });
    expect(origins).toContain(session.origin);
    expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(
      markdown.replace('Exact bytes', 'Changed bytes'),
    );
    const activity = await request(`/api/agent-activity?agentId=agent-${agentId}`);
    expect(JSON.stringify(activity)).toContain(docName);
    const diff = await request(
      `/api/agent-burst-diff?agentId=agent-${agentId}&docName=${docName}&keptCount=${session.um.undoStack.length}`,
    );
    expect(diff.before).toBe('');
    expect(diff.after).toBe(markdown.replace('Exact bytes', 'Changed bytes'));
    const undone = await request('/api/agent-undo', {
      docName,
      agentId,
      connectionId: `agent-${agentId}`,
      scope: 'last',
    });
    expect(undone.undone).toBe(true);
    expect(session.dc.document.getText('source').toString()).toBe(markdown);
    expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(markdown);
  } finally {
    session.dc.document.getText('source').unobserve(observe);
  }
});

test('frontmatter patch preserves the existing body bytes', async () => {
  const docName = 'native-frontmatter';
  const body = '\nBody \\* <custom>raw</custom>.\n\n';
  await request('/api/agent-write-md', {
    docName,
    agentId: 'fm',
    markdown: `---\ntitle: Before\n---\n${body}`,
    position: 'replace',
  });
  const result = await request('/api/frontmatter-patch', {
    docName,
    agentId: 'fm',
    patch: { title: 'After' },
  });
  expect(result.appliedKeys).toEqual(['title']);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(`---\ntitle: After\n---\n${body}`);
});

test('save and rollback retain shadow history and the principal loaded after route construction', async () => {
  const docName = 'native-version';
  const markdown = '# Saved version\n\nExact \\* bytes.\n';
  await request('/api/agent-write-md', {
    docName,
    agentId: 'version-writer',
    markdown,
    position: 'replace',
  });
  const saved = await request('/api/save-version', {
    agentId: 'version-writer',
    summary: 'Checkpoint',
  });
  const commitSha = saved.checkpointRef.split('/').at(-1);
  expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
  await request('/api/agent-write-md', {
    docName,
    agentId: 'version-writer',
    markdown: '# Changed\n',
    position: 'replace',
  });
  const principal = await request('/api/principal');
  expect(principal.id).toBeTruthy();
  const rolledBack = await request('/api/rollback', {
    docName,
    commitSha,
    principalId: 'forged-principal',
    summary: 'Restore saved version',
  });
  expect(rolledBack.restoredFrom).toBe(commitSha);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(markdown);
  expect(__formatContributorsForTests()).toContain(principal.id);
  expect(__formatContributorsForTests()).not.toContain('forged-principal');
});
