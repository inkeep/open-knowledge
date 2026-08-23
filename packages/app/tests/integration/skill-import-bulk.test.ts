import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestServer, HARNESS_BOOT_TIMEOUT_MS, type TestServer } from './test-harness.ts';

/**
 * `POST /api/skills/import-bulk` — many named skills from ONE source in a single
 * fetch (the plugin case). Proves the selection is honored exactly (unpicked
 * siblings stay out), that a name absent from the source reports per-skill
 * instead of failing the request, and that the same-source dedupe still holds.
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
  srcRoot = mkdtempSync(join(tmpdir(), 'ok-bulk-src-'));
  // A "plugin"-shaped source: three sibling skill dirs under one root.
  for (const name of ['alpha-skill', 'beta-skill', 'gamma-skill']) {
    writeSkillDir(join(srcRoot, 'bundle', name), name, `Does ${name} things`);
  }
  // A starter-pack-shaped bundle: same as the others but carrying the upstream
  // `metadata.pack` identity a published pack ships with.
  mkdirSync(join(srcRoot, 'bundle', 'note-taking'), { recursive: true });
  writeFileSync(
    join(srcRoot, 'bundle', 'note-taking', 'SKILL.md'),
    '---\nname: note-taking\ndescription: Plain notes.\nmetadata:\n  pack: "plain-notes"\n  author: "Inkeep"\n---\n\nBody.\n',
  );
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(() => {
  rmSync(srcRoot, { recursive: true, force: true });
});

describe('POST /api/skills/import-bulk', () => {
  test('an imported pack keeps the identity marker, and nothing else upstream', async () => {
    // The write canonicalizes frontmatter, and `metadata.pack` is the one key
    // that must survive it: it is the only proof a generically-named skill is a
    // starter pack of ours, and the provenance retrofit refuses to synthesize a
    // source without it. Dropping it meant an imported pack whose lock entry
    // went missing — routine, the lockfile is gitignored — could never be
    // recognised again, so it showed no source and sat outside its group.
    const server = await createTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/skills/import-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'project',
          source: join(srcRoot, 'bundle'),
          skills: ['note-taking'],
        }),
      });
      expect(res.status).toBe(200);

      // Located rather than assumed: the install root depends on the scope's
      // host layout, and this assertion is about the BYTES, not the path.
      const candidates = ['.agents/skills', '.ok/skills', '.claude/skills'].map((root) =>
        join(server.contentDir, ...root.split('/'), 'note-taking', 'SKILL.md'),
      );
      const found = candidates.find((c) => existsSync(c));
      expect(found, `note-taking not written to any of ${candidates.join(', ')}`).toBeDefined();
      const written = readFileSync(found as string, 'utf-8');
      expect(written).toContain('pack: plain-notes');
      // Still canonicalized otherwise: the upstream's other metadata is dropped.
      expect(written).not.toContain('Inkeep');
    } finally {
      await server.cleanup();
    }
  });

  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const importBulk = (payload: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${server.port}/api/skills/import-bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  /** Skill names the server lists — asserted through the API rather than a
   *  guessed on-disk root, since the import home is resolved server-side. */
  async function listedNames(): Promise<string[]> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/skills`);
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    return body.skills.map((s) => s.name);
  }

  interface BulkBody {
    results: Array<{ requested: string; status: string; name?: string; error?: string }>;
    imported: number;
    alreadyImported: number;
    failed: number;
  }

  test('imports exactly the selected skills and leaves the rest alone', async () => {
    const res = await importBulk({
      source: join(srcRoot, 'bundle'),
      skills: ['alpha-skill', 'gamma-skill'],
      install: false,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as BulkBody;
    expect(out.imported).toBe(2);
    expect(out.failed).toBe(0);
    expect(out.results.map((r) => r.status)).toEqual(['imported', 'imported']);
    const names = await listedNames();
    expect(names).toContain('alpha-skill');
    expect(names).toContain('gamma-skill');
    // The unpicked sibling is the whole point of a picker.
    expect(names).not.toContain('beta-skill');
  });

  test('a name absent from the source is per-skill, not a failed request', async () => {
    const res = await importBulk({
      source: join(srcRoot, 'bundle'),
      skills: ['alpha-skill', 'nope-skill'],
      install: false,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as BulkBody;
    expect(out.imported).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.results.find((r) => r.requested === 'nope-skill')?.status).toBe('not-found');
    expect(await listedNames()).toContain('alpha-skill');
  });

  test('an unreadable bundle fails only itself, not the selection', async () => {
    // Failure isolation has to survive a THROW, not just a failure outcome: the
    // pre-flight walk stats and reads the tree, and an unreadable dir raises
    // EACCES. Root ignores mode bits, so skip rather than assert a false pass.
    const locked = join(srcRoot, 'bundle', 'locked-skill');
    writeSkillDir(locked, 'locked-skill', 'Cannot be read');
    chmodSync(locked, 0o000);
    const readable = (() => {
      try {
        readdirSync(locked);
        return true;
      } catch {
        return false;
      }
    })();
    try {
      if (readable) return; // running as root — the permission bit means nothing
      const res = await importBulk({
        source: join(srcRoot, 'bundle'),
        skills: ['alpha-skill', 'locked-skill'],
        install: false,
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as BulkBody;
      // Either unsuccessful label is fine — an unreadable dir drops out of
      // enumeration (`not-found`) or trips the pre-flight walk (`failed`). What
      // must hold is that it is reported per-skill and counted, never thrown.
      expect(['failed', 'not-found']).toContain(
        out.results.find((r) => r.requested === 'locked-skill')?.status,
      );
      expect(out.failed).toBe(1);
      // The whole point: the good skill in the same selection still landed.
      expect(out.imported).toBe(1);
      expect(await listedNames()).toContain('alpha-skill');
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  test('re-importing the same selection is a content-hash no-op', async () => {
    const payload = {
      source: join(srcRoot, 'bundle'),
      skills: ['beta-skill'],
      install: false,
    };
    expect((await importBulk(payload)).status).toBe(200);
    const second = (await (await importBulk(payload)).json()) as BulkBody;
    expect(second.imported).toBe(0);
    expect(second.alreadyImported).toBe(1);
    expect(second.failed).toBe(0);
  });
});
