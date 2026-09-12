import { describe, expect, it } from 'vitest';
import { ALL_SATISFIERS } from './agents.ts';
import type { SatisfierId } from './ids.ts';
import {
  buildProbeSnapshot,
  checkProbeCoverage,
  collectProbeCoverage,
  PROBEABLE_SATISFIER_IDS,
  type ProbeResolver,
  type ProbeWorkItem,
  planProbes,
} from './probe-contract.ts';

const EXPECTED_WORK_LIST: readonly string[] = [
  'claude/mcp/user/config-entry',
  'claude/mcp/project/config-entry',
  'claude/skill/project/skill-bundle-copy',
  'claude/skill/user/skill-bundle-copy',
  'claude-desktop/mcp/user/config-entry',
  'cursor/mcp/user/config-entry',
  'cursor/mcp/project/config-entry',
  'cursor/skill/project/skill-bundle-copy',
  'cursor/skill/user/skill-bundle-copy',
  'codex/mcp/user/config-entry',
  'codex/mcp/project/config-entry',
  'codex/skill/project/skill-bundle-copy',
  'codex/skill/user/skill-bundle-copy',
  'copilot/mcp/user/config-entry',
  'copilot/mcp/project/config-entry',
  'copilot/skill/project/skill-bundle-copy',
  'copilot/skill/user/skill-bundle-copy',
  'opencode/mcp/user/config-entry',
  'opencode/mcp/project/config-entry',
  'opencode/skill/project/skill-bundle-copy',
  'opencode/skill/user/skill-bundle-copy',
  'openclaw/mcp/user/config-entry',
  'openclaw/skill/user/central-store-copy',
  'pi/mcp/project/managed-file',
  'pi/skill/project/skill-bundle-copy',
  'pi/skill/user/skill-bundle-copy',
  'antigravity/mcp/user/config-entry',
  'antigravity/skill/user/skill-bundle-copy',
  'lm-studio/mcp/user/config-entry',
  'hermes/mcp/user/config-entry',
];

function itemFor(id: string): ProbeWorkItem {
  const item = planProbes().find((candidate) => candidate.satisfierId === id);
  if (item === undefined) throw new Error(`no work item for ${id}`);
  return item;
}

const answersNothing: ProbeResolver = () => null;

describe('the work list', () => {
  it('names every probeable satisfier and nothing else', () => {
    expect([...PROBEABLE_SATISFIER_IDS]).toEqual(EXPECTED_WORK_LIST);
  });

  it('leaves out satisfiers the registry declares unprobeable', () => {
    const declaredUnprobeable = ALL_SATISFIERS.filter(
      (record) => record.probe.mode === 'unprobeable',
    ).map((record) => record.id);
    expect(declaredUnprobeable.length).toBeGreaterThan(0);
    for (const id of declaredUnprobeable) {
      expect(PROBEABLE_SATISFIER_IDS).not.toContain(id);
    }
  });

  it('carries the path name rather than a path', () => {
    const item = itemFor('claude/mcp/project/config-entry');
    expect(item.pathId).toBe('editor-project-config:claude');
  });

  it('points a shared artifact at one path name from both agents', () => {
    expect(itemFor('copilot/mcp/project/config-entry').pathId).toBe(
      itemFor('claude/mcp/project/config-entry').pathId,
    );
  });

  it('narrows to the agents a caller asked about', () => {
    const planned = planProbes(['hermes']);
    expect(planned.map((item) => item.satisfierId)).toEqual(['hermes/mcp/user/config-entry']);
  });
});

describe('building a snapshot', () => {
  it('carries the environment tier through untouched', async () => {
    const snapshot = await buildProbeSnapshot({ env: 'remote-web', resolve: answersNothing });
    expect(snapshot.env).toBe('remote-web');
  });

  it('keys every planned satisfier even when the host answers none of them', async () => {
    const snapshot = await buildProbeSnapshot({ env: 'desktop', resolve: answersNothing });
    expect(Object.keys(snapshot.satisfiers).sort()).toEqual([...EXPECTED_WORK_LIST].sort());
  });

  it('reads a host with no case for a satisfier as unprobed, never absent', async () => {
    const snapshot = await buildProbeSnapshot({ env: 'desktop', resolve: answersNothing });
    expect(snapshot.satisfiers['claude/mcp/user/config-entry']).toEqual({ state: 'unprobed' });
  });

  it('reads a probe that throws as unprobed, never absent', async () => {
    const snapshot = await buildProbeSnapshot({
      env: 'desktop',
      resolve: () => {
        throw new Error('EACCES');
      },
    });
    expect(snapshot.satisfiers['claude/mcp/user/config-entry']).toEqual({ state: 'unprobed' });
  });

  it('reads a rejected promise as unprobed', async () => {
    const snapshot = await buildProbeSnapshot({
      env: 'desktop',
      resolve: () => Promise.reject(new Error('timed out')),
      agentIds: ['hermes'],
    });
    expect(snapshot.satisfiers['hermes/mcp/user/config-entry']).toEqual({ state: 'unprobed' });
  });

  it('reads an unusable state as unprobed', async () => {
    const snapshot = await buildProbeSnapshot({
      env: 'desktop',
      resolve: () => ({ state: '' }),
      agentIds: ['hermes'],
    });
    expect(snapshot.satisfiers['hermes/mcp/user/config-entry']).toEqual({ state: 'unprobed' });
  });

  it('keeps a state this build has no policy row for', async () => {
    const snapshot = await buildProbeSnapshot({
      env: 'desktop',
      resolve: () => ({ state: 'invented-by-a-newer-host' }),
      agentIds: ['hermes'],
    });
    expect(snapshot.satisfiers['hermes/mcp/user/config-entry']).toEqual({
      state: 'invented-by-a-newer-host',
    });
  });

  it('records the predicates that passed', async () => {
    const snapshot = await buildProbeSnapshot({
      env: 'desktop',
      resolve: () => ({
        state: 'satisfied',
        strictness: ['reclaim-permissive', 'pre-approval-exact'],
      }),
      agentIds: ['claude'],
    });
    expect(snapshot.satisfiers['claude/mcp/user/config-entry']).toEqual({
      state: 'satisfied',
      strictness: ['reclaim-permissive', 'pre-approval-exact'],
    });
  });

  it('drops a predicate the satisfier never declared', async () => {
    expect(itemFor('cursor/mcp/user/config-entry').strictness).toEqual(['reclaim-permissive']);
    const snapshot = await buildProbeSnapshot({
      env: 'desktop',
      resolve: () => ({
        state: 'satisfied',
        strictness: ['pre-approval-exact', 'reclaim-permissive'],
      }),
      agentIds: ['cursor'],
    });
    expect(snapshot.satisfiers['cursor/mcp/user/config-entry']).toEqual({
      state: 'satisfied',
      strictness: ['reclaim-permissive'],
    });
  });

  it('keeps the state when every claimed predicate is dropped', async () => {
    const snapshot = await buildProbeSnapshot({
      env: 'desktop',
      resolve: () => ({ state: 'satisfied', strictness: ['pre-approval-exact'] }),
      agentIds: ['cursor'],
    });
    expect(snapshot.satisfiers['cursor/mcp/user/config-entry']).toEqual({ state: 'satisfied' });
  });
});

describe('coverage', () => {
  it('counts only the satisfiers a resolver actually answers', async () => {
    const covered = await collectProbeCoverage((item) =>
      item.piece === 'skill' ? { state: 'absent' } : null,
    );
    expect(covered.length).toBeGreaterThan(0);
    expect(covered).toContain('claude/skill/user/skill-bundle-copy');
    expect(covered).not.toContain('claude/mcp/user/config-entry');
  });

  it('counts an honest cannot-say as covered', async () => {
    const covered = await collectProbeCoverage(() => ({ state: 'unprobed' }), ['hermes']);
    expect(covered).toEqual(['hermes/mcp/user/config-entry']);
  });

  it('reports nothing missing when every satisfier is answered', () => {
    expect(checkProbeCoverage(PROBEABLE_SATISFIER_IDS)).toEqual({ missing: [], unclaimed: [] });
  });

  it('reports a satisfier no host answers for', () => {
    const short = PROBEABLE_SATISFIER_IDS.filter((id) => id !== 'hermes/mcp/user/config-entry');
    expect(checkProbeCoverage(short).missing).toEqual(['hermes/mcp/user/config-entry']);
  });

  it('reports a key no satisfier claims', () => {
    const report = checkProbeCoverage([
      ...PROBEABLE_SATISFIER_IDS,
      'ghost/mcp/user/config-entry' as SatisfierId,
    ]);
    expect(report.unclaimed).toEqual(['ghost/mcp/user/config-entry']);
    expect(report.missing).toEqual([]);
  });
});
