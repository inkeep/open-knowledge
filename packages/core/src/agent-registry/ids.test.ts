import { describe, expect, it } from 'vitest';
import { ALL_EDITOR_IDS } from '../constants/editors.ts';
import {
  AGENT_MODES,
  AgentIdSchema,
  ALL_AGENT_IDS,
  isAgentId,
  parseSatisfierId,
  SatisfierIdSchema,
  satisfierId,
} from './ids.ts';

describe('agent ids', () => {
  it('covers every editor plus gemini and nothing else', () => {
    expect([...ALL_AGENT_IDS]).toEqual([...ALL_EDITOR_IDS, 'gemini']);
    expect(ALL_AGENT_IDS).toHaveLength(12);
  });

  it('keeps the schema value-equal to the derived list', () => {
    expect([...AgentIdSchema.options]).toEqual([...ALL_AGENT_IDS]);
  });

  it('recognizes a registry agent and rejects a stranger', () => {
    expect(isAgentId('claude')).toBe(true);
    expect(isAgentId('gemini')).toBe(true);
    expect(isAgentId('some-long-tail-acp-agent')).toBe(false);
  });

  it('has exactly the three modes OK hands work over', () => {
    expect([...AGENT_MODES]).toEqual(['acp', 'terminal', 'external']);
  });
});

describe('satisfier ids', () => {
  it('reads as agent/piece/scope/kind', () => {
    const id = satisfierId({
      agent: 'claude',
      piece: 'mcp',
      scope: 'project',
      kind: 'config-entry',
    });
    expect(id).toBe('claude/mcp/project/config-entry');
  });

  it('round-trips back into its parts', () => {
    const parts = {
      agent: 'lm-studio',
      piece: 'mcp',
      scope: 'user',
      kind: 'config-entry',
    } as const;
    expect(parseSatisfierId(satisfierId(parts))).toEqual(parts);
  });

  it('refuses an id whose parts are not registry vocabulary', () => {
    expect(parseSatisfierId('not-an-agent/mcp/project/config-entry')).toBeNull();
    expect(parseSatisfierId('claude/tools/project/config-entry')).toBeNull();
    expect(parseSatisfierId('claude/mcp/somewhere/config-entry')).toBeNull();
    expect(parseSatisfierId('claude/mcp/project/user-mediated-handoff')).toBeNull();
    expect(parseSatisfierId('claude/mcp/project')).toBeNull();
  });

  it('accepts only the four-part shape at the schema boundary', () => {
    expect(SatisfierIdSchema.safeParse('claude/mcp/project/config-entry').success).toBe(true);
    expect(SatisfierIdSchema.safeParse('claude/mcp/project').success).toBe(false);
    expect(SatisfierIdSchema.safeParse('Claude/MCP/Project/Config').success).toBe(false);
  });
});
