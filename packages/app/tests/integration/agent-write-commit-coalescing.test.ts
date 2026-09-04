import { execFileSync } from 'node:child_process';
import { parseWriterId, resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterEach, describe, expect, test } from 'vitest';
import { agentWriteMd, createTestServer, type TestServer } from './test-harness';

interface TimelineResponse {
  entries: Array<{ sha: string; type: string; message: string }>;
}

let server: TestServer | undefined;

afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

function listWipRefs(contentDir: string): string[] {
  const shadowDir = resolveShadowDir(contentDir);
  const raw = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/wip/'], {
    env: { ...process.env, GIT_DIR: shadowDir },
    encoding: 'utf-8',
  });
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((refname) => {
      const writerId = refname.split('/').slice(3).join('/');
      if (!writerId) return false;
      const { classification } = parseWriterId(writerId);
      return classification === 'agent' || classification === 'principal';
    });
}

describe('agent-write L2 commit coalescing', () => {
  test('writes coalesce on the debounce; /api/history flushes before reading', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 600_000 });

    await agentWriteMd(server.port, '# Doc A\n', {
      docName: 'coalesce-a',
      position: 'replace',
      agentId: 'coalesce-writer',
      agentName: 'Coalesce Writer',
    });
    await agentWriteMd(server.port, '# Doc B\n', {
      docName: 'coalesce-b',
      position: 'replace',
      agentId: 'coalesce-writer',
      agentName: 'Coalesce Writer',
    });

    expect(listWipRefs(server.contentDir)).toEqual([]);

    const res = await fetch(
      `${server.baseUrl}/api/history?docName=${encodeURIComponent('coalesce-a')}`,
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as TimelineResponse;
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries.some((e) => e.type === 'wip')).toBe(true);

    const resB = await fetch(
      `${server.baseUrl}/api/history?docName=${encodeURIComponent('coalesce-b')}`,
    );
    expect(resB.ok).toBe(true);
    const bodyB = (await resB.json()) as TimelineResponse;
    expect(bodyB.entries.some((e) => e.type === 'wip')).toBe(true);

    const refs = listWipRefs(server.contentDir);
    expect(refs.length).toBe(1);
  }, 30_000);
});
