import { describe, expect, test } from 'bun:test';
import {
  colorFromSeed,
  HUMAN_COLORS,
  type Identity,
  type Principal,
} from '@inkeep/open-knowledge-core';
import { buildAwarenessUser } from './awareness-user';

const identity: Identity = {
  name: 'Curious Squirrel',
  color: '#f9e1db',
  coeditor: 'cursor',
  tabId: 'tab-uuid-abc',
};

const gitConfigPrincipal: Principal = {
  id: 'principal-git-1',
  display_name: 'ada-kt-lovelace',
  display_email: 'miles@example.com',
  source: 'git-config',
  created_at: '2026-04-27T00:00:00.000Z',
};

const synthesizedPrincipal: Principal = {
  id: 'principal-synth-1',
  display_name: 'Local User',
  display_email: 'principal-synth-1@local.openknowledge',
  source: 'synthesized',
  created_at: '2026-04-27T00:00:00.000Z',
};

describe('buildAwarenessUser — state (a): principal not yet resolved', () => {
  test('publishes random-fallback name and color, no principalId', () => {
    const user = buildAwarenessUser({ principal: null, identity });
    expect(user.type).toBe('human');
    expect(user.name).toBe('Curious Squirrel');
    expect(user.color).toBe('#f9e1db');
    expect(user.coeditor).toBe('cursor');
    expect(user.tabId).toBe('tab-uuid-abc');
    expect('principalId' in user).toBe(false);
  });

  test('preserves coeditor "standalone" when URL has no coeditor param', () => {
    const user = buildAwarenessUser({
      principal: null,
      identity: { ...identity, coeditor: 'standalone' },
    });
    expect(user.coeditor).toBe('standalone');
  });
});

describe('buildAwarenessUser — state (b): principal.source === "git-config"', () => {
  test('publishes polished display_name, deterministic color, principalId', () => {
    const user = buildAwarenessUser({ principal: gitConfigPrincipal, identity });
    expect(user.type).toBe('human');
    expect(user.name).toBe('Ada Kt Lovelace');
    expect(user.color).toBe(colorFromSeed(gitConfigPrincipal.id, HUMAN_COLORS));
    expect(user.coeditor).toBe('cursor');
    expect(user.tabId).toBe('tab-uuid-abc');
    expect(user.principalId).toBe('principal-git-1');
  });

  test('passes already-spaced names through formatPresenceLabel unchanged', () => {
    const user = buildAwarenessUser({
      principal: { ...gitConfigPrincipal, display_name: 'Ada Lovelace-King' },
      identity,
    });
    expect(user.name).toBe('Ada Lovelace-King');
  });

  test('color is deterministic — same principal id always maps to the same palette entry', () => {
    const u1 = buildAwarenessUser({ principal: gitConfigPrincipal, identity });
    const u2 = buildAwarenessUser({
      principal: gitConfigPrincipal,
      identity: { ...identity, color: '#ffffff' },
    });
    expect(u1.color).toBe(u2.color);
  });
});

describe('buildAwarenessUser — state (c): principal.source === "synthesized"', () => {
  test('publishes random-fallback name, deterministic color, NO principalId', () => {
    // synthesized users do not publish principalId. Two browser profiles
    // on the same machine read the same synthesized principal.json (same id)
    // but generate different localStorage random names; publishing principalId
    // would false-dedupe them and tie-break on lowest clientId, producing a
    // visible name flicker.
    const user = buildAwarenessUser({ principal: synthesizedPrincipal, identity });
    expect(user.type).toBe('human');
    expect(user.name).toBe('Curious Squirrel');
    expect(user.color).toBe(colorFromSeed(synthesizedPrincipal.id, HUMAN_COLORS));
    expect(user.coeditor).toBe('cursor');
    expect('principalId' in user).toBe(false);
  });

  test('color comes from principal.id seed, not from identity.color', () => {
    const user = buildAwarenessUser({ principal: synthesizedPrincipal, identity });
    expect(user.color).not.toBe(identity.color);
    expect(user.color).toBe(colorFromSeed(synthesizedPrincipal.id, HUMAN_COLORS));
  });
});

describe('buildAwarenessUser — load-bearing invariants across all states', () => {
  test('every payload has type: "human" — usePresence filters on this', () => {
    expect(buildAwarenessUser({ principal: null, identity }).type).toBe('human');
    expect(buildAwarenessUser({ principal: gitConfigPrincipal, identity }).type).toBe('human');
    expect(buildAwarenessUser({ principal: synthesizedPrincipal, identity }).type).toBe('human');
  });

  test('every payload preserves coeditor across states', () => {
    const cursorIdentity = { ...identity, coeditor: 'cursor' };
    expect(buildAwarenessUser({ principal: null, identity: cursorIdentity }).coeditor).toBe(
      'cursor',
    );
    expect(
      buildAwarenessUser({ principal: gitConfigPrincipal, identity: cursorIdentity }).coeditor,
    ).toBe('cursor');
    expect(
      buildAwarenessUser({ principal: synthesizedPrincipal, identity: cursorIdentity }).coeditor,
    ).toBe('cursor');
  });

  test('only the git-config branch publishes principalId — synthesized and unresolved both omit it', () => {
    expect('principalId' in buildAwarenessUser({ principal: null, identity })).toBe(false);
    expect('principalId' in buildAwarenessUser({ principal: gitConfigPrincipal, identity })).toBe(
      true,
    );
    expect('principalId' in buildAwarenessUser({ principal: synthesizedPrincipal, identity })).toBe(
      false,
    );
  });
});
