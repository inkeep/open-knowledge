import { AGENT_REGISTRY, type GuidanceRef, guidanceId } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { followupHintText } from '@/lib/agent-followup-hint';

function projectMcpFollowup(agent: keyof typeof AGENT_REGISTRY): GuidanceRef | undefined {
  return AGENT_REGISTRY[agent].satisfiers.find(
    (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
  )?.followup;
}

describe('followupHintText', () => {
  test("Cursor's enable-manually hint names the agent and the setting OpenKnowledge cannot see", () => {
    expect(followupHintText(projectMcpFollowup('cursor'))).toBe(
      "Cursor keeps project MCP servers off until you turn them on under Customize → MCPs. OpenKnowledge can't see that setting.",
    );
  });

  test('the agents that prompt on their own declare no follow-up to render', () => {
    for (const agent of ['claude', 'codex', 'copilot'] as const) {
      expect(projectMcpFollowup(agent), agent).toBeUndefined();
      expect(followupHintText(projectMcpFollowup(agent)), agent).toBeNull();
    }
  });

  test('the retired approve-once and trust-gated ids render nothing', () => {
    for (const id of ['followup.approve-once', 'followup.trust-gated']) {
      expect(followupHintText({ id: guidanceId(id), params: { agent: 'claude' } }), id).toBeNull();
    }
  });

  test('every follow-up the registry declares resolves to copy', () => {
    const declared = Object.values(AGENT_REGISTRY).flatMap((agent) =>
      agent.satisfiers.flatMap((satisfier) =>
        satisfier.followup === undefined ? [] : [satisfier.followup],
      ),
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const ref of declared) expect(followupHintText(ref)).not.toBeNull();
  });

  test('an unknown id, a missing ref, or a ref without an agent renders nothing', () => {
    expect(followupHintText(undefined)).toBeNull();
    expect(
      followupHintText({ id: guidanceId('followup.unwritten'), params: { agent: 'cursor' } }),
    ).toBeNull();
    expect(followupHintText({ id: guidanceId('followup.enable-manually') })).toBeNull();
  });
});
