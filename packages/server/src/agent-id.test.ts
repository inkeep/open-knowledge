import { describe, expect, test, vi } from 'vitest';
import {
  AGENT_ID_MAX_LEN,
  AGENT_ID_RE,
  AGENT_NAME_MAX_LEN,
  ANONYMOUS_WRITER_ID,
  parseAgentBodyFields,
  resolveAgentType,
  sessionWriterId,
  toBroadcasterKey,
  UNIDENTIFIED_WRITER_ID,
  validateAgentId,
} from './agent-id.ts';
import { getLogger } from './logger.ts';

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

describe('sessionWriterId', () => {
  test.each([
    { label: 'the anonymous principal', agentId: ANONYMOUS_WRITER_ID },
    { label: 'the stand-in for a caller that supplied none', agentId: UNIDENTIFIED_WRITER_ID },
  ])('$label is not a writer identity, so it cannot be recorded as a peer', ({ agentId }) => {
    expect(sessionWriterId({ agentId })).toBeUndefined();
  });

  test('an agent writer brands', () => {
    expect(sessionWriterId({ agentId: 'agent-claude-7' })).toBe('agent-claude-7');
  });

  test('a principal writer brands — a local human is a legitimate peer', () => {
    const principalWriter = 'principal-3f8c1b4e-9a21-4d6f-8e15-2c7b0a9d5431';
    expect(sessionWriterId({ agentId: principalWriter })).toBe(principalWriter);
  });

  test('a caller that deliberately supplies the stand-in id still brands, under its broadcaster key', () => {
    const deliberate = toBroadcasterKey(UNIDENTIFIED_WRITER_ID);
    expect(deliberate).toBe('agent-claude-1');
    expect(parseAgentBodyFields({ agentId: UNIDENTIFIED_WRITER_ID }).suppliedWriterId).toBe(
      deliberate,
    );
    expect(sessionWriterId({ agentId: deliberate })).toBe(deliberate);
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
  test('valid agentId → rawAgentId + suppliedWriterId populated', () => {
    const fields = parseAgentBodyFields({ agentId: 'claude-7' });
    expect(fields.rawAgentId).toBe('claude-7');
    expect(fields.suppliedWriterId).toBe('agent-claude-7');
  });

  test('absent agentId → rawAgentId + suppliedWriterId both undefined (caller decides default)', () => {
    const fields = parseAgentBodyFields({});
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.suppliedWriterId).toBeUndefined();
  });

  test('invalid agentId (regex fail) → rawAgentId undefined, no suppliedWriterId', () => {
    const fields = parseAgentBodyFields({ agentId: 'has space' });
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.suppliedWriterId).toBeUndefined();
  });

  test('empty-string agentId yields no rawAgentId and no suppliedWriterId', () => {
    const fields = parseAgentBodyFields({ agentId: '' });
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.suppliedWriterId).toBeUndefined();
  });

  test('non-string agentId yields no rawAgentId and no suppliedWriterId', () => {
    const fields = parseAgentBodyFields({ agentId: 42 });
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.suppliedWriterId).toBeUndefined();
  });

  test('overlong agentId yields no suppliedWriterId (DoS bound on session map)', () => {
    const overLimit = 'a'.repeat(AGENT_ID_MAX_LEN + 1);
    const fields = parseAgentBodyFields({ agentId: overLimit });
    expect(fields.rawAgentId).toBeUndefined();
    expect(fields.suppliedWriterId).toBeUndefined();
  });

  test('agentName sanitized; missing defaults to "Claude"', () => {
    expect(parseAgentBodyFields({}).displayName).toBe('Claude');
    expect(parseAgentBodyFields({ agentName: '  Bob  ' }).displayName).toBe('Bob');
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

describe('parseAgentBodyFields agentId validation signal', () => {
  function captureWarnings(): {
    warned: { data: Record<string, unknown>; msg: string }[];
    restore: () => void;
  } {
    const logger = getLogger('agent-write');
    const warned: { data: Record<string, unknown>; msg: string }[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((data: unknown, msg?: string) => {
      warned.push({ data: (data ?? {}) as Record<string, unknown>, msg: msg ?? '' });
    }) as never);
    return { warned, restore: () => spy.mockRestore() };
  }

  test('a malformed agentId warns instead of silently demoting to the default writer', () => {
    const { warned, restore } = captureWarnings();
    try {
      const fields = parseAgentBodyFields({ agentId: 'has space' });
      expect(fields.rawAgentId).toBeUndefined();
      expect(fields.suppliedWriterId).toBeUndefined();
      expect(warned).toHaveLength(1);
      expect(warned[0]?.data.event).toBe('agent-id-validation-failed');
      expect(warned[0]?.data.reason).toBe('charset');
      expect(warned[0]?.data.agentIdType).toBe('string');
    } finally {
      restore();
    }
  });

  test('an over-long agentId warns and names the bound it exceeded', () => {
    const { warned, restore } = captureWarnings();
    try {
      const tooLong = 'a'.repeat(AGENT_ID_MAX_LEN + 1);
      expect(parseAgentBodyFields({ agentId: tooLong }).suppliedWriterId).toBeUndefined();
      expect(warned).toHaveLength(1);
      expect(warned[0]?.data.reason).toBe('too-long');
      expect(warned[0]?.data.agentIdMaxLen).toBe(AGENT_ID_MAX_LEN);
    } finally {
      restore();
    }
  });

  test.each([
    { label: 'empty string', agentId: '', reason: 'empty', agentIdType: 'string' },
    { label: 'number', agentId: 42, reason: 'not-a-string', agentIdType: 'number' },
    { label: 'boolean', agentId: true, reason: 'not-a-string', agentIdType: 'boolean' },
    { label: 'null', agentId: null, reason: 'not-a-string', agentIdType: 'object' },
    { label: 'array', agentId: ['claude-1'], reason: 'not-a-string', agentIdType: 'object' },
    { label: 'object', agentId: { id: 'claude-1' }, reason: 'not-a-string', agentIdType: 'object' },
  ])(
    'a supplied but unusable agentId ($label) warns like a rejected string',
    ({ agentId, reason, agentIdType }) => {
      const { warned, restore } = captureWarnings();
      try {
        expect(parseAgentBodyFields({ agentId }).suppliedWriterId).toBeUndefined();
        expect(warned).toHaveLength(1);
        expect(warned[0]?.data.event).toBe('agent-id-validation-failed');
        expect(warned[0]?.data.reason).toBe(reason);
        expect(warned[0]?.data.agentIdType).toBe(agentIdType);
      } finally {
        restore();
      }
    },
  );

  test('the warning never carries the rejected agentId itself', () => {
    const { warned, restore } = captureWarnings();
    try {
      const secretish = 'tenant/4a1f-user@example.com';
      parseAgentBodyFields({ agentId: secretish });
      parseAgentBodyFields({ agentId: { tenant: secretish } });
      expect(warned).toHaveLength(2);
      expect(JSON.stringify(warned)).not.toContain(secretish);
      expect(JSON.stringify(warned)).not.toContain('example.com');
    } finally {
      restore();
    }
  });

  test('the warning claims only the discard, not a caller-specific writer fallback', () => {
    const { warned, restore } = captureWarnings();
    try {
      parseAgentBodyFields({ agentId: 'has space' });
      expect(warned).toHaveLength(1);
      expect(warned[0]?.msg).toContain('was discarded');
      expect(warned[0]?.msg).not.toContain('default writer');
    } finally {
      restore();
    }
  });

  test('a valid or absent agentId stays silent', () => {
    const { warned, restore } = captureWarnings();
    try {
      expect(parseAgentBodyFields({ agentId: 'claude-7' }).suppliedWriterId).toBe('agent-claude-7');
      parseAgentBodyFields({});
      parseAgentBodyFields({ agentName: 'Bob' });
      expect(warned).toEqual([]);
    } finally {
      restore();
    }
  });
});
