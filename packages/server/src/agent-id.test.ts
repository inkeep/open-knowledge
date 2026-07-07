import { describe, expect, test } from 'bun:test';
import {
  AGENT_ID_MAX_LEN,
  AGENT_ID_RE,
  AGENT_NAME_MAX_LEN,
  parseAgentBodyFields,
  resolveAgentType,
  toBroadcasterKey,
  validateAgentId,
} from './agent-id.ts';

describe('AGENT_ID_RE', () => {
  test('accepts alphanumeric / underscore / hyphen', () => {
    expect(AGENT_ID_RE.test('claude-1')).toBe(true);
    expect(AGENT_ID_RE.test('Agent_42')).toBe(true);
    expect(AGENT_ID_RE.test('a')).toBe(true);
  });

  test('rejects empty + injection-shaped bytes', () => {
    expect(AGENT_ID_RE.test('')).toBe(false);
    expect(AGENT_ID_RE.test('a b')).toBe(false);
    expect(AGENT_ID_RE.test('a/b')).toBe(false);
    expect(AGENT_ID_RE.test('a\nb')).toBe(false);
  });
});

describe('validateAgentId', () => {
  test('returns input on valid; null on invalid/empty/non-string', () => {
    expect(validateAgentId('claude-1')).toBe('claude-1');
    expect(validateAgentId('')).toBeNull();
    expect(validateAgentId('bad space')).toBeNull();
    expect(validateAgentId(undefined)).toBeNull();
    expect(validateAgentId(null)).toBeNull();
  });

  test('rejects agentIds longer than AGENT_ID_MAX_LEN — DoS bound on session-map keys', () => {
    // Each unique agentId allocates a (DirectConnection, Y.UndoManager) pair
    // in AgentSessionManager. Without a length cap, a 1MB body field could
    // explode the session map memory footprint.
    const atLimit = 'a'.repeat(AGENT_ID_MAX_LEN);
    const overLimit = 'a'.repeat(AGENT_ID_MAX_LEN + 1);
    const wayOverLimit = 'a'.repeat(100_000);
    expect(validateAgentId(atLimit)).toBe(atLimit);
    expect(validateAgentId(overLimit)).toBeNull();
    expect(validateAgentId(wayOverLimit)).toBeNull();
  });
});

describe('toBroadcasterKey', () => {
  test('prefixes with agent- and is idempotent', () => {
    expect(toBroadcasterKey('claude-1')).toBe('agent-claude-1');
    expect(toBroadcasterKey('agent-claude-1')).toBe('agent-claude-1');
  });
});

describe('resolveAgentType', () => {
  test('classifies known clients; unknown → bot', () => {
    expect(resolveAgentType('claude-code')).toBe('claude');
    expect(resolveAgentType('local-agent-mode-open-knowledge')).toBe('claude');
    expect(resolveAgentType('local-agent-mode')).toBe('bot');
    expect(resolveAgentType('Cursor IDE')).toBe('cursor');
    expect(resolveAgentType('codex-cli')).toBe('codex');
    expect(resolveAgentType('cline')).toBe('cline');
    expect(resolveAgentType('Windsurf')).toBe('windsurf');
    expect(resolveAgentType('mystery')).toBe('bot');
    expect(resolveAgentType(undefined)).toBe('bot');
  });
});

describe('parseAgentBodyFields', () => {
  test('valid agentId → rawAgentId + writerId populated', () => {
    const fields = parseAgentBodyFields({ agentId: 'claude-7' });
    expect(fields.rawAgentId).toBe('claude-7');
    expect(fields.writerId).toBe('agent-claude-7');
  });

  test('absent agentId → rawAgentId + writerId both undefined (caller decides default)', () => {
    const fields = parseAgentBodyFields({});
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.writerId).toBeUndefined();
  });

  test('invalid agentId (regex fail) → rawAgentId undefined, no writerId', () => {
    const fields = parseAgentBodyFields({ agentId: 'has space' });
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.writerId).toBeUndefined();
  });

  test('empty-string agentId is treated as absent', () => {
    const fields = parseAgentBodyFields({ agentId: '' });
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.writerId).toBeUndefined();
  });

  test('non-string agentId is treated as absent', () => {
    const fields = parseAgentBodyFields({ agentId: 42 });
    expect(fields.rawAgentId).toBeUndefined();
  });

  test('overlong agentId is treated as absent (DoS bound on session map)', () => {
    const overLimit = 'a'.repeat(AGENT_ID_MAX_LEN + 1);
    const fields = parseAgentBodyFields({ agentId: overLimit });
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.writerId).toBeUndefined();
  });

  test('agentName sanitized; missing defaults to "Claude"', () => {
    expect(parseAgentBodyFields({}).displayName).toBe('Claude');
    expect(parseAgentBodyFields({ agentName: '  Bob  ' }).displayName).toBe('Bob');
    // sanitizeGitIdentity strips angle brackets + CR/LF
    expect(parseAgentBodyFields({ agentName: 'Eve<script>' }).displayName).toBe('Evescript');
    expect(parseAgentBodyFields({ agentName: 'a\nb' }).displayName).toBe('ab');
  });

  test('clientName / clientVersion / label sanitized when string; undefined when absent', () => {
    const fields = parseAgentBodyFields({
      clientName: 'claude-code\n',
      clientVersion: '1.0.0',
      label: '<dev>',
    });
    expect(fields.clientName).toBe('claude-code');
    expect(fields.clientVersion).toBe('1.0.0');
    expect(fields.label).toBe('dev');

    const empty = parseAgentBodyFields({});
    expect(empty.clientName).toBeUndefined();
    expect(empty.clientVersion).toBeUndefined();
    expect(empty.label).toBeUndefined();
  });

  test('colorSeed: capped at AGENT_NAME_MAX_LEN; undefined when absent', () => {
    const long = 'x'.repeat(AGENT_NAME_MAX_LEN + 50);
    const fields = parseAgentBodyFields({ colorSeed: long });
    expect(fields.colorSeed).toHaveLength(AGENT_NAME_MAX_LEN);
    expect(parseAgentBodyFields({}).colorSeed).toBeUndefined();
    expect(parseAgentBodyFields({ colorSeed: '' }).colorSeed).toBeUndefined();
    expect(parseAgentBodyFields({ colorSeed: 'team-purple' }).colorSeed).toBe('team-purple');
  });
});
