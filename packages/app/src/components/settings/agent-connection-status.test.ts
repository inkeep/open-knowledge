import {
  AGENT_REGISTRY,
  type AgentId,
  type EnvTier,
  type HostSnapshot,
  type SatisfierId,
  type SurfaceState,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { connectionsFromSnapshot } from './AgentConnectionDialogs';
import {
  deriveRowConnectionStatus,
  deriveRowFollowup,
  followupRowFamily,
  resolvePresence,
} from './agent-connection-status';

function mcpSatisfierId(agentId: AgentId, scope: 'project' | 'user'): SatisfierId {
  const satisfier = AGENT_REGISTRY[agentId].satisfiers.find(
    (candidate) => candidate.piece === 'mcp' && candidate.scope === scope,
  );
  if (satisfier === undefined) throw new Error(`no ${agentId} ${scope} mcp satisfier`);
  return satisfier.id;
}

function skillSatisfierId(agentId: AgentId, scope: 'project' | 'user'): SatisfierId {
  const satisfier = AGENT_REGISTRY[agentId].satisfiers.find(
    (candidate) => candidate.piece === 'skill' && candidate.scope === scope,
  );
  if (satisfier === undefined) throw new Error(`no ${agentId} ${scope} skill satisfier`);
  return satisfier.id;
}

function snapshot(input: {
  states?: Readonly<Record<string, SurfaceState>>;
  detected?: readonly AgentId[];
  probed?: boolean;
  env?: EnvTier;
}): HostSnapshot {
  return {
    probes: {
      env: input.env ?? 'desktop',
      satisfiers: Object.fromEntries(
        Object.entries(input.states ?? {}).map(([id, state]) => [id, { state }]),
      ),
    },
    detection: { detected: input.detected ?? [], probed: input.probed ?? true },
  };
}

describe('deriveRowConnectionStatus', () => {
  test('reads connected when a required tool entry is verifiably present', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'external',
      snapshot: snapshot({
        states: { [mcpSatisfierId('claude', 'project')]: 'satisfied' },
        detected: ['claude'],
      }),
    });
    expect(status).toBe('connected');
  });

  test('reads not-connected when every required tool entry is provably absent', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'external',
      snapshot: snapshot({
        states: {
          [mcpSatisfierId('claude', 'user')]: 'absent',
          [mcpSatisfierId('claude', 'project')]: 'absent',
        },
        detected: ['claude'],
      }),
    });
    expect(status).toBe('not-connected');
  });

  test('reads no-status when the install-state read failed', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'external',
      snapshot: null,
    });
    expect(status).toBe('no-status');
  });

  test('reads no-status when a required user-scope entry was never probed', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude-desktop',
      mode: 'external',
      snapshot: snapshot({ detected: ['claude-desktop'] }),
    });
    expect(status).toBe('no-status');
  });

  test('reads no-status for an unprobed entry even in terminal mode, where the launch gate would count it', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'terminal',
      snapshot: snapshot({ detected: ['claude'] }),
    });
    expect(status).toBe('no-status');
  });

  test('reads not-installed when a probe ran and did not find the tool, even with entries on disk', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'external',
      snapshot: snapshot({
        states: { [mcpSatisfierId('claude', 'project')]: 'satisfied' },
        detected: [],
        probed: true,
      }),
    });
    expect(status).toBe('not-installed');
  });

  test('does not treat an unanswered detection probe as the tool being absent', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'external',
      snapshot: snapshot({
        states: { [mcpSatisfierId('claude', 'project')]: 'satisfied' },
        detected: [],
        probed: false,
      }),
    });
    expect(status).toBe('connected');
  });

  test('stays connected when only a recommended skill is missing', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'external',
      snapshot: snapshot({
        states: {
          [mcpSatisfierId('claude', 'project')]: 'satisfied',
          [skillSatisfierId('claude', 'project')]: 'absent',
          [skillSatisfierId('claude', 'user')]: 'absent',
        },
        detected: ['claude'],
      }),
    });
    expect(status).toBe('connected');
  });

  test('a present recommended skill does not rescue a missing required tool', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'claude',
      mode: 'external',
      snapshot: snapshot({
        states: {
          [mcpSatisfierId('claude', 'user')]: 'absent',
          [mcpSatisfierId('claude', 'project')]: 'absent',
          [skillSatisfierId('claude', 'project')]: 'satisfied',
        },
        detected: ['claude'],
      }),
    });
    expect(status).toBe('not-connected');
  });

  test('reads no-status for an agent assessed in a mode it does not have', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'lm-studio',
      mode: 'terminal',
      snapshot: snapshot({ detected: ['lm-studio'] }),
    });
    expect(status).toBe('no-status');
  });

  test("a row's own probe reporting the tool absent reads not-installed", () => {
    const status = deriveRowConnectionStatus({
      agentId: 'codex',
      mode: 'terminal',
      snapshot: snapshot({
        states: {
          [mcpSatisfierId('codex', 'user')]: 'absent',
          [mcpSatisfierId('codex', 'project')]: 'absent',
        },
      }),
      detected: false,
    });
    expect(status).toBe('not-installed');
  });

  test('an absent tool outranks a fully configured one, so the row says one thing', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'codex',
      mode: 'terminal',
      snapshot: snapshot({
        states: { [mcpSatisfierId('codex', 'user')]: 'satisfied' },
        detected: ['codex'],
      }),
      detected: false,
    });
    expect(status).toBe('not-installed');
  });

  test('an absent tool outranks a failed install-state read', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'codex',
      mode: 'terminal',
      snapshot: null,
      detected: false,
    });
    expect(status).toBe('not-installed');
  });

  test('a probe that has not answered is not a positive absence', () => {
    const status = deriveRowConnectionStatus({
      agentId: 'codex',
      mode: 'terminal',
      snapshot: snapshot({
        states: { [mcpSatisfierId('codex', 'user')]: 'satisfied' },
        detected: ['codex'],
      }),
      detected: null,
    });
    expect(status).toBe('connected');
  });
});

describe('resolvePresence', () => {
  const probed = (detected: readonly AgentId[]): HostSnapshot => ({
    probes: { env: 'desktop', satisfiers: {} },
    detection: { detected: [...detected], probed: true },
  });

  test("the row's own probe wins when it has answered", () => {
    expect(resolvePresence('claude', probed([]), true)).toBe('present');
    expect(resolvePresence('claude', probed(['claude']), false)).toBe('absent');
  });

  test('an unrun detection is unknown, not absent', () => {
    const unprobed: HostSnapshot = {
      probes: { env: 'desktop', satisfiers: {} },
      detection: { detected: [], probed: false },
    };
    expect(resolvePresence('claude', unprobed, null)).toBe('unknown');
    expect(resolvePresence('claude', null, null)).toBe('unknown');
  });

  test('the registry answers for an agent that does not fold, once it has looked', () => {
    expect(resolvePresence('claude', probed([]), null)).toBe('absent');
    expect(resolvePresence('claude', probed(['claude']), null)).toBe('present');
  });
});

describe('deriveRowFollowup', () => {
  const projectCell = (snap: HostSnapshot) =>
    connectionsFromSnapshot(snap).find((c) => c.id === 'claude')?.cells.projectMcp;

  test('returns the project follow-up when the project entry alone meets the requirement', () => {
    const snap = snapshot({
      states: {
        [mcpSatisfierId('claude', 'project')]: 'satisfied',
        [mcpSatisfierId('claude', 'user')]: 'absent',
      },
      detected: ['claude'],
    });
    const ref = deriveRowFollowup({
      agentId: 'claude',
      mode: 'terminal',
      snapshot: snap,
      projectMcp: projectCell(snap),
    });
    expect(ref).toEqual({ id: 'followup.approve-once', params: { agent: 'claude' } });
  });

  test('stays silent when the machine-wide entry already carries the requirement', () => {
    const snap = snapshot({
      states: {
        [mcpSatisfierId('claude', 'project')]: 'satisfied',
        [mcpSatisfierId('claude', 'user')]: 'satisfied',
      },
      detected: ['claude'],
    });
    expect(
      deriveRowFollowup({
        agentId: 'claude',
        mode: 'terminal',
        snapshot: snap,
        projectMcp: projectCell(snap),
      }),
    ).toBeUndefined();
  });

  test('stays silent when the row does not read connected', () => {
    const snap = snapshot({
      states: {
        [mcpSatisfierId('claude', 'project')]: 'absent',
        [mcpSatisfierId('claude', 'user')]: 'absent',
      },
      detected: ['claude'],
    });
    expect(
      deriveRowFollowup({
        agentId: 'claude',
        mode: 'terminal',
        snapshot: snap,
        projectMcp: projectCell(snap),
      }),
    ).toBeUndefined();
    expect(
      deriveRowFollowup({
        agentId: 'claude',
        mode: 'terminal',
        snapshot: null,
        projectMcp: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('followupRowFamily', () => {
  test('a manual enable step belongs to the desktop row, the rest to the terminal row', () => {
    expect(followupRowFamily('enable-manually')).toBe('external');
    expect(followupRowFamily('approve-once')).toBe('terminal');
    expect(followupRowFamily('trust-gated')).toBe('terminal');
    expect(followupRowFamily('none')).toBe('terminal');
  });
});
