import { describe, expect, it } from 'vitest';
import { VERIFIED_AGENT_POSTURES } from '../acp/agent-posture.ts';
import { ALL_EDITOR_IDS } from '../constants/editors.ts';
import { TERMINAL_CLI_IDS } from '../handoff/terminal-launch.ts';
import { AGENT_REGISTRY } from './agents.ts';
import {
  ACP_AGENT_EDITOR_ID_MAP,
  ACP_AGENT_HARNESS_CLI_MAP,
  ACP_FEATURED_AGENT_IDS,
  ACP_VERIFIED_POSTURE_MAP,
  agentIdForAcpAgent,
  agentIdForHandoffTarget,
  agentIdForTerminalCli,
  CONNECTION_ROW_AGENT_IDS,
  getAcpFacet,
  KNOWN_HANDOFF_TARGETS,
  projectMcpConsentClass,
  VISIBLE_HANDOFF_TARGETS,
} from './derived-tables.ts';
import type { AgentRecord } from './schema.ts';

const acpAgents: AgentRecord[] = Object.values(AGENT_REGISTRY).filter(
  (record) => record.acp !== undefined,
);

describe('featured ACP agents', () => {
  it('lists exactly the pre-fold shortlist, in display order', () => {
    expect(ACP_FEATURED_AGENT_IDS).toEqual([
      'claude-acp',
      'codex-acp',
      'gemini',
      'cursor',
      'github-copilot-cli',
      'opencode',
    ]);
  });

  it('leaves pi-acp unfeatured, reproducing the drift rather than fixing it', () => {
    expect(ACP_FEATURED_AGENT_IDS).not.toContain('pi-acp');
    expect(ACP_AGENT_EDITOR_ID_MAP['pi-acp']).toBe('pi');
  });

  it('gives every featured agent a distinct position', () => {
    const orders = acpAgents
      .map((record) => record.acp?.featuredOrder)
      .filter((order): order is number => order !== null && order !== undefined);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('ACP agents whose harness already carries OK', () => {
  it('maps exactly the pre-fold editor ids', () => {
    expect(ACP_AGENT_EDITOR_ID_MAP).toEqual({
      'claude-acp': 'claude',
      'codex-acp': 'codex',
      opencode: 'opencode',
      'pi-acp': 'pi',
    });
  });

  it('keeps cursor out, so a configured-but-unapproved entry never stands injection down', () => {
    expect(ACP_AGENT_EDITOR_ID_MAP.cursor).toBeUndefined();
    expect(getAcpFacet('cursor')?.harnessReadsEditorConfig).toBeNull();
  });

  it('keeps gemini and copilot out, so OK always injects for them', () => {
    expect(ACP_AGENT_EDITOR_ID_MAP.gemini).toBeUndefined();
    expect(ACP_AGENT_EDITOR_ID_MAP['github-copilot-cli']).toBeUndefined();
  });

  it('records why each value was declared, cursor included', () => {
    for (const record of acpAgents) {
      const notes = record.acp?.harnessReadsEditorConfigAttestation.evidence.map(
        (entry) => entry.note ?? '',
      );
      expect(notes?.some((note) => note.length > 0)).toBe(true);
    }
    const cursorNotes = getAcpFacet('cursor')?.harnessReadsEditorConfigAttestation.evidence.map(
      (entry) => entry.note ?? '',
    );
    expect(cursorNotes?.join(' ')).toMatch(/needs approval/);
  });
});

describe('ACP harness CLIs', () => {
  it('maps exactly the pre-fold binaries', () => {
    expect(ACP_AGENT_HARNESS_CLI_MAP).toEqual({
      'claude-acp': 'claude',
      'codex-acp': 'codex',
      cursor: 'cursor',
      gemini: 'gemini',
      opencode: 'opencode',
      'pi-acp': 'pi',
    });
  });

  it('keeps cursor here while the editor map excludes it — two different questions', () => {
    expect(ACP_AGENT_HARNESS_CLI_MAP.cursor).toBe('cursor');
    expect(ACP_AGENT_EDITOR_ID_MAP.cursor).toBeUndefined();
  });
});

describe('ACP facet integrity', () => {
  it('carries a facet for exactly the agents that declare an ACP mode', () => {
    const withFacet = acpAgents.map((record) => record.id).sort();
    const withMode = Object.values(AGENT_REGISTRY)
      .filter((record) => record.modes.acp !== undefined)
      .map((record) => record.id)
      .sort();
    expect(withFacet).toEqual(withMode);
    expect(withFacet).toHaveLength(7);
  });

  it('gives every ACP agent a distinct catalog id', () => {
    const ids = acpAgents.map((record) => record.acp?.acpAgentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves a catalog id back to its facet, and nothing for a stranger', () => {
    expect(getAcpFacet('claude-acp')?.harnessCli).toBe('claude');
    expect(getAcpFacet('some-long-tail-agent')).toBeUndefined();
  });
});

describe('verified ACP permission postures', () => {
  it('maps exactly the pre-fold four', () => {
    expect(ACP_VERIFIED_POSTURE_MAP).toEqual({
      'claude-acp': 'asks',
      'codex-acp': 'self-managed',
      cursor: 'self-managed',
      'pi-acp': 'autonomous',
    });
  });

  it('leaves every unobserved agent absent, so nobody reads as never-asks by default', () => {
    for (const record of acpAgents) {
      const acpAgentId = record.acp?.acpAgentId ?? '';
      if (record.acp?.verifiedPosture !== null) continue;
      expect(ACP_VERIFIED_POSTURE_MAP[acpAgentId]).toBeUndefined();
    }
    expect(ACP_VERIFIED_POSTURE_MAP.gemini).toBeUndefined();
    expect(ACP_VERIFIED_POSTURE_MAP['github-copilot-cli']).toBeUndefined();
  });

  it('is what the posture helper reads, so the two can never disagree', () => {
    expect(VERIFIED_AGENT_POSTURES).toBe(ACP_VERIFIED_POSTURE_MAP);
  });
});

describe('project MCP consent classes', () => {
  const beforeFold: Record<string, string> = {
    claude: 'approve-once',
    cursor: 'enable-manually',
    codex: 'auto-connect',
  };

  it('resolves the same class for every editor the pre-fold table left alone', () => {
    for (const id of ALL_EDITOR_IDS) {
      if (id === 'codex' || id === 'copilot') continue;
      expect(projectMcpConsentClass(id)).toBe(beforeFold[id] ?? 'none');
    }
  });

  it('replaces codex auto-connect with the shared trust gate copilot also carries', () => {
    expect(beforeFold.codex).toBe('auto-connect');
    expect(projectMcpConsentClass('codex')).toBe('trust-gated');
    expect(beforeFold.copilot).toBeUndefined();
    expect(projectMcpConsentClass('copilot')).toBe('trust-gated');
  });

  it('pins the whole per-editor map, so an unannounced flip fails here', () => {
    const map = Object.fromEntries(ALL_EDITOR_IDS.map((id) => [id, projectMcpConsentClass(id)]));
    expect(map).toEqual({
      claude: 'approve-once',
      'claude-desktop': 'none',
      cursor: 'enable-manually',
      codex: 'trust-gated',
      copilot: 'trust-gated',
      opencode: 'none',
      openclaw: 'none',
      pi: 'none',
      antigravity: 'none',
      'lm-studio': 'none',
      hermes: 'none',
    });
  });

  it('answers none for an editor the registry says nothing about', () => {
    expect(projectMcpConsentClass('not-an-editor')).toBe('none');
  });

  it('gives every trust-gated project entry a follow-up that names its own agent', () => {
    const trustGated = ALL_EDITOR_IDS.filter((id) => projectMcpConsentClass(id) === 'trust-gated');
    expect(trustGated).toEqual(['codex', 'copilot']);
    for (const id of trustGated) {
      const record = Object.values(AGENT_REGISTRY).find((candidate) => candidate.id === id);
      const projectMcp = record?.satisfiers.find(
        (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
      );
      expect(projectMcp?.followup).toEqual({ id: 'followup.trust-gated', params: { agent: id } });
    }
  });

  it('never leaves two project MCP satisfiers disagreeing about the consent step', () => {
    for (const record of Object.values(AGENT_REGISTRY)) {
      const classes = record.satisfiers
        .filter(
          (satisfier) =>
            satisfier.piece === 'mcp' &&
            satisfier.scope === 'project' &&
            satisfier.consentClass !== 'none',
        )
        .map((satisfier) => satisfier.consentClass);
      expect(new Set(classes).size).toBeLessThanOrEqual(1);
    }
  });
});

describe('handoff targets', () => {
  const PRE_FOLD_KNOWN_TARGETS = [
    {
      id: 'claude-cowork',
      displayName: 'Claude Cowork',
      appBrandName: 'Claude Desktop',
      schemes: ['claude:'],
      installUrl: 'https://claude.com/download',
      tagline: "Conversational pairing in Claude Desktop's Cowork tab.",
    },
    {
      id: 'claude-code',
      displayName: 'Claude',
      appBrandName: 'Claude Desktop',
      schemes: ['claude:'],
      installUrl: 'https://claude.com/download',
      tagline: "Agentic coding in Claude Desktop's Code tab.",
    },
    {
      id: 'codex',
      displayName: 'ChatGPT',
      appBrandName: 'ChatGPT Desktop',
      schemes: ['codex:'],
      installUrl: 'https://developers.openai.com/codex/app',
      tagline: "OpenAI's ChatGPT desktop app, home of the Codex agent.",
    },
    {
      id: 'cursor',
      displayName: 'Cursor',
      schemes: ['cursor:'],
      installUrl: 'https://cursor.com/',
      tagline: 'AI-first VS Code fork with multi-file edits.',
    },
    {
      id: 'copilot',
      displayName: 'GitHub Copilot',
      schemes: [],
      installUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
      tagline: "GitHub's terminal-native coding agent.",
    },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      schemes: [],
      installUrl: 'https://opencode.ai',
      tagline: 'Open-source terminal coding agent; bring any local model.',
    },
    {
      id: 'pi',
      displayName: 'Pi',
      schemes: [],
      installUrl: 'https://pi.dev',
      tagline: 'Minimal open-source terminal coding agent, extensible in TypeScript.',
    },
    {
      id: 'antigravity',
      displayName: 'Antigravity',
      schemes: [],
      installUrl: 'https://antigravity.google',
      tagline: "Google's agentic IDE + `agy` terminal agent.",
    },
    {
      id: 'openclaw',
      displayName: 'OpenClaw',
      schemes: [],
      installUrl: 'https://openclaw.ai',
      tagline: 'Open-source agent gateway; runs agents against your MCP servers.',
    },
    {
      id: 'hermes',
      displayName: 'Hermes',
      schemes: [],
      installUrl: 'https://hermes-agent.nousresearch.com',
      tagline: "Nous Research's terminal coding agent.",
    },
  ];

  const externalFacets = Object.values(AGENT_REGISTRY).flatMap((record) =>
    record.external === undefined ? [] : [record.external],
  );

  it('reproduces the pre-fold target list — membership, order and display data', () => {
    expect(KNOWN_HANDOFF_TARGETS).toStrictEqual(PRE_FOLD_KNOWN_TARGETS);
  });

  it('shows exactly the three GUI targets', () => {
    expect(VISIBLE_HANDOFF_TARGETS.map((target) => target.id)).toEqual([
      'claude-code',
      'codex',
      'cursor',
    ]);
  });

  it('keeps claude-cowork dispatchable by id while rendering it nowhere', () => {
    expect(KNOWN_HANDOFF_TARGETS.some((target) => target.id === 'claude-cowork')).toBe(true);
    expect(VISIBLE_HANDOFF_TARGETS.some((target) => target.id === 'claude-cowork')).toBe(false);
  });

  it('holds the visible entries by reference, not by copy', () => {
    for (const target of VISIBLE_HANDOFF_TARGETS) {
      expect(KNOWN_HANDOFF_TARGETS).toContain(target);
    }
  });

  it('never shows a target with no scheme to open', () => {
    for (const facet of externalFacets) {
      if (facet.schemes.length === 0) expect(facet.visible).toBe(false);
    }
  });

  it('gives every target a distinct position', () => {
    const orders = externalFacets.map((facet) => facet.knownOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('leaves the two agents OK cannot open without a target', () => {
    expect(AGENT_REGISTRY['lm-studio']?.external).toBeUndefined();
    expect(AGENT_REGISTRY.gemini?.external).toBeUndefined();
  });
});

describe('dispatch-id reverse lookup', () => {
  it('maps every ACP catalog id back to the agent that declared it', () => {
    for (const record of acpAgents) {
      const acpAgentId = record.acp?.acpAgentId;
      if (acpAgentId === undefined) continue;
      expect(agentIdForAcpAgent(acpAgentId)).toBe(record.id);
    }
  });

  it('maps every deep-link target back to the agent that declared it', () => {
    for (const target of KNOWN_HANDOFF_TARGETS) {
      expect(agentIdForHandoffTarget(target.id)).toBeDefined();
    }
    expect(agentIdForHandoffTarget('claude-cowork')).toBe('claude-desktop');
    expect(agentIdForHandoffTarget('claude-code')).toBe('claude');
  });

  it('keeps the catalog id space distinct from the registry id space', () => {
    expect(agentIdForAcpAgent('claude-acp')).toBe('claude');
    expect(agentIdForAcpAgent('codex-acp')).toBe('codex');
    expect(agentIdForAcpAgent('github-copilot-cli')).toBe('copilot');
  });

  it('answers undefined for a long-tail agent the registry never saw', () => {
    expect(agentIdForAcpAgent('auggie')).toBeUndefined();
    expect(agentIdForAcpAgent('cline')).toBeUndefined();
    expect(agentIdForAcpAgent('claude')).toBeUndefined();
  });
});

describe('terminal CLI reverse lookup', () => {
  it('maps every docked-terminal CLI to an agent that has the terminal mode', () => {
    for (const cli of TERMINAL_CLI_IDS) {
      const agentId = agentIdForTerminalCli(cli);
      expect(agentId).toBeDefined();
      expect(AGENT_REGISTRY[agentId as keyof typeof AGENT_REGISTRY]?.modes.terminal).toBeDefined();
    }
  });

  it('covers the launch recipes exactly, in both directions', () => {
    const withTerminalMode = Object.values(AGENT_REGISTRY)
      .filter((record) => record.modes.terminal !== undefined)
      .map((record) => record.id)
      .sort();
    expect(withTerminalMode).toEqual([...TERMINAL_CLI_IDS].sort());
  });

  it('declines an agent the dock has no launch recipe for', () => {
    expect(agentIdForTerminalCli('lm-studio')).toBeUndefined();
    expect(agentIdForTerminalCli('claude-desktop')).toBeUndefined();
    expect(agentIdForTerminalCli('gemini')).toBeUndefined();
  });

  it('answers undefined for an id from outside the registry', () => {
    expect(agentIdForTerminalCli('auggie')).toBeUndefined();
    expect(agentIdForTerminalCli('')).toBeUndefined();
  });
});

describe('CONNECTION_ROW_AGENT_IDS', () => {
  it('lists every editor id that earns a row; Claude Desktop earns none', () => {
    expect([...CONNECTION_ROW_AGENT_IDS]).toEqual([
      'claude',
      'cursor',
      'codex',
      'copilot',
      'opencode',
      'openclaw',
      'pi',
      'antigravity',
      'lm-studio',
      'hermes',
    ]);
    expect(CONNECTION_ROW_AGENT_IDS).not.toContain('claude-desktop');
  });

  it('reads editor order, so a row cannot move by where its record sits', () => {
    const listed = ALL_EDITOR_IDS.filter((id) => CONNECTION_ROW_AGENT_IDS.includes(id));
    expect([...CONNECTION_ROW_AGENT_IDS]).toEqual(listed);
  });

  it('excludes the one agent with no editor id', () => {
    expect((CONNECTION_ROW_AGENT_IDS as readonly string[]).includes('gemini')).toBe(false);
  });
});
