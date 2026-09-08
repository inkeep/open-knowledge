import { describe, expect, it } from 'vitest';
import {
  AGENT_REGISTRY,
  ALL_SATISFIERS,
  buildConnectionsView,
  type ConnectionCell,
  type ConnectionRow,
  type ConnectionsView,
  EMPTY_DETECTION_SNAPSHOT,
  EMPTY_PROBE_SNAPSHOT,
  KNOWN_SURFACE_STATES,
  type ProbeSnapshot,
  type SatisfierId,
  STATE_POLICY,
  type SurfaceState,
} from './index.ts';

function snapshotOf(states: Record<string, SurfaceState>): ProbeSnapshot {
  return {
    env: 'desktop',
    satisfiers: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
  };
}

function rowFor(view: ConnectionsView, agentId: string): ConnectionRow {
  const row = view.rows.find((candidate) => candidate.agentId === agentId);
  if (row === undefined) throw new Error(`no row for ${agentId}`);
  return row;
}

function allCells(row: ConnectionRow): ConnectionCell[] {
  return row.scopes.flatMap((scope) => scope.cells);
}

function cellFor(view: ConnectionsView, satisfierId: string): ConnectionCell {
  const cell = view.rows
    .flatMap(allCells)
    .find((candidate) => candidate.satisfierId === satisfierId);
  if (cell === undefined) throw new Error(`no cell for ${satisfierId}`);
  return cell;
}

const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry';
const CLAUDE_USER_MCP = 'claude/mcp/user/config-entry';
const CLAUDE_PROJECT_SKILL = 'claude/skill/project/skill-bundle-copy';
const CLAUDE_USER_SKILL = 'claude/skill/user/skill-bundle-copy';
const COPILOT_PROJECT_MCP = 'copilot/mcp/project/config-entry';
const LM_STUDIO_USER_MCP = 'lm-studio/mcp/user/config-entry';

describe('the shape of the view', () => {
  it('returns a row per registered agent, grouped by scope', () => {
    const view = buildConnectionsView({
      probes: EMPTY_PROBE_SNAPSHOT,
      detection: EMPTY_DETECTION_SNAPSHOT,
    });

    expect(view.rows.map((row) => row.agentId)).toEqual(Object.keys(AGENT_REGISTRY));
    const claude = rowFor(view, 'claude');
    expect(claude.scopes.map((scope) => scope.scope)).toEqual(['project', 'user']);
    expect(allCells(claude).length).toBeGreaterThan(0);
  });

  it('narrows to the agents the caller asked about', () => {
    const view = buildConnectionsView({ agentIds: ['claude', 'codex'] });
    expect(view.rows.map((row) => row.agentId)).toEqual(['claude', 'codex']);
  });

  it('drops an id the registry knows nothing about', () => {
    const view = buildConnectionsView({ agentIds: ['claude', 'some-long-tail-agent'] });
    expect(view.rows.map((row) => row.agentId)).toEqual(['claude']);
  });
});

describe('the checkbox', () => {
  it('is checked exactly when the state counts, for every state there is', () => {
    for (const state of KNOWN_SURFACE_STATES) {
      const view = buildConnectionsView({
        agentIds: ['claude'],
        probes: snapshotOf({ [CLAUDE_PROJECT_MCP]: state }),
      });
      const cell = cellFor(view, CLAUDE_PROJECT_MCP);

      expect(cell.state).toBe(state);
      expect(cell.checked).toBe(STATE_POLICY[state].counts);
      expect(cell.exception).toBe(STATE_POLICY[state].exception);
    }
  });

  it('leaves a state this build has no row for unchecked', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({ [CLAUDE_PROJECT_MCP]: 'invented-by-a-newer-host' }),
    });
    const cell = cellFor(view, CLAUDE_PROJECT_MCP);

    expect(cell.state).toBe('invented-by-a-newer-host');
    expect(cell.checked).toBe(false);
    expect(cell.exception).toBe(STATE_POLICY.unprobed.exception);
  });

  it('renders one control per satisfier, carrying no mode of its own', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({ [CLAUDE_PROJECT_MCP]: 'unprobed' }),
    });
    const matches = allCells(rowFor(view, 'claude')).filter(
      (cell) => cell.satisfierId === CLAUDE_PROJECT_MCP,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.checked).toBe(STATE_POLICY.unprobed.counts);
    expect(Object.keys(matches[0] ?? {})).not.toContain('mode');
  });
});

describe('what does and does not become a cell', () => {
  it('never renders a satisfier that exists only while a session is open', () => {
    const view = buildConnectionsView({});
    const rendered = new Set(view.rows.flatMap(allCells).map((cell) => cell.satisfierId));

    const sessionIds = ALL_SATISFIERS.filter(
      (satisfier) => satisfier.kind === 'session-injection',
    ).map((satisfier) => satisfier.id);

    expect(sessionIds.length).toBeGreaterThan(0);
    for (const id of sessionIds) expect(rendered.has(id)).toBe(false);
  });

  it('renders every disk-backed satisfier the registry declares', () => {
    const view = buildConnectionsView({});
    const rendered = new Set(view.rows.flatMap(allCells).map((cell) => cell.satisfierId));

    for (const satisfier of ALL_SATISFIERS) {
      if (satisfier.kind === 'session-injection') continue;
      expect(rendered.has(satisfier.id)).toBe(true);
    }
  });

  it('gives an agent with no on-disk surface no cells at all', () => {
    const view = buildConnectionsView({ agentIds: ['gemini'] });
    const gemini = rowFor(view, 'gemini');

    expect(allCells(gemini)).toEqual([]);
  });
});

describe('a surface that is not there', () => {
  it('reports structural-na on the row rather than dropping its cells', () => {
    const structural = Object.fromEntries(
      AGENT_REGISTRY.claude.satisfiers
        .filter((satisfier) => satisfier.kind !== 'session-injection')
        .map((satisfier) => [satisfier.id, 'structural-na' as SurfaceState]),
    );
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf(structural),
      detection: EMPTY_DETECTION_SNAPSHOT,
    });
    const claude = rowFor(view, 'claude');

    expect(allCells(claude).length).toBeGreaterThan(0);
    for (const cell of allCells(claude)) {
      expect(cell.enabled).toBe(false);
      expect(cell.disabledReason).toBe('structural-na');
    }
  });
});

describe('something nobody found', () => {
  it('folds an undetected satisfier instead of calling it a failure', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({ [CLAUDE_USER_MCP]: 'undetected' }),
    });
    const cell = cellFor(view, CLAUDE_USER_MCP);

    expect(cell.folded).toBe(true);
    expect(cell.exception).toBeNull();
    expect(cell.checked).toBe(false);
  });

  it('folds a row for an agent the registry only offers once it is proven', () => {
    const view = buildConnectionsView({
      agentIds: ['lm-studio'],
      detection: { detected: ['claude'], probed: true },
    });
    const row = rowFor(view, 'lm-studio');

    expect(AGENT_REGISTRY['lm-studio'].offerOnlyWhenDetected).toBe(true);
    expect(row.detected).toBe(false);
    expect(row.folded).toBe(true);
  });

  it('claims nothing about an agent nobody looked for', () => {
    const view = buildConnectionsView({
      agentIds: ['lm-studio'],
      detection: EMPTY_DETECTION_SNAPSHOT,
    });
    const row = rowFor(view, 'lm-studio');

    expect(row.detected).toBeNull();
    expect(row.folded).toBe(false);
  });
});

describe('a control the user may not use', () => {
  it('offers a replaceable foreign entry as an unchecked overwrite, chip on', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({ [CLAUDE_PROJECT_MCP]: 'foreign-replaceable' }),
    });
    const cell = cellFor(view, CLAUDE_PROJECT_MCP);

    expect(cell.enabled).toBe(true);
    expect(cell.disabledReason).toBeNull();
    expect(cell.exception).toBe('warning');
    expect(cell.checked).toBe(false);
  });

  it('keeps a foreign entry off where the writer would merge into it', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({ [CLAUDE_PROJECT_MCP]: 'foreign' }),
    });
    const cell = cellFor(view, CLAUDE_PROJECT_MCP);

    expect(cell.enabled).toBe(false);
    expect(cell.disabledReason).toBe('foreign');
    expect(cell.exception).toBe('warning');
    expect(cell.checked).toBe(false);
  });

  it('names the artifact a gated cell is waiting on', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({
        [CLAUDE_PROJECT_MCP]: 'absent',
        [CLAUDE_PROJECT_SKILL]: 'absent',
      }),
    });
    const skill = cellFor(view, CLAUDE_PROJECT_SKILL);

    expect(skill.enabled).toBe(true);
    expect(skill.disabledReason).toBe(null);
    expect(skill.unmetPrerequisites).toContain(CLAUDE_PROJECT_MCP as SatisfierId);
  });

  it('lets the prerequisite itself stay actionable, or the gate could never clear', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({
        [CLAUDE_PROJECT_MCP]: 'absent',
        [CLAUDE_PROJECT_SKILL]: 'absent',
      }),
    });

    expect(cellFor(view, CLAUDE_PROJECT_MCP).enabled).toBe(true);
  });

  it('opens the gate once the prerequisite is in place', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({
        [CLAUDE_PROJECT_MCP]: 'satisfied',
        [CLAUDE_PROJECT_SKILL]: 'absent',
      }),
    });
    const skill = cellFor(view, CLAUDE_PROJECT_SKILL);

    expect(skill.unmetPrerequisites).toEqual([]);
    expect(skill.enabled).toBe(true);
    expect(skill.disabledReason).toBeNull();
  });

  it('does not offer to install what OK has no way to install', () => {
    const view = buildConnectionsView({
      agentIds: ['lm-studio'],
      probes: snapshotOf({ [LM_STUDIO_USER_MCP]: 'absent' }),
      detection: { detected: ['lm-studio'], probed: true },
    });
    const cell = cellFor(view, LM_STUDIO_USER_MCP);

    expect(cell.installability).toBe('not-installable');
    expect(cell.enabled).toBe(false);
    expect(cell.disabledReason).toBe('not-installable');
  });
});

describe('one artifact serving several agents', () => {
  it('gives every agent that reads it a cell over the same file', () => {
    const view = buildConnectionsView({
      agentIds: ['claude', 'copilot'],
      probes: snapshotOf({
        [CLAUDE_PROJECT_MCP]: 'satisfied',
        [COPILOT_PROJECT_MCP]: 'satisfied',
      }),
    });

    const claudeCell = cellFor(view, CLAUDE_PROJECT_MCP);
    const copilotCell = cellFor(view, COPILOT_PROJECT_MCP);

    expect(claudeCell.pathId).toBe(copilotCell.pathId);
    expect(claudeCell.sharedWith).toContain('copilot');
    expect(copilotCell.sharedWith).toContain('claude');
    expect(claudeCell.checked).toBe(true);
    expect(copilotCell.checked).toBe(true);
  });
});

describe('how a row and a scope read at a glance', () => {
  const checkedCount = (row: ConnectionRow): number =>
    allCells(row).filter((cell) => cell.checked).length;
  const actionableCount = (row: ConnectionRow): number =>
    allCells(row).filter((cell) => !cell.folded && cell.state !== 'structural-na').length;

  const everySatisfier = (state: SurfaceState): Record<string, SurfaceState> =>
    Object.fromEntries(AGENT_REGISTRY.claude.satisfiers.map((satisfier) => [satisfier.id, state]));

  it('reads as connected when everything actionable is in place', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf(everySatisfier('satisfied')),
    });
    const row = rowFor(view, 'claude');

    expect(actionableCount(row)).toBeGreaterThan(0);
    expect(checkedCount(row)).toBe(actionableCount(row));
  });

  it('reads as not-configured when none of it is', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf(everySatisfier('absent')),
    });
    const row = rowFor(view, 'claude');

    expect(actionableCount(row)).toBeGreaterThan(0);
    expect(checkedCount(row)).toBe(0);
  });

  it('reads as partial when one piece of a scope is missing', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({
        ...everySatisfier('satisfied'),
        [CLAUDE_USER_SKILL]: 'absent',
      }),
    });
    const row = rowFor(view, 'claude');
    const user = row.scopes.find((scope) => scope.scope === 'user');

    const userCells = user?.cells ?? [];
    expect(userCells.some((cell) => cell.checked)).toBe(true);
    expect(userCells.some((cell) => !cell.checked)).toBe(true);
  });
});

describe('degraded input', () => {
  const garbage: unknown[] = [
    undefined,
    null,
    42,
    'a string',
    { env: 'desktop' },
    { env: 'desktop', satisfiers: null },
    { satisfiers: { [CLAUDE_PROJECT_MCP]: 'not an object' } },
    { satisfiers: { [CLAUDE_PROJECT_MCP]: { state: 7 } } },
  ];

  it('never throws, whatever the snapshot turns out to be', () => {
    for (const value of garbage) {
      expect(() =>
        buildConnectionsView({
          probes: value as ProbeSnapshot,
          detection: value as never,
        }),
      ).not.toThrow();
    }
  });

  it('never throws when the caller asks with something that is not a list', () => {
    expect(() => buildConnectionsView({ agentIds: 'claude' as never })).not.toThrow();
    expect(() => buildConnectionsView({ agentIds: [null, 3] as never })).not.toThrow();
    expect(buildConnectionsView({ agentIds: [null, 3] as never }).rows).toEqual([]);
  });

  it('degrades every probeable satisfier to unprobed rather than to absent', () => {
    const view = buildConnectionsView({ agentIds: ['claude'], probes: null });

    for (const cell of allCells(rowFor(view, 'claude'))) {
      expect(cell.state).toBe('unprobed');
      expect(cell.checked).toBe(false);
    }
  });
});
