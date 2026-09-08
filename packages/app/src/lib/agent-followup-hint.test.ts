import { AGENT_REGISTRY, type GuidanceRef, guidanceId } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { followupHintText } from '@/lib/agent-followup-hint';

function projectMcpFollowup(agent: keyof typeof AGENT_REGISTRY): GuidanceRef | undefined {
  return AGENT_REGISTRY[agent].satisfiers.find(
    (satisfier) => satisfier.piece === 'mcp' && satisfier.scope === 'project',
  )?.followup;
}

describe('followupHintText', () => {
  test("Claude's approve-once hint names the agent and the one-time approval", () => {
    expect(followupHintText(projectMcpFollowup('claude'))).toBe(
      'One more step: run Claude in this project and approve OpenKnowledge once.',
    );
  });

  test("Cursor's enable-manually hint names the agent in both places", () => {
    expect(followupHintText(projectMcpFollowup('cursor'))).toBe(
      'One more step: enable it in Cursor → Settings → Tools & MCP (Cursor leaves project servers off until you turn them on).',
    );
  });

  test("Codex's trust-gated hint names the agent", () => {
    expect(followupHintText(projectMcpFollowup('codex'))).toBe(
      'Connects automatically the next time you open this project in a trusted Codex session.',
    );
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
      followupHintText({ id: guidanceId('followup.unwritten'), params: { agent: 'claude' } }),
    ).toBeNull();
    expect(followupHintText({ id: guidanceId('followup.approve-once') })).toBeNull();
  });
});
