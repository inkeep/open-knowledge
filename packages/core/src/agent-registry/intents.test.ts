import { describe, expect, it } from 'vitest';
import {
  type ApplyIntent,
  buildConnectionsView,
  type ConnectionCell,
  type ConnectionsView,
  EMPTY_PROBE_SNAPSHOT,
  type IntentPlan,
  PLAN_CONFLICT_KINDS,
  type PlanConflictKind,
  type ProbeSnapshot,
  planIntents,
  type SatisfierId,
  type SurfaceState,
} from './index.ts';
import { preferredPrerequisite } from './intents.ts';

const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry' as SatisfierId;
const CLAUDE_USER_MCP = 'claude/mcp/user/config-entry' as SatisfierId;
const CLAUDE_PROJECT_SKILL = 'claude/skill/project/skill-bundle-copy' as SatisfierId;
const CLAUDE_USER_SKILL = 'claude/skill/user/skill-bundle-copy' as SatisfierId;
const CLAUDE_SESSION = 'claude/mcp/session/session-injection' as SatisfierId;
const CODEX_USER_SKILL = 'codex/skill/user/skill-bundle-copy' as SatisfierId;
const COPILOT_PROJECT_MCP = 'copilot/mcp/project/config-entry' as SatisfierId;
const COPILOT_USER_MCP = 'copilot/mcp/user/config-entry' as SatisfierId;
const COPILOT_PROJECT_SKILL = 'copilot/skill/project/skill-bundle-copy' as SatisfierId;

function snapshotOf(states: Record<string, SurfaceState>): ProbeSnapshot {
  return {
    env: 'desktop',
    satisfiers: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
  };
}

function viewWith(states: Record<string, SurfaceState> = {}): ConnectionsView {
  return buildConnectionsView({ probes: snapshotOf(states) });
}

function want(satisfierId: SatisfierId, desired: 'present' | 'absent'): ApplyIntent {
  return { satisfierId, desired };
}

function ids(plan: IntentPlan): string[] {
  return plan.steps.map((step) => step.satisfierId);
}

function kinds(plan: IntentPlan): PlanConflictKind[] {
  return plan.conflicts.map((conflict) => conflict.kind);
}

function positionOf(plan: IntentPlan, satisfierId: SatisfierId): number {
  return ids(plan).indexOf(satisfierId);
}

describe('planning a batch', () => {
  it('returns an empty plan for an empty batch', () => {
    const plan = planIntents([], viewWith());

    expect(plan.steps).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.withheld).toEqual([]);
  });

  it('plans one requested artifact with what the executor needs to write it', () => {
    const plan = planIntents(
      [want(CLAUDE_USER_MCP, 'present')],
      viewWith({ [CLAUDE_USER_MCP]: 'absent' }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    const [step] = plan.steps;
    expect(step).toMatchObject({
      satisfierId: CLAUDE_USER_MCP,
      agentId: 'claude',
      piece: 'mcp',
      scope: 'user',
      desired: 'present',
      origin: 'requested',
      state: 'absent',
      installability: 'installable',
      alreadyInDesiredState: false,
      dependsOn: [],
    });
    expect(step?.pathId).toBeDefined();
  });

  it('reports an artifact already in the requested state instead of hiding it', () => {
    const plan = planIntents(
      [want(CLAUDE_USER_MCP, 'present')],
      viewWith({ [CLAUDE_USER_MCP]: 'satisfied' }),
    );

    expect(plan.steps[0]?.alreadyInDesiredState).toBe(true);
  });

  it('collapses the same artifact requested twice the same way', () => {
    const plan = planIntents(
      [want(CLAUDE_USER_SKILL, 'present'), want(CLAUDE_USER_SKILL, 'present')],
      viewWith(),
    );

    expect(ids(plan)).toEqual([CLAUDE_USER_SKILL]);
    expect(plan.conflicts).toEqual([]);
  });
});

describe('ordering by prerequisite', () => {
  it("puts copilot's MCP entries before the skill that needs them", () => {
    const plan = planIntents(
      [
        want(COPILOT_PROJECT_SKILL, 'present'),
        want(COPILOT_PROJECT_MCP, 'present'),
        want(COPILOT_USER_MCP, 'present'),
      ],
      viewWith(),
    );

    expect(plan.conflicts).toEqual([]);
    expect(positionOf(plan, COPILOT_PROJECT_MCP)).toBeLessThan(
      positionOf(plan, COPILOT_PROJECT_SKILL),
    );
    expect(positionOf(plan, COPILOT_USER_MCP)).toBeLessThan(
      positionOf(plan, COPILOT_PROJECT_SKILL),
    );
  });

  it('names the steps a step waits on, so a skipped one can be attributed', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_SKILL, 'present'), want(CLAUDE_PROJECT_MCP, 'present')],
      viewWith(),
    );

    const skill = plan.steps.find((step) => step.satisfierId === CLAUDE_PROJECT_SKILL);
    expect(skill?.dependsOn).toEqual([CLAUDE_PROJECT_MCP]);
  });

  it('adds ONE unmet prerequisite nobody asked for, ordered first and labelled', () => {
    const plan = planIntents([want(COPILOT_PROJECT_SKILL, 'present')], viewWith());

    expect(plan.conflicts).toEqual([]);
    const added = plan.steps.filter((step) => step.origin === 'prerequisite');
    expect(added).toHaveLength(1);
    expect(positionOf(plan, added[0]?.satisfierId as SatisfierId)).toBeLessThan(
      positionOf(plan, COPILOT_PROJECT_SKILL),
    );
  });

  it("prefers the member the agent owns alone over one borrowed from another agent's file", () => {
    const plan = planIntents([want(COPILOT_PROJECT_SKILL, 'present')], viewWith());

    expect(plan.conflicts).toEqual([]);
    expect(ids(plan)).toContain(COPILOT_USER_MCP);
    expect(ids(plan)).not.toContain(COPILOT_PROJECT_MCP);
  });

  it('resolves the OR-set to the one remaining unblocked member', () => {
    const plan = planIntents(
      [want(COPILOT_PROJECT_SKILL, 'present')],
      viewWith({ [COPILOT_USER_MCP]: 'foreign' }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(ids(plan)).toContain(COPILOT_PROJECT_MCP);
    expect(ids(plan)).not.toContain(COPILOT_USER_MCP);
  });

  it('ranks an owned entry that needs no follow-up first, then declaration order', () => {
    const cell = (satisfierId: string, sharedWith: string[], consentClass: string) =>
      ({ satisfierId, sharedWith, consentClass }) as unknown as ConnectionCell;
    const borrowedTrustGated = cell('a', ['claude'], 'trust-gated');
    const ownedApproveOnce = cell('b', [], 'approve-once');
    const ownedPlain = cell('c', [], 'none');
    const ownedPlainLater = cell('d', [], 'none');

    expect(preferredPrerequisite([borrowedTrustGated, ownedApproveOnce, ownedPlain])).toBe(
      ownedPlain,
    );
    expect(preferredPrerequisite([borrowedTrustGated, ownedApproveOnce])).toBe(ownedApproveOnce);
    expect(preferredPrerequisite([ownedPlain, ownedPlainLater])).toBe(ownedPlain);
    expect(preferredPrerequisite([])).toBeUndefined();
  });

  it('adds nothing when one member of the OR-set is already in place', () => {
    const plan = planIntents(
      [want(COPILOT_PROJECT_SKILL, 'present')],
      viewWith({ [COPILOT_USER_MCP]: 'satisfied' }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(ids(plan)).not.toContain(COPILOT_PROJECT_MCP);
    expect(ids(plan)).not.toContain(COPILOT_USER_MCP);
  });

  it('leaves a prerequisite already in place out of the plan', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_SKILL, 'present')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'satisfied' }),
    );

    expect(ids(plan)).toEqual([CLAUDE_PROJECT_SKILL]);
  });

  it('removes a dependent before the thing it depends on', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_MCP, 'absent'), want(CLAUDE_PROJECT_SKILL, 'absent')],
      viewWith({
        [CLAUDE_PROJECT_MCP]: 'satisfied',
        [CLAUDE_PROJECT_SKILL]: 'satisfied',
        [COPILOT_PROJECT_MCP]: 'absent',
      }),
    );

    expect(positionOf(plan, CLAUDE_PROJECT_SKILL)).toBeLessThan(
      positionOf(plan, CLAUDE_PROJECT_MCP),
    );
  });

  it('holds back work whose prerequisite the same batch takes away', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_SKILL, 'present'), want(CLAUDE_PROJECT_MCP, 'absent')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'satisfied', [COPILOT_PROJECT_MCP]: 'satisfied' }),
    );

    expect(kinds(plan)).toContain('prerequisite-removed');
    expect(ids(plan)).not.toContain(CLAUDE_PROJECT_SKILL);
    expect(ids(plan)).not.toContain(CLAUDE_PROJECT_MCP);
  });

  it('refuses to add a prerequisite somebody else owns, and holds back what needed it', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_SKILL, 'present')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'foreign-replaceable' }),
    );

    const conflict = plan.conflicts.find((entry) => entry.kind === 'prerequisite-unavailable');
    expect(conflict?.blockedReason).toBe('foreign-replaceable');
    expect(conflict?.satisfierIds).toEqual([CLAUDE_PROJECT_MCP, CLAUDE_PROJECT_SKILL]);
    expect(plan.steps).toEqual([]);
    expect(plan.withheld).toEqual([CLAUDE_PROJECT_SKILL]);
  });

  it('plans the overwrite when the user ticks the foreign row itself', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_MCP, 'present')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'foreign-replaceable' }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(ids(plan)).toContain(CLAUDE_PROJECT_MCP);
  });
});

describe('artifacts more than one agent reads', () => {
  it('reports a removal that would disconnect an agent the batch never mentioned', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_MCP, 'absent')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'satisfied', [COPILOT_PROJECT_MCP]: 'satisfied' }),
    );

    const conflict = plan.conflicts.find((entry) => entry.kind === 'unresolved-shared-copy');
    expect(conflict?.satisfierIds).toEqual([CLAUDE_PROJECT_MCP, COPILOT_PROJECT_MCP]);
    expect(conflict?.agentIds).toEqual(['claude', 'copilot']);
    expect(conflict?.pathId).toBeDefined();
    expect(plan.steps).toEqual([]);
  });

  it('accepts the removal once the batch says what happens to the peer', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_MCP, 'absent'), want(COPILOT_PROJECT_MCP, 'absent')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'satisfied', [COPILOT_PROJECT_MCP]: 'satisfied' }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(ids(plan)).toHaveLength(2);
  });

  it('leaves a removal alone when no peer is reading the file anyway', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_MCP, 'absent')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'satisfied', [COPILOT_PROJECT_MCP]: 'absent' }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(ids(plan)).toEqual([CLAUDE_PROJECT_MCP]);
  });

  it('will not call a removal safe when the peer is outside the view it was given', () => {
    const view = buildConnectionsView({
      agentIds: ['claude'],
      probes: snapshotOf({ [CLAUDE_PROJECT_MCP]: 'satisfied' }),
    });
    const plan = planIntents([want(CLAUDE_PROJECT_MCP, 'absent')], view);

    expect(kinds(plan)).toContain('unresolved-shared-copy');
    expect(plan.steps).toEqual([]);
  });

  it('refuses to remove through an observed folder alias, naming the agent on the other end', () => {
    const probes: ProbeSnapshot = {
      env: 'desktop',
      satisfiers: {
        [CLAUDE_USER_SKILL]: { state: 'satisfied', sharedWith: ['codex'] },
        [CODEX_USER_SKILL]: { state: 'satisfied', sharedWith: ['claude'] },
      },
    };
    const view = buildConnectionsView({ probes });

    const codexCell = view.rows
      .flatMap((row) => row.scopes.flatMap((scope) => scope.cells))
      .find((cell: ConnectionCell) => cell.satisfierId === CODEX_USER_SKILL);
    expect(codexCell?.sharedFolderWith).toEqual(['claude']);
    expect(codexCell?.sharedWith).toEqual([]);

    const plan = planIntents([want(CODEX_USER_SKILL, 'absent')], view);
    const conflict = plan.conflicts.find((entry) => entry.kind === 'unresolved-shared-copy');
    expect(conflict?.satisfierIds).toEqual([CODEX_USER_SKILL, CLAUDE_USER_SKILL]);
    expect(conflict?.agentIds).toEqual(['codex', 'claude']);
    expect(conflict?.pathId).toBeUndefined();
    expect(plan.steps).toEqual([]);
  });

  it('removes through an observed folder alias once the batch removes the peer too', () => {
    const probes: ProbeSnapshot = {
      env: 'desktop',
      satisfiers: {
        [CLAUDE_USER_SKILL]: { state: 'satisfied', sharedWith: ['codex'] },
        [CODEX_USER_SKILL]: { state: 'satisfied', sharedWith: ['claude'] },
      },
    };
    const view = buildConnectionsView({ probes });

    const plan = planIntents(
      [want(CODEX_USER_SKILL, 'absent'), want(CLAUDE_USER_SKILL, 'absent')],
      view,
    );
    expect(kinds(plan)).not.toContain('unresolved-shared-copy');
    expect(ids(plan)).toEqual([CODEX_USER_SKILL, CLAUDE_USER_SKILL]);
  });

  it('leaves an observed folder alias alone when the peer has nothing installed', () => {
    const probes: ProbeSnapshot = {
      env: 'desktop',
      satisfiers: {
        [CLAUDE_USER_SKILL]: { state: 'absent' },
        [CODEX_USER_SKILL]: { state: 'satisfied', sharedWith: ['claude'] },
      },
    };
    const plan = planIntents([want(CODEX_USER_SKILL, 'absent')], buildConnectionsView({ probes }));
    expect(kinds(plan)).not.toContain('unresolved-shared-copy');
    expect(ids(plan)).toEqual([CODEX_USER_SKILL]);
  });

  it('reports one file asked to be two things', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_MCP, 'present'), want(COPILOT_PROJECT_MCP, 'absent')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'satisfied', [COPILOT_PROJECT_MCP]: 'satisfied' }),
    );

    const conflict = plan.conflicts.find((entry) => entry.kind === 'contradictory-intents');
    expect(conflict?.pathId).toBeDefined();
    expect(conflict?.satisfierIds).toEqual([CLAUDE_PROJECT_MCP, COPILOT_PROJECT_MCP]);
    expect(ids(plan)).not.toContain(CLAUDE_PROJECT_MCP);
    expect(ids(plan)).not.toContain(COPILOT_PROJECT_MCP);
  });

  it('reports one artifact asked to be two things directly', () => {
    const plan = planIntents(
      [want(CLAUDE_USER_MCP, 'present'), want(CLAUDE_USER_MCP, 'absent')],
      viewWith(),
    );

    expect(kinds(plan)).toEqual(['contradictory-intents']);
    expect(plan.steps).toEqual([]);
  });
});

describe('what a conflicted batch still licenses', () => {
  it('licenses nothing: a conflict anywhere withholds the whole batch', () => {
    const plan = planIntents(
      [
        want(CLAUDE_USER_MCP, 'present'),
        want(CLAUDE_USER_MCP, 'absent'),
        want(CLAUDE_USER_SKILL, 'present'),
      ],
      viewWith(),
    );

    expect(kinds(plan)).toEqual(['contradictory-intents']);
    expect(plan.steps).toEqual([]);
    expect(plan.withheld).toEqual([CLAUDE_USER_MCP, CLAUDE_USER_SKILL]);
  });

  it('withholds the untouched artifacts of a removal whose shared copy is unresolved', () => {
    const plan = planIntents(
      [
        want(CLAUDE_PROJECT_MCP, 'absent'),
        want(CLAUDE_USER_MCP, 'absent'),
        want(CLAUDE_USER_SKILL, 'absent'),
      ],
      viewWith({
        [CLAUDE_PROJECT_MCP]: 'satisfied',
        [COPILOT_PROJECT_MCP]: 'satisfied',
        [CLAUDE_USER_MCP]: 'satisfied',
        [CLAUDE_USER_SKILL]: 'satisfied',
      }),
    );

    expect(kinds(plan)).toEqual(['unresolved-shared-copy']);
    expect(plan.steps).toEqual([]);
    expect(plan.withheld).toEqual(
      expect.arrayContaining([CLAUDE_PROJECT_MCP, CLAUDE_USER_MCP, CLAUDE_USER_SKILL]),
    );
  });

  it('holds back a step whose dependency was held back', () => {
    const plan = planIntents(
      [
        want(CLAUDE_PROJECT_MCP, 'present'),
        want(CLAUDE_PROJECT_MCP, 'absent'),
        want(CLAUDE_PROJECT_SKILL, 'present'),
      ],
      viewWith(),
    );

    expect(plan.steps).toEqual([]);
    expect(plan.withheld).toContain(CLAUDE_PROJECT_SKILL);
  });
});

describe('edges that do not resolve', () => {
  it('reports a loop instead of looping', () => {
    const a = 'claude/mcp/project/config-entry' as SatisfierId;
    const b = 'claude/skill/project/skill-bundle-copy' as SatisfierId;
    const view = cyclicView(a, b);

    const plan = planIntents([want(a, 'present'), want(b, 'present')], view);

    const conflict = plan.conflicts.find((entry) => entry.kind === 'prerequisite-cycle');
    expect(conflict?.satisfierIds).toEqual([a, b]);
    expect(plan.steps).toEqual([]);
  });

  it('reports an artifact the view does not carry', () => {
    const plan = planIntents(
      [want('not-an-agent/mcp/user/config-entry' as SatisfierId, 'present')],
      viewWith(),
    );

    expect(kinds(plan)).toEqual(['unknown-satisfier']);
    expect(plan.steps).toEqual([]);
  });

  it('reports a session-only artifact, which no settings view carries', () => {
    const plan = planIntents([want(CLAUDE_SESSION, 'present')], viewWith());

    expect(kinds(plan)).toEqual(['unknown-satisfier']);
  });
});

describe('never throwing', () => {
  const view = viewWith();

  it('tolerates a batch that is not a list', () => {
    expect(planIntents(null, view)).toEqual({ steps: [], conflicts: [], withheld: [] });
    expect(planIntents(undefined, view)).toEqual({ steps: [], conflicts: [], withheld: [] });
    expect(planIntents('nope' as never, view)).toEqual({ steps: [], conflicts: [], withheld: [] });
  });

  it('tolerates a view that is missing or unusable', () => {
    const intents = [want(CLAUDE_USER_MCP, 'present')];

    for (const bad of [null, undefined, {} as ConnectionsView, { rows: 'no' } as never]) {
      const plan = planIntents(intents, bad);
      expect(kinds(plan)).toEqual(['unknown-satisfier']);
      expect(plan.steps).toEqual([]);
    }
  });

  it('reports a submission that is not an intent at all', () => {
    const plan = planIntents(
      [null, { satisfierId: 7 }, { satisfierId: CLAUDE_USER_MCP, desired: 'maybe' }] as never,
      view,
    );

    expect(kinds(plan)).toEqual(['malformed-intent', 'malformed-intent', 'malformed-intent']);
    expect(plan.steps).toEqual([]);
  });

  it('degrades every artifact to unprobed when nobody looked, and still plans', () => {
    const plan = planIntents(
      [want(CLAUDE_USER_MCP, 'present')],
      buildConnectionsView({ probes: EMPTY_PROBE_SNAPSHOT }),
    );

    expect(plan.steps[0]?.state).toBe('unprobed');
    expect(plan.conflicts).toEqual([]);
  });
});

describe('the conflict vocabulary', () => {
  it('has a unique member per pre-save answer', () => {
    expect(new Set(PLAN_CONFLICT_KINDS).size).toBe(PLAN_CONFLICT_KINDS.length);
  });
});

function cyclicView(a: SatisfierId, b: SatisfierId): ConnectionsView {
  const cell = (satisfierId: SatisfierId, prerequisite: SatisfierId): ConnectionCell => ({
    satisfierId,
    agentId: 'claude',
    piece: 'mcp',
    scope: 'project',
    kind: 'config-entry',
    audience: 'this-project',
    state: 'absent',
    checked: false,
    exception: null,
    folded: false,
    enabled: true,
    disabledReason: null,
    sharedWith: [],
    prerequisites: [prerequisite],
    unmetPrerequisites: [prerequisite],
    consentClass: 'none',
    installability: 'installable',
  });

  return {
    rows: [
      {
        agentId: 'claude',
        status: 'not-configured',
        detected: null,
        folded: false,
        setupDocSlug: null,
        scopes: [{ scope: 'project', summary: 'none', cells: [cell(a, b), cell(b, a)] }],
      },
    ],
  };
}

describe('a folder shared with an agent that has no row of its own', () => {
  it('refuses the removal and names the agent even though nothing of theirs can be widened', () => {
    const cursorProjectSkill = 'cursor/skill/project/skill-bundle-copy' as SatisfierId;
    const probes: ProbeSnapshot = {
      env: 'desktop',
      satisfiers: {
        [cursorProjectSkill]: { state: 'satisfied', sharedWith: ['lm-studio'] },
      },
    };
    const plan = planIntents(
      [want(cursorProjectSkill, 'absent')],
      buildConnectionsView({ probes }),
    );

    const conflict = plan.conflicts.find((entry) => entry.kind === 'unresolved-shared-copy');
    expect(conflict?.satisfierIds).toEqual([cursorProjectSkill]);
    expect(conflict?.agentIds).toEqual(['cursor', 'lm-studio']);
    expect(plan.steps).toEqual([]);
  });
});

describe('an OR-set of prerequisites', () => {
  it('lets one satisfied member go when another member stays', () => {
    const plan = planIntents(
      [want(COPILOT_USER_MCP, 'absent')],
      viewWith({
        [COPILOT_PROJECT_MCP]: 'satisfied',
        [CLAUDE_PROJECT_MCP]: 'satisfied',
        [COPILOT_USER_MCP]: 'satisfied',
        [COPILOT_PROJECT_SKILL]: 'satisfied',
      }),
    );

    expect(kinds(plan)).not.toContain('prerequisite-removed');
    expect(ids(plan)).toEqual([COPILOT_USER_MCP]);
  });

  it('still refuses when the batch removes the only member the skill has', () => {
    const plan = planIntents(
      [want(COPILOT_USER_MCP, 'absent'), want(COPILOT_PROJECT_SKILL, 'present')],
      viewWith({ [COPILOT_USER_MCP]: 'satisfied', [COPILOT_PROJECT_MCP]: 'absent' }),
    );

    expect(kinds(plan)).toContain('prerequisite-removed');
    expect(plan.steps).toEqual([]);
  });
});

describe('a directly submitted intent for a blocked cell', () => {
  it('is refused with the reason rather than stepped', () => {
    const plan = planIntents(
      [want(CLAUDE_PROJECT_MCP, 'present')],
      viewWith({ [CLAUDE_PROJECT_MCP]: 'foreign' }),
    );

    const conflict = plan.conflicts.find((entry) => entry.kind === 'blocked-satisfier');
    expect(conflict?.satisfierIds).toEqual([CLAUDE_PROJECT_MCP]);
    expect(conflict?.blockedReason).toBe('foreign');
    expect(plan.steps).toEqual([]);
  });

  it('still lets a removal through for a cell that is merely not installable here', () => {
    const plan = planIntents(
      [want(COPILOT_USER_MCP, 'absent')],
      viewWith({ [COPILOT_USER_MCP]: 'structural-na' }),
    );

    expect(kinds(plan)).not.toContain('blocked-satisfier');
  });
});
