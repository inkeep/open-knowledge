import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness.ts';

describe('skill install flushes the live SKILL.md before validating (PRD-7447)', () => {
  let server: TestServer;
  let contentDir: string;
  const skillDirRel = '.claude/skills/flushtest';
  const skillDocName = `${skillDirRel}/SKILL`;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-skill-flush-'));
    mkdirSync(join(contentDir, skillDirRel), { recursive: true });
    writeFileSync(
      join(contentDir, skillDirRel, 'SKILL.md'),
      '---\nname: flushtest\ndescription: \n---\n\nDraft body.\n',
    );
    server = await createTestServer({ contentDir, debounce: 60_000, maxDebounce: 60_000 });
  });

  afterEach(async () => {
    await server.cleanup();
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('install succeeds when the description exists only in the unflushed live doc', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const client = await createTestClient(server.port, skillDocName);
    try {
      await pollUntil(async () => client.ytext.toString().includes('name: flushtest'), 2000, 25);

      const withDesc =
        '---\nname: flushtest\ndescription: A real description typed live\n---\n\nDraft body.\n';
      client.doc.transact(() => {
        client.ytext.delete(0, client.ytext.length);
        client.ytext.insert(0, withDesc);
      });
      await awaitDocQuiescence(client.doc);

      expect(readFileSync(join(contentDir, skillDirRel, 'SKILL.md'), 'utf-8')).not.toContain(
        'A real description typed live',
      );

      const res = await fetch(`${base}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'project', name: 'flushtest', targets: ['cursor'] }),
      });

      expect(res.status).toBe(200);

      const get = await fetch(`${base}/api/skill?name=flushtest&scope=project`);
      const payload = (await get.json()) as { skill?: { frontmatter?: { description?: string } } };
      expect(payload.skill?.frontmatter?.description).toBe('A real description typed live');
    } finally {
      await client.cleanup();
    }
  });
});
