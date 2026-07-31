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

/**
 * install validates the SKILL.md ON DISK (name + description
 * non-empty), but a description typed in the live editor a moment ago is still
 * inside the debounced persist window — so a naive disk read false-fails with
 * "description is missing or empty". The install handler must force-flush the
 * skill's live content doc before validating. With the persist debounce set far
 * longer than the test, the ONLY way the description reaches disk in time is the
 * handler's own pre-validate flush.
 *
 */
describe('skill install flushes the live SKILL.md before validating (PRD-7447)', () => {
  let server: TestServer;
  let contentDir: string;
  const skillDirRel = '.claude/skills/flushtest';
  const skillDocName = `${skillDirRel}/SKILL`;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-skill-flush-'));
    mkdirSync(join(contentDir, skillDirRel), { recursive: true });
    // Seed WITH AN EMPTY DESCRIPTION on disk — the state right after "New skill",
    // before the author has typed one. A raw disk read here would reject install.
    writeFileSync(
      join(contentDir, skillDirRel, 'SKILL.md'),
      '---\nname: flushtest\ndescription: \n---\n\nDraft body.\n',
    );
    // Persist debounce >> test duration, so persistence never fires on its own;
    // the description can only land via the install handler's pre-validate flush.
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
      // Wait for the disk seed to sync into the client before editing it.
      await pollUntil(async () => client.ytext.toString().includes('name: flushtest'), 2000, 25);

      // Type a real description into the live source — NOT persisted (debounce).
      const withDesc =
        '---\nname: flushtest\ndescription: A real description typed live\n---\n\nDraft body.\n';
      client.doc.transact(() => {
        client.ytext.delete(0, client.ytext.length);
        client.ytext.insert(0, withDesc);
      });
      await awaitDocQuiescence(client.doc);

      // Disk is still the empty-description seed at this point (debounce pending).
      expect(readFileSync(join(contentDir, skillDirRel, 'SKILL.md'), 'utf-8')).not.toContain(
        'A real description typed live',
      );

      const res = await fetch(`${base}/api/skill/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'project', name: 'flushtest', targets: ['cursor'] }),
      });

      // Pre-fix this was a 400 INVALID_SKILL_SOURCE ("description is missing or empty").
      expect(res.status).toBe(200);

      // The pre-validate flush landed the live description on disk — read it back
      // through the API (projection-agnostic; install relocates the canonical).
      const get = await fetch(`${base}/api/skill?name=flushtest&scope=project`);
      const payload = (await get.json()) as { skill?: { frontmatter?: { description?: string } } };
      expect(payload.skill?.frontmatter?.description).toBe('A real description typed live');
    } finally {
      await client.cleanup();
    }
  });
});
