import { describe, expect, it } from 'vitest';
import { AGENT_REGISTRY } from './agents.ts';
import { CAPABILITY_RECORDS } from './capabilities.ts';
import { AGENT_MODES, type AgentMode, type SatisfierId, satisfierId } from './ids.ts';
import { assessReadiness, isRegisteredAgent, READINESS_VERDICTS } from './readiness.ts';
import type { ProbeSnapshot, SatisfierProbe } from './snapshot.ts';
import type { ProbeStrictness, SurfaceState } from './vocabulary.ts';

const EXACT: readonly ProbeStrictness[] = ['pre-approval-exact'];

function snapshot(entries: Record<string, SatisfierProbe>): ProbeSnapshot {
  return { env: 'desktop', satisfiers: entries };
}

const claudeUserMcp = satisfierId({
  agent: 'claude',
  piece: 'mcp',
  scope: 'user',
  kind: 'config-entry',
});
const claudeProjectMcp = satisfierId({
  agent: 'claude',
  piece: 'mcp',
  scope: 'project',
  kind: 'config-entry',
});
const claudeProjectSkill = satisfierId({
  agent: 'claude',
  piece: 'skill',
  scope: 'project',
  kind: 'skill-bundle-copy',
});
const piProjectMcp = satisfierId({
  agent: 'pi',
  piece: 'mcp',
  scope: 'project',
  kind: 'managed-file',
});
const piProjectSkill = satisfierId({
  agent: 'pi',
  piece: 'skill',
  scope: 'project',
  kind: 'skill-bundle-copy',
});

const requirementFor = (assessment: ReturnType<typeof assessReadiness>, piece: 'mcp' | 'skill') => {
  const found = assessment.requirements.find((requirement) => requirement.piece === piece);
  if (found === undefined) throw new Error(`no ${piece} requirement`);
  return found;
};

const optionFor = (
  assessment: ReturnType<typeof assessReadiness>,
  piece: 'mcp' | 'skill',
  id: SatisfierId,
) => {
  const found = requirementFor(assessment, piece).options.find((option) => option.id === id);
  if (found === undefined) throw new Error(`no option ${id}`);
  return found;
};

describe('verdicts', () => {
  it('answers with a known verdict for every registered agent and mode', () => {
    for (const agent of Object.values(AGENT_REGISTRY)) {
      for (const mode of AGENT_MODES) {
        const assessment = assessReadiness({ agentId: agent.id, mode });
        expect(READINESS_VERDICTS).toContain(assessment.verdict);
      }
    }
  });

  it('reports mode-not-available for a mode the agent does not have', () => {
    const assessment = assessReadiness({ agentId: 'openclaw', mode: 'acp' });
    expect(assessment.verdict).toBe('mode-not-available');
    expect(assessment.requirements).toEqual([]);
    expect(assessment.grantedCapabilities).toEqual([]);
  });

  it('is ready when every requirement is met', () => {
    const assessment = assessReadiness({
      agentId: 'claude',
      mode: 'external',
      probes: snapshot({
        [claudeProjectMcp]: { state: 'satisfied' },
        [claudeProjectSkill]: { state: 'satisfied' },
      }),
    });
    expect(assessment.verdict).toBe('ready');
  });

  it('nudges rather than blocks when only the skill is missing', () => {
    const assessment = assessReadiness({
      agentId: 'claude',
      mode: 'external',
      probes: snapshot({
        [claudeProjectMcp]: { state: 'satisfied' },
        [claudeProjectSkill]: { state: 'absent' },
        [satisfierId({
          agent: 'claude',
          piece: 'skill',
          scope: 'user',
          kind: 'skill-bundle-copy',
        })]: { state: 'absent' },
      }),
    });
    expect(assessment.verdict).toBe('ready-with-nudges');
    expect(requirementFor(assessment, 'mcp').status).toBe('met');
    expect(requirementFor(assessment, 'skill').status).toBe('unmet');
  });

  it('blocks only when the required tools requirement has no counting option', () => {
    const assessment = assessReadiness({
      agentId: 'claude',
      mode: 'external',
      probes: snapshot({
        [claudeUserMcp]: { state: 'absent' },
        [claudeProjectMcp]: { state: 'absent' },
        [claudeProjectSkill]: { state: 'satisfied' },
      }),
    });
    expect(assessment.verdict).toBe('blocked');
    expect(requirementFor(assessment, 'mcp').level).toBe('required');
    expect(requirementFor(assessment, 'skill').status).toBe('met');
  });

  it('ships the evaluated OR-set alongside the verdict', () => {
    const assessment = assessReadiness({ agentId: 'claude', mode: 'terminal' });
    const mcp = requirementFor(assessment, 'mcp');
    expect(mcp.options.map((option) => option.id)).toEqual([claudeUserMcp, claudeProjectMcp]);
    for (const option of mcp.options) {
      expect(typeof option.state).toBe('string');
      expect(typeof option.counts).toBe('boolean');
    }
  });
});

describe('agents outside the curated set', () => {
  it('passes an unknown id through without a verdict against it', () => {
    const assessment = assessReadiness({ agentId: 'some-registry-agent', mode: 'acp' });
    expect(assessment.verdict).toBe('not-registered');
    expect(assessment.requirements).toEqual([]);
    expect(assessment.grantedCapabilities).toEqual([]);
    expect(assessment.modeCaveats).toEqual([]);
  });

  it('never hides an agent it knows nothing about', () => {
    for (const mode of AGENT_MODES) {
      expect(
        assessReadiness({ agentId: 'custom-entry', mode, modeSignal: null }).visibility.show,
      ).toBe(true);
    }
  });

  it('never blocks an unknown id whatever the snapshot says', () => {
    const assessment = assessReadiness({
      agentId: 'unknown-agent',
      mode: 'external',
      probes: snapshot({ [claudeProjectMcp]: { state: 'foreign' } }),
    });
    expect(assessment.verdict).toBe('not-registered');
  });

  it('agrees with its own membership predicate', () => {
    expect(isRegisteredAgent('claude')).toBe(true);
    expect(isRegisteredAgent('some-registry-agent')).toBe(false);
  });
});

describe('how a state rolls up', () => {
  it('counts an entry whose approval we cannot see, and does not warn about it', () => {
    const assessment = assessReadiness({
      agentId: 'claude',
      mode: 'external',
      probes: snapshot({
        [claudeProjectMcp]: { state: 'present-consent-unknown' },
        [claudeProjectSkill]: { state: 'satisfied' },
      }),
    });
    expect(assessment.verdict).toBe('ready');
    expect(optionFor(assessment, 'mcp', claudeProjectMcp).exception).toBe('info');
  });

  it('counts a satisfier the registry declares unprobeable, at unverifiable confidence', () => {
    const assessment = assessReadiness({ agentId: 'gemini', mode: 'acp' });
    const mcp = requirementFor(assessment, 'mcp');
    expect(mcp.status).toBe('met');
    expect(mcp.confidence).toBe('unverifiable');
    expect(mcp.options[0]?.state).toBe('unprobeable');
  });

  it('ignores a host claiming to have probed something declared unprobeable', () => {
    const injection = satisfierId({
      agent: 'gemini',
      piece: 'mcp',
      scope: 'session',
      kind: 'session-injection',
    });
    const assessment = assessReadiness({
      agentId: 'gemini',
      mode: 'acp',
      probes: snapshot({ [injection]: { state: 'satisfied' } }),
    });
    expect(requirementFor(assessment, 'mcp').confidence).toBe('unverifiable');
  });

  it('treats a probeable satisfier missing from the snapshot as unprobed', () => {
    const assessment = assessReadiness({ agentId: 'pi', mode: 'terminal', probes: snapshot({}) });
    expect(optionFor(assessment, 'mcp', piProjectMcp).state).toBe('unprobed');
  });

  it('never reaches verified confidence on an unprobed satisfier', () => {
    const assessment = assessReadiness({ agentId: 'pi', mode: 'terminal', probes: snapshot({}) });
    expect(assessment.verdict).toBe('ready');
    for (const requirement of assessment.requirements) {
      expect(requirement.confidence).toBe('unverified');
    }
  });

  it('prefers a verified option over an unprobed one that also counts', () => {
    const assessment = assessReadiness({
      agentId: 'pi',
      mode: 'terminal',
      probes: snapshot({ [piProjectSkill]: { state: 'satisfied' } }),
    });
    const skill = requirementFor(assessment, 'skill');
    expect(skill.satisfiedBy).toBe(piProjectSkill);
    expect(skill.confidence).toBe('verified');
  });

  it('does not count a foreign entry', () => {
    const assessment = assessReadiness({
      agentId: 'claude',
      mode: 'external',
      probes: snapshot({
        [claudeUserMcp]: { state: 'foreign' },
        [claudeProjectMcp]: { state: 'foreign' },
      }),
    });
    expect(assessment.verdict).toBe('blocked');
    expect(optionFor(assessment, 'mcp', claudeUserMcp).exception).toBe('warning');
  });
});

describe('per-mode resolution of an unanswered probe', () => {
  const modeVerdict = (mode: AgentMode) =>
    assessReadiness({ agentId: 'pi', mode, probes: snapshot({}) }).verdict;

  it('counts it for a terminal launch, which proceeds either way', () => {
    expect(modeVerdict('terminal')).toBe('ready');
  });

  it('counts it for an in-app thread', () => {
    expect(modeVerdict('acp')).toBe('ready');
  });

  it('refuses to count it for a deep link into another app', () => {
    expect(modeVerdict('external')).toBe('blocked');
  });

  it('resolves a state this build has no row for the same way', () => {
    const unknown = { state: 'quantum-entangled' as SurfaceState };
    const external = assessReadiness({
      agentId: 'pi',
      mode: 'external',
      probes: snapshot({ [piProjectMcp]: unknown }),
    });
    const terminal = assessReadiness({
      agentId: 'pi',
      mode: 'terminal',
      probes: snapshot({ [piProjectMcp]: unknown }),
    });
    expect(optionFor(external, 'mcp', piProjectMcp).counts).toBe(false);
    expect(optionFor(terminal, 'mcp', piProjectMcp).counts).toBe(true);
    expect(optionFor(terminal, 'mcp', piProjectMcp).confidence).toBe('unverified');
  });
});

describe('an agent with no surface of a kind', () => {
  it('reports nothing-required rather than a gap', () => {
    const assessment = assessReadiness({
      agentId: 'claude-desktop',
      mode: 'external',
      probes: snapshot({
        [satisfierId({
          agent: 'claude-desktop',
          piece: 'mcp',
          scope: 'user',
          kind: 'config-entry',
        })]: { state: 'satisfied' },
      }),
    });
    const skill = requirementFor(assessment, 'skill');
    expect(skill.status).toBe('nothing-required');
    expect(skill.options).toEqual([]);
    expect(assessment.verdict).toBe('ready');
  });
});

describe('degraded input', () => {
  const garbage = [
    undefined,
    null,
    {},
    { env: 'desktop' },
    { env: 'desktop', satisfiers: null },
    { env: 'desktop', satisfiers: 'nope' },
    { env: 'desktop', satisfiers: { [claudeProjectMcp]: null } },
    { env: 'desktop', satisfiers: { [claudeProjectMcp]: { state: 42 } } },
    { env: 'desktop', satisfiers: { [claudeProjectMcp]: { state: 'satisfied', strictness: 7 } } },
  ];

  it('never throws, whatever the snapshot turns out to be', () => {
    for (const probes of garbage) {
      for (const mode of AGENT_MODES) {
        expect(() =>
          assessReadiness({ agentId: 'claude', mode, probes: probes as ProbeSnapshot }),
        ).not.toThrow();
      }
    }
  });

  it('degrades every probeable satisfier to unprobed', () => {
    const assessment = assessReadiness({
      agentId: 'claude',
      mode: 'external',
      probes: { env: 'desktop', satisfiers: 'nope' } as unknown as ProbeSnapshot,
    });
    for (const option of requirementFor(assessment, 'mcp').options) {
      expect(option.state).toBe('unprobed');
    }
    expect(assessment.verdict).toBe('blocked');
  });

  it('reads a satisfier whose strictness list arrived as the wrong type', () => {
    const assessment = assessReadiness({
      agentId: 'claude',
      mode: 'external',
      probes: {
        env: 'desktop',
        satisfiers: { [claudeProjectMcp]: { state: 'satisfied', strictness: 7 } },
      } as unknown as ProbeSnapshot,
    });
    expect(optionFor(assessment, 'mcp', claudeProjectMcp).state).toBe('satisfied');
    expect(assessment.grantedCapabilities).toEqual([]);
  });
});

describe('visibility', () => {
  it('takes the caller answer when there is one', () => {
    expect(
      assessReadiness({ agentId: 'claude', mode: 'external', modeSignal: false }).visibility,
    ).toMatchObject({ signal: 'os-scheme-handler', resolved: false, show: false });
  });

  it('falls back to the mode policy when the signal did not resolve', () => {
    expect(assessReadiness({ agentId: 'claude', mode: 'terminal' }).visibility).toMatchObject({
      signal: 'harness-cli-on-path',
      resolved: null,
      show: true,
    });
    expect(assessReadiness({ agentId: 'claude', mode: 'external' }).visibility.show).toBe(false);
  });
});

describe('capability grants', () => {
  const grants = (entries: Record<string, SatisfierProbe>) =>
    assessReadiness({ agentId: 'claude', mode: 'terminal', probes: snapshot(entries) })
      .grantedCapabilities;

  it('grants both when the project entry passes the exact predicate', () => {
    expect(
      grants({
        [claudeProjectMcp]: { state: 'satisfied', strictness: EXACT },
        [claudeUserMcp]: { state: 'absent' },
      }),
    ).toEqual(['mcp-preapproval', 'tool-autoapprove']);
  });

  it('grants tool auto-approve, but not pre-approval, from a global entry alone', () => {
    expect(
      grants({
        [claudeUserMcp]: { state: 'satisfied', strictness: EXACT },
        [claudeProjectMcp]: { state: 'absent' },
      }),
    ).toEqual(['tool-autoapprove']);
  });

  it('grants nothing when the other scope was never probed', () => {
    expect(grants({ [claudeProjectMcp]: { state: 'satisfied', strictness: EXACT } })).toEqual([
      'mcp-preapproval',
    ]);
    expect(grants({ [claudeUserMcp]: { state: 'satisfied', strictness: EXACT } })).toEqual([]);
  });

  it('grants nothing when a drifted entry sits alongside a clean one', () => {
    expect(
      grants({
        [claudeProjectMcp]: { state: 'drifted' },
        [claudeUserMcp]: { state: 'satisfied', strictness: EXACT },
      }),
    ).toEqual([]);
  });

  it('grants both when either scope would have done', () => {
    expect(
      grants({
        [claudeUserMcp]: { state: 'satisfied', strictness: EXACT },
        [claudeProjectMcp]: { state: 'satisfied', strictness: EXACT },
      }),
    ).toEqual(['mcp-preapproval', 'tool-autoapprove']);
  });

  it('grants nothing when neither scope has an entry', () => {
    expect(
      grants({ [claudeUserMcp]: { state: 'absent' }, [claudeProjectMcp]: { state: 'absent' } }),
    ).toEqual([]);
  });

  it('grants nothing when a foreign project entry shadows a legitimate global one', () => {
    expect(
      grants({
        [claudeUserMcp]: { state: 'satisfied', strictness: EXACT },
        [claudeProjectMcp]: { state: 'foreign' },
      }),
    ).toEqual([]);
  });

  it('refuses to spend a permissive answer on a decision that requires the exact one', () => {
    expect(
      grants({ [claudeProjectMcp]: { state: 'satisfied', strictness: ['reclaim-permissive'] } }),
    ).toEqual([]);
  });

  it('refuses an exact answer about an entry that does not count', () => {
    expect(grants({ [claudeProjectMcp]: { state: 'drifted', strictness: EXACT } })).toEqual([]);
  });

  it('grants nothing to an agent whose satisfiers never offer the exact predicate', () => {
    const assessment = assessReadiness({
      agentId: 'cursor',
      mode: 'terminal',
      probes: snapshot({
        [satisfierId({ agent: 'cursor', piece: 'mcp', scope: 'project', kind: 'config-entry' })]: {
          state: 'satisfied',
          strictness: EXACT,
        },
      }),
    });
    expect(assessment.grantedCapabilities).toEqual([]);
  });

  it('lists only ids the capability table declares', () => {
    const declared = CAPABILITY_RECORDS.map((record) => record.id);
    for (const agent of Object.values(AGENT_REGISTRY)) {
      for (const mode of AGENT_MODES) {
        for (const id of assessReadiness({ agentId: agent.id, mode }).grantedCapabilities) {
          expect(declared).toContain(id);
        }
      }
    }
  });
});
