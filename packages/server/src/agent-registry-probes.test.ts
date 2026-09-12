import {
  checkProbeCoverage,
  collectProbeCoverage,
  PROBEABLE_SATISFIER_IDS,
  type ProbeResolver,
  type ProbeWorkItem,
  planProbes,
} from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { collectServerHostSnapshot, createServerProbeResolver } from './agent-registry-probes.ts';

function recordingResolver(): { resolve: ProbeResolver; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: (item: ProbeWorkItem) => {
      asked.push(item.satisfierId);
      return { state: 'satisfied', strictness: ['reclaim-permissive'] };
    },
  };
}

function itemFor(id: string): ProbeWorkItem {
  const item = planProbes().find((candidate) => candidate.satisfierId === id);
  if (item === undefined) throw new Error(`no work item for ${id}`);
  return item;
}

describe('without an injected resolver', () => {
  it('answers nothing rather than guessing', async () => {
    const covered = await collectProbeCoverage(createServerProbeResolver({ env: 'local-web' }));
    expect(covered).toEqual([]);
  });

  it('still keys every satisfier, all of them unprobed', async () => {
    const { probes } = await collectServerHostSnapshot({ env: 'local-web' });
    expect(checkProbeCoverage(Object.keys(probes.satisfiers))).toEqual({
      missing: [],
      unclaimed: [],
    });
    const states = new Set(Object.values(probes.satisfiers).map((probe) => probe?.state));
    expect([...states]).toEqual(['unprobed']);
  });
});

describe('with an injected resolver', () => {
  it('answers everything the wiring layer can answer', async () => {
    const { resolve } = recordingResolver();
    const covered = await collectProbeCoverage(
      createServerProbeResolver({ env: 'local-web', resolve }),
    );
    expect(checkProbeCoverage(covered)).toEqual({ missing: [], unclaimed: [] });
  });

  it('produces no key the registry does not claim', async () => {
    const { resolve } = recordingResolver();
    const { probes } = await collectServerHostSnapshot({ env: 'local-web', resolve });
    expect(checkProbeCoverage(Object.keys(probes.satisfiers)).unclaimed).toEqual([]);
  });

  it('carries the tier it was told about', async () => {
    const { resolve } = recordingResolver();
    const { probes } = await collectServerHostSnapshot({ env: 'remote-web', resolve });
    expect(probes.env).toBe('remote-web');
  });

  it('reads a resolver that throws as unprobed', async () => {
    const { probes } = await collectServerHostSnapshot({
      env: 'local-web',
      resolve: () => {
        throw new Error('EACCES');
      },
    });
    expect(probes.satisfiers['claude/mcp/user/config-entry']).toEqual({ state: 'unprobed' });
  });
});

describe('a session describing a machine we cannot see', () => {
  it('declines the user-scope questions without asking', async () => {
    const { resolve, asked } = recordingResolver();
    const answer = await createServerProbeResolver({ env: 'remote-web', resolve })(
      itemFor('claude/mcp/user/config-entry'),
    );
    expect(answer).toEqual({ state: 'unprobed' });
    expect(asked).toEqual([]);
  });

  it('never states that decline as a state that counts as met', async () => {
    const { resolve } = recordingResolver();
    const { probes } = await collectServerHostSnapshot({ env: 'remote-web', resolve });
    const userScoped = planProbes().filter((item) => item.scope === 'user');
    expect(userScoped.length).toBeGreaterThan(0);
    for (const item of userScoped) {
      expect(probes.satisfiers[item.satisfierId]).toEqual({ state: 'unprobed' });
    }
  });

  it('still answers about the project it is serving', async () => {
    const { resolve, asked } = recordingResolver();
    const answer = await createServerProbeResolver({ env: 'remote-web', resolve })(
      itemFor('claude/mcp/project/config-entry'),
    );
    expect(answer).toEqual({ state: 'satisfied', strictness: ['reclaim-permissive'] });
    expect(asked).toEqual(['claude/mcp/project/config-entry']);
  });

  it('asks about every scope when the files are local', async () => {
    const { resolve, asked } = recordingResolver();
    await collectProbeCoverage(createServerProbeResolver({ env: 'local-web', resolve }));
    expect(asked).toEqual([...PROBEABLE_SATISFIER_IDS]);
  });
});

describe('detection', () => {
  it('claims no agent is present, from either tier', async () => {
    for (const env of ['local-web', 'remote-web'] as const) {
      const { detection } = await collectServerHostSnapshot({ env });
      expect(detection).toEqual({ detected: [], probed: false });
    }
  });
});
