import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, type TestServer } from './test-harness';

/**
 * A project→global→project round-trip must leave the skill fully alive: listed
 * at project scope, detail-readable, and — the part the sidebar click depends
 * on — its content doc SERVABLE over the collab socket. The field failure this
 * pins: after moving a skill out and back in one session, the sidebar row went
 * dead. The client half (the tab reconciler retargeting each hop instead of
 * closing) is pinned in `use-reconcile-skill-tabs.test.ts`; this is the server
 * half at each hop.
 *
 */
let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-scope-roundtrip-home-'));
  // An adopted harness in the throwaway home — global destinations refuse
  // (NO_USABLE_SKILL_HOME) when the home has adopted none.
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('scope-move round-trip keeps the skill openable', () => {
  test('project -> global -> project: listed, readable, and doc servable at every hop', async () => {
    const name = 'roundtrip-skill';
    const marker = 'Roundtrip body marker';
    const put = await fetch(`${base()}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name,
        frontmatter: { name, description: 'Round-trip coverage.' },
        body: `# ${marker}\n`,
      }),
    });
    expect(put.status).toBe(200);
    const createdPath = ((await put.json()) as { path: string }).path;
    const projectDocName = createdPath.replace(/\.md$/, '');

    const move = async (fromScope: string, toScope: string) => {
      const res = await fetch(`${base()}/api/skill/move-scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, fromScope, toScope }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };

    await move('project', 'global');
    const listedGlobal = (await (await fetch(`${base()}/api/skills`)).json()) as {
      skills: Array<{ name: string; scope: string }>;
    };
    expect(listedGlobal.skills.some((s) => s.name === name && s.scope === 'global')).toBe(true);
    expect(listedGlobal.skills.some((s) => s.name === name && s.scope === 'project')).toBe(false);

    await move('global', 'project');
    const listedBack = (await (await fetch(`${base()}/api/skills`)).json()) as {
      skills: Array<{ name: string; scope: string; path: string }>;
    };
    const backEntry = listedBack.skills.find((s) => s.name === name && s.scope === 'project');
    expect(backEntry).toBeDefined();
    expect(listedBack.skills.some((s) => s.name === name && s.scope === 'global')).toBe(false);

    // Detail read resolves the returned bundle.
    const detail = await fetch(`${base()}/api/skill?name=${name}&scope=project`);
    expect(detail.status).toBe(200);

    // On disk where the entry says it is.
    expect(existsSync(join(server.contentDir, backEntry?.path ?? ''))).toBe(true);

    // And the content doc is SERVABLE — the click's actual dependency. A
    // refused/never-syncing connect here is exactly "the row is dead".
    const backDocName = (backEntry?.path ?? '').replace(/\.md$/, '');
    expect(backDocName).toBe(projectDocName);
    const client = await createTestClient(server.port, backDocName);
    try {
      await expect
        .poll(() => client.ytext.toString(), { timeout: 15_000, interval: 250 })
        .toContain(marker);
    } finally {
      await client.cleanup();
    }
  }, 60_000);
});
