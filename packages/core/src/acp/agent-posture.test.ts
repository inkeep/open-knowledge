import { describe, expect, test } from 'vitest';
import { deriveAgentPosture } from './agent-posture.ts';

const modesOf = (...ids: string[]) => ({
  currentModeId: ids[0] ?? '',
  availableModes: ids.map((id) => ({ id, name: id })),
});

describe('deriveAgentPosture', () => {
  test('verified table wins over declared modes', () => {
    expect(deriveAgentPosture('claude-acp', modesOf('default', 'acceptEdits'))).toBe('asks');
    expect(deriveAgentPosture('claude-acp', null)).toBe('asks');
  });

  test('a permissive current mode demotes a verified asks to self-managed', () => {
    const modes = {
      currentModeId: 'bypassPermissions',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'bypassPermissions', name: 'Bypass Permissions' },
      ],
    };
    expect(deriveAgentPosture('claude-acp', modes)).toBe('self-managed');
    expect(
      deriveAgentPosture('claude-acp', null, { id: 'acceptEdits', name: 'Accept Edits' }),
    ).toBe('self-managed');
    expect(deriveAgentPosture('claude-acp', null, { id: 'default', name: 'Default' })).toBe('asks');
    expect(deriveAgentPosture('pi-acp', null, { id: 'yolo', name: 'YOLO' })).toBe('autonomous');
    expect(deriveAgentPosture('codex-acp', null, { id: 'agent-full-access' })).toBe('self-managed');
  });

  test('verified self-managed and autonomous agents', () => {
    expect(deriveAgentPosture('codex-acp', null)).toBe('self-managed');
    expect(deriveAgentPosture('cursor', null)).toBe('self-managed');
    expect(deriveAgentPosture('pi-acp', null)).toBe('autonomous');
  });

  test('unverified agent with declared modes derives self-managed', () => {
    expect(deriveAgentPosture('some-new-agent', modesOf('plan', 'agent'))).toBe('self-managed');
    expect(deriveAgentPosture('some-new-agent', modesOf('agent'))).toBe('self-managed');
  });

  test('unverified agent without modes is unknown, never autonomous', () => {
    expect(deriveAgentPosture('some-new-agent', null)).toBe('unknown');
    expect(deriveAgentPosture('some-new-agent', undefined)).toBe('unknown');
    expect(deriveAgentPosture('some-new-agent', { currentModeId: '', availableModes: [] })).toBe(
      'unknown',
    );
  });
});
