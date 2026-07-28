import type { Principal } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { extractActorIdentity } from './extract-actor-identity.ts';

const fixturePrincipal: Principal = {
  id: 'principal-11111111-2222-3333-4444-555555555555',
  display_name: 'Miles',
  display_email: 'miles@example.test',
  source: 'git-config',
  created_at: '2026-04-29T10:00:00.000Z',
};

describe('extractActorIdentity — agent branch', () => {
  test('agent only (no principal loaded) → kind=agent, writerId prefixed, anonymous principalId', () => {
    const result = extractActorIdentity({ agentId: 'claude-1', agentName: 'Claude' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.writerId).toBe('agent-claude-1');
    expect(result.displayName).toBe('Claude');
    expect(result.actor.principalId).toBeUndefined();
    expect(result.actor.agentType).toBe('bot');
  });

  test('agent + principal loaded → kind=agent AND actor.principalId populated (D-A8)', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-2', agentName: 'Claude', clientName: 'claude-code' },
      () => fixturePrincipal,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.writerId).toBe('agent-claude-2');
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
    expect(result.actor.agentType).toBe('claude');
    expect(result.actor.clientName).toBe('claude-code');
  });

  test('agentId already prefixed with agent- → toBroadcasterKey is idempotent', () => {
    const result = extractActorIdentity({ agentId: 'agent-claude-3' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.writerId).toBe('agent-claude-3');
  });

  test('agent default name when agentName not provided', () => {
    const result = extractActorIdentity({ agentId: 'claude-1' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.displayName).toBe('Claude');
  });

  test('agent colorSeed defaults to rawAgentId when not set', () => {
    const result = extractActorIdentity({ agentId: 'claude-7' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.colorSeed).toBe('claude-7');
  });

  test('agent colorSeed honors explicit body.colorSeed', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-7', colorSeed: 'team-purple' },
      () => null,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.colorSeed).toBe('team-purple');
  });

  test('clientName/clientVersion/label sanitized via sanitizeGitIdentity', () => {
    const result = extractActorIdentity(
      {
        agentId: 'claude-1',
        clientName: 'claude-code',
        clientVersion: '1.0.0',
        label: 'refactor-1',
      },
      () => null,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.actor.clientName).toBe('claude-code');
    expect(result.actor.clientVersion).toBe('1.0.0');
    expect(result.actor.label).toBe('refactor-1');
  });
});

describe('extractActorIdentity — principal fallback', () => {
  test('no agentId + principal loaded → kind=principal with principal id', () => {
    const result = extractActorIdentity({}, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.writerId).toBe(fixturePrincipal.id);
    expect(result.displayName).toBe('Miles');
    expect(result.colorSeed).toBe(fixturePrincipal.id);
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
  });

  test('agentId empty string treated as absent → falls back to principal', () => {
    const result = extractActorIdentity({ agentId: '' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
  });

  test('agentId with invalid characters rejected → falls back to principal', () => {
    const result = extractActorIdentity({ agentId: 'has spaces' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
  });

  test('agentId not a string treated as absent', () => {
    const result = extractActorIdentity({ agentId: 42 }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
  });

  test('summary "absent" when no body.summary supplied', () => {
    const result = extractActorIdentity({}, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.summary.kind).toBe('absent');
  });
});

describe('extractActorIdentity — anonymous fallback', () => {
  test('no agentId + no principal loaded → kind=anonymous (D22 invariant)', () => {
    const result = extractActorIdentity({}, () => null);
    expect(result.kind).toBe('anonymous');
  });

  test('no agentId + getPrincipal undefined → kind=anonymous', () => {
    const result = extractActorIdentity({}, undefined);
    expect(result.kind).toBe('anonymous');
  });
});

describe('extractActorIdentity — D-A11 trust boundary', () => {
  test('body-supplied principalId is silently ignored — server principal wins', () => {
    const result = extractActorIdentity({ principalId: 'principal-fake' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.writerId).toBe(fixturePrincipal.id);
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
  });

  test('body-supplied principalId is silently ignored — anonymous when no server principal', () => {
    const result = extractActorIdentity({ principalId: 'principal-fake' }, () => null);
    expect(result.kind).toBe('anonymous');
  });

  test('body-supplied principalId is ignored even when agentId present', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-1', principalId: 'principal-fake' },
      () => fixturePrincipal,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
  });
});

describe('extractActorIdentity — summary validation', () => {
  test('valid string summary surfaces as summary.kind=value', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-1', summary: 'A valid summary' },
      () => null,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.summary.kind).toBe('value');
    if (result.summary.kind !== 'value') return;
    expect(result.summary.value).toBe('A valid summary');
  });

  test('non-string summary surfaces as kind=invalid-summary (caller returns 400)', () => {
    const result = extractActorIdentity({ summary: 42 }, () => fixturePrincipal);
    expect(result.kind).toBe('invalid-summary');
  });

  test('invalid-summary signals before agent vs principal resolution', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-1', summary: { not: 'string' } },
      () => fixturePrincipal,
    );
    expect(result.kind).toBe('invalid-summary');
  });

  test('whitespace-only summary classified as absent (matches normalizeSummary)', () => {
    const result = extractActorIdentity({ summary: '   ' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.summary.kind).toBe('absent');
  });
});
