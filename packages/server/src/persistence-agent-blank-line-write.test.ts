import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const HEADINGS_WITHOUT_BLANK_LINES =
  '# Title\nIntro para.\n\n## Section A\nBody A.\n\n## Section B\nBody B.\n';
let contentDir: string;
let server: BootedServer;
let ephemeralDir: string;
let ephemeralServer: BootedServer;

beforeAll(async () => {
  contentDir = mkdtempSync(resolve(tmpdir(), 'ok-agent-blank-line-'));
  writeFileSync(resolve(contentDir, 'lint-target.md'), HEADINGS_WITHOUT_BLANK_LINES, 'utf-8');
  writeFileSync(resolve(contentDir, 'edit-target.md'), HEADINGS_WITHOUT_BLANK_LINES, 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
  appendFileSync(
    resolve(contentDir, '.ok', 'config.yml'),
    '\ncontentRules:\n  enabled: true\n  markdownlint:\n    enabled: true\n',
  );

  ephemeralDir = mkdtempSync(resolve(tmpdir(), 'ok-agent-blank-line-ephemeral-'));
  writeFileSync(resolve(ephemeralDir, 'note.md'), HEADINGS_WITHOUT_BLANK_LINES, 'utf-8');
  ephemeralServer = await bootCompositionRig(ephemeralDir, {
    ephemeral: true,
    singleDocRelPath: 'note.md',
  });
  await ephemeralServer.ready;
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([server?.destroy(), ephemeralServer?.destroy()]);
  await rm(contentDir, { recursive: true, force: true });
  await rm(ephemeralDir, { recursive: true, force: true });
});

function post(path: string, body: Record<string, unknown>, target: BootedServer = server) {
  return fetch(`http://127.0.0.1:${target.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentName: 'blank-line-agent', clientName: 'test', ...body }),
  });
}

test('lint fix whose only change is blank lines below headings reaches disk', async () => {
  const res = await post('/api/lint/fix', { docName: 'lint-target' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { fixedCount: number };
  expect(body.fixedCount).toBeGreaterThan(0);
  expect(readFileSync(resolve(contentDir, 'lint-target.md'), 'utf-8')).toBe(
    '# Title\n\nIntro para.\n\n## Section A\n\nBody A.\n\n## Section B\n\nBody B.\n',
  );
});

test('agent patch that only inserts a blank line below a heading reaches disk', async () => {
  const res = await post('/api/agent-patch', {
    docName: 'edit-target',
    find: '## Section A\nBody A.',
    replace: '## Section A\n\nBody A.',
  });
  expect(res.status).toBe(200);
  expect(readFileSync(resolve(contentDir, 'edit-target.md'), 'utf-8')).toBe(
    '# Title\nIntro para.\n\n## Section A\n\nBody A.\n\n## Section B\nBody B.\n',
  );
});

test('agent patch on an ephemeral single-file doc reaches disk with the blank line', async () => {
  const res = await post(
    '/api/agent-patch',
    {
      docName: 'note',
      find: '## Section A\nBody A.',
      replace: '## Section A\n\nBody A.',
    },
    ephemeralServer,
  );
  expect(res.status).toBe(200);
  expect(readFileSync(resolve(ephemeralDir, 'note.md'), 'utf-8')).toBe(
    '# Title\nIntro para.\n\n## Section A\n\nBody A.\n\n## Section B\nBody B.\n',
  );
});
