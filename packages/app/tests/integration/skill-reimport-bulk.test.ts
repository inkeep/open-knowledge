import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
} from './test-harness.ts';

/**
 * `POST /api/skills/reimport-bulk` — the handler's FAILURE-ISOLATION contract,
 * which the spine's unit tests cannot reach.
 *
 * The spine (`skill-reimport.test.ts`) proves one skill updates correctly. What
 * only an integration test can prove is what the endpoint promises around it:
 * that it always answers 200 with per-skill rows, that one bad member never
 * costs the others their result, and that a name nobody recorded reports rather
 * than throwing. The motivating case is real — a single upstream description
 * containing an XML-tag shape refuses to write, and the batch it sat in must
 * still land and report every other skill.
 */

let srcRoot: string;

function writeSkillDir(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
  );
}

beforeAll(() => {
  srcRoot = mkdtempSync(join(tmpdir(), 'ok-rebulk-src-'));
  for (const name of ['one-skill', 'two-skill']) {
    writeSkillDir(join(srcRoot, 'bundle', name), name, `Does ${name} things`);
  }
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(() => {
  rmSync(srcRoot, { recursive: true, force: true });
});

interface BulkBody {
  results: Array<{ requested: string; status: string; error?: string; source?: string }>;
  updated: number;
  upToDate: number;
  failed: number;
}

describe('POST /api/skills/reimport-bulk', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const post = (path: string, payload: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  /** Import the fixture bundle so there is something with recorded provenance
   *  to update. Bulk update only ever acts on skills the lockfile knows. */
  async function importFixture(): Promise<void> {
    const res = await post('/api/skills/import-bulk', {
      scope: 'project',
      source: join(srcRoot, 'bundle'),
      skills: ['one-skill', 'two-skill'],
    });
    expect(res.status).toBe(200);
  }

  test('answers 200 with a row per requested skill, both already current', async () => {
    await importFixture();

    const res = await post('/api/skills/reimport-bulk', {
      scope: 'project',
      names: ['one-skill', 'two-skill'],
    });
    // 200 even though nothing changed: the rows ARE the result, and "nothing to
    // do" is an outcome rather than an error.
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkBody;
    expect(body.results.map((r) => r.requested).sort()).toEqual(['one-skill', 'two-skill']);
    expect(body.upToDate).toBe(2);
    expect(body.failed).toBe(0);
  });

  test('Update preserves the pack identity marker its install carried', async () => {
    // A pack skill's `metadata.pack` is how provenance grouping recognizes it.
    // The reimport write re-composes frontmatter from the acquired upstream, so
    // dropping the marker there would silently strip it on the FIRST Update —
    // after which nothing on disk says the skill ever belonged to a pack.
    const dir = join(srcRoot, 'pack-bundle', 'pack-skill');
    const fm = 'name: pack-skill\ndescription: Packed thing\nmetadata:\n  pack: starter-pack';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n\nBody v1.\n`);
    const imp = await post('/api/skills/import-bulk', {
      scope: 'project',
      source: join(srcRoot, 'pack-bundle'),
      skills: ['pack-skill'],
    });
    expect(imp.status).toBe(200);

    writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n\nBody v2.\n`);
    const res = await post('/api/skills/reimport-bulk', {
      scope: 'project',
      names: ['pack-skill'],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as BulkBody).updated).toBe(1);

    const skillMd = join(server.contentDir, '.claude', 'skills', 'pack-skill', 'SKILL.md');
    await pollUntil(() => readFileSync(skillMd, 'utf-8').includes('Body v2.'));
    expect(readFileSync(skillMd, 'utf-8')).toContain('pack: starter-pack');
  });

  test('an unrecorded name reports as a row instead of failing the batch', async () => {
    await importFixture();

    const res = await post('/api/skills/reimport-bulk', {
      scope: 'project',
      names: ['one-skill', 'never-imported'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkBody;

    const rows = Object.fromEntries(body.results.map((r) => [r.requested, r.status]));
    // The isolation contract in one assertion: the unknown name is reported, and
    // the known one still got its answer rather than being lost with it.
    expect(rows['never-imported']).toBe('not-found');
    expect(rows['one-skill']).toBeDefined();
    expect(rows['one-skill']).not.toBe('not-found');
  });

  test('a source that has gone away fails only its own members, still 200', async () => {
    await importFixture();
    // Delete the source the lockfile points at. Every member of that group now
    // fails to fetch — which must surface per skill, not as a request-level 500.
    rmSync(join(srcRoot, 'bundle'), { recursive: true, force: true });

    const res = await post('/api/skills/reimport-bulk', {
      scope: 'project',
      names: ['one-skill', 'two-skill'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkBody;
    expect(body.results).toHaveLength(2);
    expect(body.updated).toBe(0);
    // Every row carries an outcome; none is silently missing.
    for (const row of body.results) {
      expect(['failed', 'not-found', 'up-to-date', 'updated']).toContain(row.status);
    }

    // Restore for any later test in this file.
    for (const name of ['one-skill', 'two-skill']) {
      writeSkillDir(join(srcRoot, 'bundle', name), name, `Does ${name} things`);
    }
  });

  test('rejects a malformed request rather than half-running it', async () => {
    // `names` is required and non-empty — a request that names nothing is a
    // caller bug, and is the one shape that IS a 4xx rather than a rows answer.
    const res = await post('/api/skills/reimport-bulk', { scope: 'project', names: [] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
