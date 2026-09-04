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
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkBody;
    expect(body.results.map((r) => r.requested).sort()).toEqual(['one-skill', 'two-skill']);
    expect(body.upToDate).toBe(2);
    expect(body.failed).toBe(0);
  });

  test('Update preserves the pack identity marker its install carried', async () => {
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
    expect(rows['never-imported']).toBe('not-found');
    expect(rows['one-skill']).toBeDefined();
    expect(rows['one-skill']).not.toBe('not-found');
  });

  test('a source that has gone away fails only its own members, still 200', async () => {
    await importFixture();
    rmSync(join(srcRoot, 'bundle'), { recursive: true, force: true });

    const res = await post('/api/skills/reimport-bulk', {
      scope: 'project',
      names: ['one-skill', 'two-skill'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkBody;
    expect(body.results).toHaveLength(2);
    expect(body.updated).toBe(0);
    for (const row of body.results) {
      expect(['failed', 'not-found', 'up-to-date', 'updated']).toContain(row.status);
    }

    for (const name of ['one-skill', 'two-skill']) {
      writeSkillDir(join(srcRoot, 'bundle', name), name, `Does ${name} things`);
    }
  });

  test('rejects a malformed request rather than half-running it', async () => {
    const res = await post('/api/skills/reimport-bulk', { scope: 'project', names: [] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
