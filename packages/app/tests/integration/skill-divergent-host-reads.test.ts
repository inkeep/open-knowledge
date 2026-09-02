import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
const base = () => `http://127.0.0.1:${server.port}`;

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
  writeBundle('.agents/skills', 'open-knowledge', 'agents-side', 'from-agents.md');
  writeBundle('.claude/skills', 'open-knowledge', 'claude-side', 'from-claude.md');
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

      expect((await fileAt(name, 'agents', 'references/from-claude.md')).status).toBe(404);
    });
  }
});
