import { describe, expect, it } from 'vitest';
import {
  AGENT_REGISTRY,
  type DetectionSnapshot,
  EMPTY_DETECTION_SNAPSHOT,
  EMPTY_PROBE_SNAPSHOT,
  type InstallChoice,
  type InstallChoices,
  KNOWN_SURFACE_STATES,
  listInstallChoices,
  type ProbeSnapshot,
  STATE_POLICY,
  type SurfaceState,
} from './index.ts';

function snapshotOf(states: Record<string, SurfaceState>): ProbeSnapshot {
  return {
    env: 'desktop',
    satisfiers: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
  };
}

function probedDetection(detected: DetectionSnapshot['detected']): DetectionSnapshot {
  return { detected, probed: true };
}

function choiceFor(result: InstallChoices, satisfierId: string): InstallChoice {
  const choice = result.choices.find((candidate) => candidate.satisfierId === satisfierId);
  if (choice === undefined) throw new Error(`no choice for ${satisfierId}`);
  return choice;
}

const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry';
const CLAUDE_USER_MCP = 'claude/mcp/user/config-entry';
const COPILOT_PROJECT_SKILL = 'copilot/skill/project/skill-bundle-copy';
const GEMINI_SESSION_MCP = 'gemini/mcp/session/session-injection';
const HERMES_USER_MCP = 'hermes/mcp/user/config-entry';
const LM_STUDIO_USER_MCP = 'lm-studio/mcp/user/config-entry';

describe('what a choice carries', () => {
  it('names the audience an artifact serves once it exists', () => {
    const result = listInstallChoices('claude', 'mcp');

    expect(choiceFor(result, CLAUDE_USER_MCP).audience).toBe('this-user');
    expect(choiceFor(result, CLAUDE_PROJECT_MCP).audience).toBe('this-project');
  });

  it('carries the installability of every option', () => {
    const claude = listInstallChoices('claude', 'mcp');
    for (const choice of claude.choices) {
      expect(choice.installability).toBe('installable');
    }
    expect(
      choiceFor(listInstallChoices('lm-studio', 'mcp'), LM_STUDIO_USER_MCP).installability,
    ).toBe('not-installable');
  });

  it('carries the caveat guidance for what the user still owes and what to try', () => {
    const project = choiceFor(listInstallChoices('claude', 'mcp'), CLAUDE_PROJECT_MCP);

    expect(project.consentClass).toBe('approve-once');
    expect(project.caveats.map((ref) => ref.id)).toEqual([
      'followup.approve-once',
      'troubleshooting.claude.project-entry-not-approved',
    ]);
  });

  it('leaves caveats an empty array rather than omitting it', () => {
    const user = choiceFor(listInstallChoices('claude', 'mcp'), CLAUDE_USER_MCP);

    expect(user.caveats).toEqual([]);
  });

  it('says which other agents would read the same artifact', () => {
    const project = choiceFor(listInstallChoices('claude', 'mcp'), CLAUDE_PROJECT_MCP);

    expect(project.sharedWith).toEqual(['copilot']);
  });
});

describe('the claude chooser', () => {
  it('offers exactly two options and highlights neither', () => {
    const result = listInstallChoices('claude', 'mcp');

    expect(result.status).toBe('offer');
    expect(result.choices.map((choice) => choice.satisfierId)).toEqual([
      CLAUDE_USER_MCP,
      CLAUDE_PROJECT_MCP,
    ]);
    expect(result.choices.some((choice) => choice.preferred)).toBe(false);
  });

  it('does not offer the session injection as a third option', () => {
    const result = listInstallChoices('claude', 'mcp');

    expect(result.choices.map((choice) => choice.kind)).toEqual(['config-entry', 'config-entry']);
  });
});

describe('an agent whose piece is handed over by the session', () => {
  it('returns gemini one non-installable injection option', () => {
    const result = listInstallChoices('gemini', 'mcp');

    expect(result.status).toBe('handled');
    expect(result.choices).toHaveLength(1);
    const injection = choiceFor(result, GEMINI_SESSION_MCP);
    expect(injection.kind).toBe('session-injection');
    expect(injection.installability).toBe('not-installable');
    expect(injection.notInstallableReason).toBe('session-scoped');
    expect(injection.installable).toBe(false);
  });
});

describe('an agent OK cannot install for', () => {
  it("records lm-studio's reason as the missing non-interactive verb", () => {
    const choice = choiceFor(listInstallChoices('lm-studio', 'mcp'), LM_STUDIO_USER_MCP);

    expect(choice.installability).toBe('not-installable');
    expect(choice.notInstallableReason).toBe('no-non-interactive-verb');
  });

  it('does not blame a missing CLI or a missing URL scheme', () => {
    const choice = choiceFor(listInstallChoices('lm-studio', 'mcp'), LM_STUDIO_USER_MCP);

    expect(choice.notInstallableReason).not.toBe('no-surface');
    expect(choice.notInstallableReason).not.toBe('session-scoped');
  });

  it('still offers the option so the chooser can explain it', () => {
    const result = listInstallChoices('lm-studio', 'mcp');

    expect(result.status).toBe('offer');
    expect(result.choices).toHaveLength(1);
  });
});

describe('present but not installable', () => {
  it('is present and blocked when the agent is not on this machine', () => {
    const result = listInstallChoices('hermes', 'mcp', {
      probes: snapshotOf({ [HERMES_USER_MCP]: 'satisfied' }),
      detection: probedDetection(['claude']),
    });

    const choice = choiceFor(result, HERMES_USER_MCP);
    expect(choice.present).toBe(true);
    expect(choice.installable).toBe(false);
    expect(choice.blockedReason).toBe('agent-undetected');
  });

  it('stays installable while reporting what it still needs', () => {
    const result = listInstallChoices('copilot', 'skill', {
      probes: snapshotOf({ [COPILOT_PROJECT_SKILL]: 'satisfied' }),
    });

    const choice = choiceFor(result, COPILOT_PROJECT_SKILL);
    expect(choice.present).toBe(true);
    expect(choice.installable).toBe(true);
    expect(choice.blockedReason).toBe(null);
    expect(choice.unmetPrerequisites).toEqual([
      'copilot/mcp/project/config-entry',
      'copilot/mcp/user/config-entry',
    ]);
  });

  it('is installable once nothing stands in the way', () => {
    const result = listInstallChoices('claude', 'mcp', {
      probes: snapshotOf({ [CLAUDE_USER_MCP]: 'absent' }),
      detection: probedDetection(['claude']),
    });

    const choice = choiceFor(result, CLAUDE_USER_MCP);
    expect(choice.present).toBe(false);
    expect(choice.installable).toBe(true);
    expect(choice.blockedReason).toBeNull();
  });

  it('offers an entry somebody else owns as a writable overwrite', () => {
    const result = listInstallChoices('claude', 'mcp', {
      probes: snapshotOf({ [CLAUDE_USER_MCP]: 'foreign-replaceable' }),
    });

    const choice = choiceFor(result, CLAUDE_USER_MCP);
    expect(choice.blockedReason).toBeNull();
    expect(choice.present).toBe(false);
  });

  it('never claims OK can overwrite one a merging writer owns', () => {
    const result = listInstallChoices('claude', 'mcp', {
      probes: snapshotOf({ [CLAUDE_USER_MCP]: 'foreign' }),
    });

    expect(choiceFor(result, CLAUDE_USER_MCP).blockedReason).toBe('foreign');
  });

  it('agrees with the settings authority about what is already in place', () => {
    for (const state of KNOWN_SURFACE_STATES) {
      const result = listInstallChoices('claude', 'mcp', {
        probes: snapshotOf({ [CLAUDE_USER_MCP]: state }),
      });
      expect(choiceFor(result, CLAUDE_USER_MCP).present).toBe(STATE_POLICY[state].counts);
    }
  });
});

describe('when there is nothing to choose between', () => {
  it('reports an unregistered agent with a reason rather than a bare empty list', () => {
    const result = listInstallChoices('some-long-tail-agent', 'mcp');

    expect(result.status).toBe('not-registered');
    expect(result.choices).toEqual([]);
    expect(result.agentId).toBe('some-long-tail-agent');
    expect(result.piece).toBe('mcp');
  });

  it('reports no surface at all when the agent has none of that kind', () => {
    const result = listInstallChoices('gemini', 'skill');

    expect(result.status).toBe('no-surface');
    expect(result.choices).toEqual([]);
  });

  it('reports the surfaces as absent on this machine, still listing them', () => {
    const result = listInstallChoices('claude', 'mcp', {
      probes: snapshotOf({
        [CLAUDE_USER_MCP]: 'structural-na',
        [CLAUDE_PROJECT_MCP]: 'structural-na',
      }),
    });

    expect(result.status).toBe('structurally-absent');
    expect(result.choices).toHaveLength(2);
    for (const choice of result.choices) {
      expect(choice.blockedReason).toBe('structural-na');
    }
  });

  it('still offers when only one of the surfaces is absent', () => {
    const result = listInstallChoices('claude', 'mcp', {
      probes: snapshotOf({ [CLAUDE_USER_MCP]: 'structural-na' }),
    });

    expect(result.status).toBe('offer');
  });
});

describe('degrading rather than throwing', () => {
  it('survives every registered agent and piece with no context at all', () => {
    for (const agentId of Object.keys(AGENT_REGISTRY)) {
      for (const piece of ['mcp', 'skill'] as const) {
        expect(() => listInstallChoices(agentId, piece)).not.toThrow();
      }
    }
  });

  it('survives garbage where a snapshot should be', () => {
    const junk = { env: 'desktop', satisfiers: { [CLAUDE_USER_MCP]: 'nope' } } as unknown;

    const result = listInstallChoices('claude', 'mcp', {
      probes: junk as ProbeSnapshot,
      detection: junk as DetectionSnapshot,
    });

    expect(result.status).toBe('offer');
    expect(choiceFor(result, CLAUDE_USER_MCP).state).toBe('unprobed');
  });

  it('treats a piece it has no vocabulary for as no surface', () => {
    const result = listInstallChoices('claude', 'hologram' as 'mcp');

    expect(result.status).toBe('no-surface');
    expect(result.choices).toEqual([]);
  });

  it('claims nothing about detection when nobody looked', () => {
    const result = listInstallChoices('hermes', 'mcp', {
      probes: EMPTY_PROBE_SNAPSHOT,
      detection: EMPTY_DETECTION_SNAPSHOT,
    });

    expect(choiceFor(result, HERMES_USER_MCP).blockedReason).toBeNull();
  });
});
