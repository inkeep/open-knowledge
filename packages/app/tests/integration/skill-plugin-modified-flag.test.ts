import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

/**
 * A project copy of a Claude PLUGIN's skill gets a synthesized plugin origin,
 * and its Modified flag is decided against the machine-local first-seen
 * baseline — NOT the plugin's bytes, because the fan-out into
 * `.agents/skills/` legitimately rewrites content on the way. So: first sight
 * of a copy that differs from the plugin is NOT modified (that difference is
 * the fan-out), while a subsequent edit of the copy IS (it diverged from what
 * OK first saw). This drives the whole wiring end-to-end through the real
 * `/api/skills` list: plugin cache on disk → upstream index → synthesized
 * origin → baseline record → Modified flip.
 *
 */
let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

const skillMd = (body: string) => `---\nname: probe\ndescription: d.\n---\n\n${body}\n`;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-plugin-modified-home-'));
  // A real Claude plugin install: the version-2 manifest names the ACTIVE
  // install; the cache dir holds the bundle whose skill the project copied.
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
  // The project's copy — same name, DIFFERENT bytes, as a fan-out produces.
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
  // The synthesized origin names the plugin's cache dir as the source — the
  // same shape a real import records, so provenance grouping recognizes it.
  expect(entry.origin?.source).toContain(join('plugins', 'cache', 'market', 'toolkit'));
  // Different bytes from the plugin, but first sight baselines the copy as-is.
  expect(entry.modified ?? false).toBe(false);
});

test('editing the copy after first sight flips Modified while the plugin is unchanged', async () => {
  await listProbe(); // ensure the first-seen baseline is recorded
  writeFileSync(
    join(server.contentDir, '.agents', 'skills', 'probe', 'SKILL.md'),
    skillMd('# Copy, hand-edited afterwards'),
  );
  const entry = await listProbe();
  expect(entry.modified).toBe(true);
});

/**
 * The synthesized plugin origin renders the auto-update toggle, so the
 * reimport route must resolve the same synthesized entry — resolving only the
 * stored lockfile answered the toggle with "no recorded import source".
 *
 */
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
