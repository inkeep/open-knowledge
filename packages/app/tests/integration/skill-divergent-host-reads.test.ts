import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

/**
 * Same name, different content across host dirs = two different skills, each its
 * own row. Every per-row READ must therefore be addressed by host, or a row
 * silently serves its namesake's bytes.
 *
 * OK's own `open-knowledge*` bundles resolve through a SEPARATE branch from
 * authored skills, and that branch ignored the host — so both rows of a diverged
 * built-in served whichever dir the editor-id order reached first. The two
 * `open-knowledge` cases below are the regression guard; the authored-skill
 * cases pin the path that was always correct so the two can't drift apart.
 *
 */
let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

/** A bundle with a distinguishing SKILL.md body and its own reference file. */
function writeBundle(root: string, name: string, marker: string, refName: string): void {
  const dir = join(server.contentDir, root, name);
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${marker} copy.\n---\n\n# ${marker}\n`,
  );
  writeFileSync(join(dir, 'references', refName), `# ${marker} reference\n`);
}

beforeAll(async () => {
  server = await createTestServer();
  // A diverged BUILT-IN: `.agents` holds a stale single-file copy, `.claude` the
  // current one. This is the shape that shipped broken.
  writeBundle('.agents/skills', 'open-knowledge', 'agents-side', 'from-agents.md');
  writeBundle('.claude/skills', 'open-knowledge', 'claude-side', 'from-claude.md');
  // A diverged AUTHORED skill, same shape, different resolution path.
  writeBundle('.agents/skills', 'reviewer', 'agents-side', 'from-agents.md');
  writeBundle('.claude/skills', 'reviewer', 'claude-side', 'from-claude.md');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function skillAt(name: string, host: string) {
  const res = await fetch(`${base()}/api/skill?scope=project&name=${name}&host=${host}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    skill?: { path?: string; body?: string; files?: Array<{ path: string }> };
  };
  return body.skill ?? {};
}

async function fileAt(name: string, host: string, path: string) {
  return fetch(`${base()}/api/skill-file?scope=project&name=${name}&host=${host}&path=${path}`);
}

describe('divergent same-name skills read per host', () => {
  for (const name of ['open-knowledge', 'reviewer']) {
    test(`${name}: each host serves its OWN bundle, not its namesake's`, async () => {
      const fromAgents = await skillAt(name, 'agents');
      const fromClaude = await skillAt(name, 'claude');

      expect(fromAgents.path).toContain('.agents/skills');
      expect(fromClaude.path).toContain('.claude/skills');
      expect(fromAgents.body).toContain('agents-side');
      expect(fromClaude.body).toContain('claude-side');
    });

    test(`${name}: bundle FILES come from the addressed host`, async () => {
      const agentsFiles = (await skillAt(name, 'agents')).files ?? [];
      const claudeFiles = (await skillAt(name, 'claude')).files ?? [];

      expect(agentsFiles.map((f) => f.path)).toContain('references/from-agents.md');
      expect(agentsFiles.map((f) => f.path)).not.toContain('references/from-claude.md');
      expect(claudeFiles.map((f) => f.path)).toContain('references/from-claude.md');
      expect(claudeFiles.map((f) => f.path)).not.toContain('references/from-agents.md');
    });

    test(`${name}: a reference file reads from the addressed host`, async () => {
      const own = await fileAt(name, 'agents', 'references/from-agents.md');
      expect(own.status).toBe(200);
      expect(((await own.json()) as { text: string }).text).toContain('agents-side');

      // The sibling's file is NOT in this host's bundle — serving it would be the
      // silent wrong-bytes read this whole contract exists to prevent.
      expect((await fileAt(name, 'agents', 'references/from-claude.md')).status).toBe(404);
    });
  }
});
