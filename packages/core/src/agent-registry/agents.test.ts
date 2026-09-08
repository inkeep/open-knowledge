import { describe, expect, it } from 'vitest';
import { ALL_EDITOR_IDS } from '../constants/editors.ts';
import { AGENT_REGISTRY, ALL_SATISFIERS, getAgentRecord, getSatisfierRecord } from './agents.ts';
import { type AgentId, type AgentMode, ALL_AGENT_IDS, parseSatisfierId } from './ids.ts';
import { parsePathId } from './paths.ts';
import { AgentRecordSchema, type SatisfierRecord } from './schema.ts';

const agents = () => Object.values(AGENT_REGISTRY);

const EXPECTED_MODES: Record<AgentId, AgentMode[]> = {
  claude: ['external', 'terminal', 'acp'],
  'claude-desktop': ['external'],
  cursor: ['external', 'terminal', 'acp'],
  codex: ['external', 'terminal', 'acp'],
  copilot: ['external', 'terminal', 'acp'],
  opencode: ['external', 'terminal', 'acp'],
  openclaw: ['external', 'terminal'],
  pi: ['external', 'terminal', 'acp'],
  antigravity: ['external', 'terminal'],
  'lm-studio': ['external'],
  hermes: ['external', 'terminal'],
  gemini: ['acp'],
};

const EXPECTED_SURFACES: Record<AgentId, string[]> = {
  claude: ['mcp/user', 'mcp/project', 'skill/project', 'skill/user', 'mcp/session'],
  'claude-desktop': ['mcp/user'],
  cursor: ['mcp/user', 'mcp/project', 'skill/project', 'skill/user', 'mcp/session'],
  codex: ['mcp/user', 'mcp/project', 'skill/project', 'skill/user', 'mcp/session'],
  copilot: ['mcp/user', 'mcp/project', 'skill/project', 'skill/user', 'mcp/session'],
  opencode: ['mcp/user', 'mcp/project', 'skill/project', 'skill/user', 'mcp/session'],
  openclaw: ['mcp/user', 'skill/user'],
  pi: ['mcp/project', 'skill/project', 'skill/user'],
  antigravity: ['mcp/user', 'skill/user'],
  'lm-studio': ['mcp/user'],
  hermes: ['mcp/user'],
  gemini: ['mcp/session'],
};

const surfaceKey = (satisfier: SatisfierRecord) => `${satisfier.piece}/${satisfier.scope}`;

describe('curated agent set', () => {
  it('covers the eleven editors plus gemini and nothing else', () => {
    expect(
      agents()
        .map((agent) => agent.id)
        .sort(),
    ).toEqual([...ALL_AGENT_IDS].sort());
    expect(ALL_AGENT_IDS).toEqual([...ALL_EDITOR_IDS, 'gemini']);
    expect(agents()).toHaveLength(12);
  });

  it('gives every agent a unique id that matches its key', () => {
    for (const [key, agent] of Object.entries(AGENT_REGISTRY)) {
      expect(agent.id).toBe(key);
    }
    expect(new Set(agents().map((agent) => agent.id)).size).toBe(12);
  });

  it('gives every satisfier a unique id owned by the agent it sits under', () => {
    const ids = ALL_SATISFIERS.map((satisfier) => satisfier.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const agent of agents()) {
      for (const satisfier of agent.satisfiers) {
        expect(satisfier.agent).toBe(agent.id);
      }
    }
  });

  it('parses every record against the schema', () => {
    for (const agent of agents()) {
      expect(() => AgentRecordSchema.parse(agent)).not.toThrow();
    }
  });

  it('looks agents and satisfiers up by id, and returns undefined for anything else', () => {
    expect(getAgentRecord('claude')?.id).toBe('claude');
    expect(getAgentRecord('some-long-tail-agent')).toBeUndefined();
    expect(getSatisfierRecord('claude/mcp/user/config-entry')?.agent).toBe('claude');
    expect(getSatisfierRecord('claude/mcp/nowhere/config-entry')).toBeUndefined();
  });
});

describe('modes', () => {
  it('declares exactly the modes each agent has', () => {
    for (const agent of agents()) {
      expect(Object.keys(agent.modes).sort()).toEqual([...EXPECTED_MODES[agent.id]].sort());
    }
  });

  it('treats Claude Code and Cowork as modes of two agents, not agents of their own', () => {
    const ids: string[] = agents().map((agent) => agent.id);
    expect(ids).not.toContain('claude-code');
    expect(ids).not.toContain('claude-cowork');
    expect(AGENT_REGISTRY.claude.modes.external).toBeDefined();
    expect(AGENT_REGISTRY['claude-desktop'].modes.external).toBeDefined();
    expect(AGENT_REGISTRY['claude-desktop'].modes.terminal).toBeUndefined();
    expect(AGENT_REGISTRY['claude-desktop'].modes.acp).toBeUndefined();
  });

  it('requires MCP and only recommends the skill, in every mode of every agent', () => {
    for (const agent of agents()) {
      for (const mode of Object.values(agent.modes)) {
        const levels = Object.fromEntries(
          mode.requirements.map((requirement) => [requirement.piece, requirement.level]),
        );
        expect(levels).toEqual({ mcp: 'required', skill: 'recommended' });
      }
    }
  });
});

describe('satisfiers', () => {
  it('has exactly the surfaces the mode-applicability rollup records', () => {
    for (const agent of agents()) {
      expect(agent.satisfiers.map(surfaceKey).sort()).toEqual(
        [...EXPECTED_SURFACES[agent.id]].sort(),
      );
    }
  });

  it('shapes every id as agent/piece/scope/kind', () => {
    for (const satisfier of ALL_SATISFIERS) {
      expect(parseSatisfierId(satisfier.id)).toEqual({
        agent: satisfier.agent,
        piece: satisfier.piece,
        scope: satisfier.scope,
        kind: satisfier.kind,
      });
    }
  });

  it('names locations rather than spelling them', () => {
    for (const satisfier of ALL_SATISFIERS) {
      if (satisfier.pathId === undefined) {
        expect(satisfier.kind).toBe('session-injection');
        continue;
      }
      expect(parsePathId(satisfier.pathId)).not.toBeNull();
      expect(satisfier.pathId).not.toMatch(/^[/~]/);
    }
  });

  it('is either probeable with a named strictness or declared unprobeable with a reason', () => {
    for (const satisfier of ALL_SATISFIERS) {
      if (satisfier.probe.mode === 'probeable') {
        expect(satisfier.probe.strictness.length).toBeGreaterThan(0);
      } else {
        expect(satisfier.probe.reason).toBeTruthy();
      }
    }
  });

  it('gives every contested claim a clock', () => {
    const contested = ALL_SATISFIERS.filter(
      (satisfier) => satisfier.attestation.confidence === 'contested',
    );
    expect(contested.length).toBeGreaterThan(0);
    for (const satisfier of contested) {
      expect(satisfier.attestation.verifiedAgainst?.version).toBeTruthy();
      expect(satisfier.attestation.verifiedAgainst?.observedAt).toBeTruthy();
    }
  });
});

describe('Claude Desktop', () => {
  it('carries its user-global MCP entry and nothing else', () => {
    const record = AGENT_REGISTRY['claude-desktop'];
    expect(record.satisfiers).toHaveLength(1);
    expect(record.satisfiers[0]?.id).toBe('claude-desktop/mcp/user/config-entry');
  });

  it('has no skill satisfier anywhere, so its skill requirement is an empty OR-set', () => {
    const record = AGENT_REGISTRY['claude-desktop'];
    expect(record.satisfiers.filter((satisfier) => satisfier.piece === 'skill')).toHaveLength(0);
    const skill = record.modes.external?.requirements.find(
      (requirement) => requirement.piece === 'skill',
    );
    expect(skill?.satisfiedByAny).toEqual([]);
  });
});

describe('the project skill', () => {
  const withProjectSkill = () =>
    agents().filter((agent) =>
      agent.satisfiers.some(
        (satisfier) => satisfier.piece === 'skill' && satisfier.scope === 'project',
      ),
    );

  it('is referenced identically by every mode the agent has', () => {
    for (const agent of withProjectSkill()) {
      const projectSkill = agent.satisfiers.find(
        (satisfier) => satisfier.piece === 'skill' && satisfier.scope === 'project',
      );
      const orSets = Object.values(agent.modes).map(
        (mode) =>
          mode.requirements.find((requirement) => requirement.piece === 'skill')?.satisfiedByAny,
      );
      for (const orSet of orSets) {
        expect(orSet).toContain(projectSkill?.id);
      }
      expect(new Set(orSets.map((orSet) => JSON.stringify(orSet))).size).toBe(1);
    }
  });

  it('never reads as absent in an ACP thread', () => {
    for (const agent of withProjectSkill()) {
      if (agent.modes.acp === undefined) continue;
      const skill = agent.modes.acp.requirements.find(
        (requirement) => requirement.piece === 'skill',
      );
      expect(skill?.satisfiedByAny.length).toBeGreaterThan(0);
    }
  });

  it('depends on the same agent being wired for MCP in the project', () => {
    for (const agent of withProjectSkill()) {
      const projectSkill = agent.satisfiers.find(
        (satisfier) => satisfier.piece === 'skill' && satisfier.scope === 'project',
      );
      const projectMcp = agent.satisfiers.find(
        (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
      );
      expect(projectMcp).toBeDefined();
      expect(projectSkill?.prerequisites).toContain(projectMcp?.id);
    }
  });
});

describe('Copilot', () => {
  const copilot = () => AGENT_REGISTRY.copilot;

  it('takes its project MCP from the workspace file OK writes for Claude', () => {
    const projectMcp = copilot().satisfiers.find(
      (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
    );
    const claudeProjectMcp = AGENT_REGISTRY.claude.satisfiers.find(
      (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
    );
    expect(projectMcp?.pathId).toBe(claudeProjectMcp?.pathId);
    expect(projectMcp?.sharedWith).toContain('claude');
    expect(claudeProjectMcp?.sharedWith).toContain('copilot');
  });

  it('gates its project skill on its own user-global registration', () => {
    const projectSkill = copilot().satisfiers.find(
      (satisfier) => satisfier.piece === 'skill' && satisfier.scope === 'project',
    );
    expect(projectSkill?.prerequisites).toContain('copilot/mcp/user/config-entry');
  });
});

describe('consent classes', () => {
  it('gives Codex and Copilot the one trust-gated class', () => {
    const projectMcp = (id: AgentId) =>
      AGENT_REGISTRY[id].satisfiers.find(
        (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
      );
    expect(projectMcp('codex')?.consentClass).toBe('trust-gated');
    expect(projectMcp('copilot')?.consentClass).toBe('trust-gated');
  });

  it('labels nothing auto-connect', () => {
    for (const satisfier of ALL_SATISFIERS) {
      expect(satisfier.consentClass).not.toBe('auto-connect');
    }
  });

  it('pairs every non-none class with the follow-up it implies', () => {
    for (const satisfier of ALL_SATISFIERS) {
      if (satisfier.consentClass === 'none') continue;
      expect(satisfier.followup?.id).toBe(`followup.${satisfier.consentClass}`);
    }
  });
});

describe('Codex desktop project config', () => {
  it('is contested and leans not-honored until a named build says otherwise', () => {
    const projectMcp = AGENT_REGISTRY.codex.satisfiers.find(
      (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
    );
    expect(projectMcp?.attestation.confidence).toBe('contested');
    expect(projectMcp?.troubleshooting?.params?.honoredByDesktop).toBe(false);
  });
});

describe('Gemini', () => {
  it('is satisfied entirely by what the session hands it', () => {
    const record = AGENT_REGISTRY.gemini;
    expect(record.satisfiers).toHaveLength(1);
    expect(record.satisfiers[0]?.kind).toBe('session-injection');
    expect(record.satisfiers[0]?.probe.mode).toBe('unprobeable');
    expect(record.modes.acp?.requirements.find((r) => r.piece === 'skill')?.satisfiedByAny).toEqual(
      [],
    );
  });
});

describe('LM Studio', () => {
  it('reports why OK cannot finish its install', () => {
    const satisfier = AGENT_REGISTRY['lm-studio'].satisfiers[0];
    expect(satisfier?.installability).toBe('not-installable');
    expect(satisfier?.notInstallableReason).toBe('no-non-interactive-verb');
  });

  it('claims no detection signal, because it has none OK can ask about', () => {
    expect(AGENT_REGISTRY['lm-studio'].detectionSources).toEqual([]);
    expect(AGENT_REGISTRY['lm-studio'].offerOnlyWhenDetected).toBe(true);
  });
});

describe('Pi', () => {
  it('is satisfied by its managed bridge file in every mode, injection included', () => {
    const record = AGENT_REGISTRY.pi;
    expect(record.satisfiers.some((satisfier) => satisfier.kind === 'session-injection')).toBe(
      false,
    );
    for (const mode of Object.values(record.modes)) {
      const mcp = mode.requirements.find((requirement) => requirement.piece === 'mcp');
      expect(mcp?.satisfiedByAny).toEqual(['pi/mcp/project/managed-file']);
    }
  });
});

describe('cross-references', () => {
  it('resolves every id an OR-set or a prerequisite names', () => {
    for (const agent of agents()) {
      for (const mode of Object.values(agent.modes)) {
        for (const requirement of mode.requirements) {
          for (const id of requirement.satisfiedByAny) {
            expect(getSatisfierRecord(id), `${agent.id}: ${id}`).toBeDefined();
          }
        }
      }
      for (const satisfier of agent.satisfiers) {
        for (const id of satisfier.prerequisites) {
          expect(getSatisfierRecord(id), `${satisfier.id} needs ${id}`).toBeDefined();
        }
      }
    }
  });

  it('backs every shared-copy claim with a registered agent reading the same file', () => {
    for (const satisfier of ALL_SATISFIERS) {
      for (const peer of satisfier.sharedWith) {
        const record = getAgentRecord(peer);
        expect(record, `${satisfier.id} shares with ${peer}`).toBeDefined();
        expect(
          record?.satisfiers.some((other) => other.pathId === satisfier.pathId),
          `${peer} has no satisfier over ${satisfier.pathId}`,
        ).toBe(true);
      }
    }
  });
});
