import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const skillMd = (body: string) => `---\nname: probe\ndescription: d.\n---\n\n${body}\n`;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-plugin-modified-home-'));
  const installPath = join(tmpHome, '.claude', 'plugins', 'cache', 'market', 'toolkit', '1.0.0');
  mkdirSync(join(installPath, 'skills', 'probe'), { recursive: true });
  writeFileSync(join(installPath, 'skills', 'probe', 'SKILL.md'), skillMd('# Upstream'));
  writeFileSync(
    join(tmpHome, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        'toolkit@market': [
          { scope: 'user', installPath, version: '1.0.0', lastUpdated: '2026-01-01' },
        ],
      },
    }),
  );
  server = await createTestServer({ configHomedirOverride: tmpHome });
  mkdirSync(join(server.contentDir, '.agents', 'skills', 'probe'), { recursive: true });
  writeFileSync(
    join(server.contentDir, '.agents', 'skills', 'probe', 'SKILL.md'),
    skillMd('# Copy, rewritten on the way'),
  );
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function listProbe() {
  const res = await fetch(`${base()}/api/skills`);
  expect(res.status).toBe(200);
  const parsed = SkillsListSuccessSchema.parse(await res.json());
  const entry = parsed.skills.find((s) => s.name === 'probe' && s.scope === 'project');
  expect(entry).toBeDefined();
  return entry as NonNullable<typeof entry>;
}

test('a fanned-out plugin copy gets the plugin origin and is not Modified on first sight', async () => {
  const entry = await listProbe();
  expect(entry.origin?.source).toContain(join('plugins', 'cache', 'market', 'toolkit'));
  expect(entry.modified ?? false).toBe(false);
});

test('editing the copy after first sight flips Modified while the plugin is unchanged', async () => {
  await listProbe();
  writeFileSync(
    join(server.contentDir, '.agents', 'skills', 'probe', 'SKILL.md'),
    skillMd('# Copy, hand-edited afterwards'),
  );
  const deadline = Date.now() + 5_000;
  let entry = await listProbe();
  while (entry.modified !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    entry = await listProbe();
  }
  expect(entry.modified).toBe(true);
});

test('the auto-update toggle persists for a plugin copy with no stored lock entry', async () => {
  const res = await fetch(`${base()}/api/skill/reimport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'probe', scope: 'project', setAutoUpdate: true }),
  });
  expect(res.status).toBe(200);
  const entry = await listProbe();
  expect(entry.origin?.autoUpdate).toBe(true);
});
