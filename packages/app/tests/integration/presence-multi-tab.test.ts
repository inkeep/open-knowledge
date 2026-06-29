import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { AwarenessUser } from '../../src/presence/identity';
import {
  dedupeHumansByPrincipalId,
  type HumanParticipant,
} from '../../src/presence/participant-model.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ keepaliveGraceMs: 150 });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function buildHumans(provider: HocuspocusProvider): HumanParticipant[] {
  const humans: HumanParticipant[] = [];
  const states = provider.awareness?.getStates() ?? new Map<number, unknown>();
  for (const [clientId, rawState] of states.entries()) {
    const s = rawState as Record<string, unknown>;
    if (!s.user || typeof s.user !== 'object') continue;
    const user = s.user as AwarenessUser;
    if (user.type !== 'human') continue;
    humans.push({
      kind: 'human',
      clientId,
      user,
      mode: (s.mode as HumanParticipant['mode']) ?? 'wysiwyg',
      tabCount: 1,
    });
  }
  return humans;
}

function getAwarenessUser(
  provider: HocuspocusProvider,
  clientId: number,
): AwarenessUser | undefined {
  const rawState = provider.awareness?.getStates().get(clientId) as
    | Record<string, unknown>
    | undefined;
  if (!rawState?.user || typeof rawState.user !== 'object') return undefined;
  return rawState.user as AwarenessUser;
}

describe('presence dedupe — same principalId', () => {
  test('two clients with same principalId collapse to one HumanParticipant with tabCount === 2', async () => {
    const docName = `presence-dedupe-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    try {
      const PID = 'principal-test-same';

      clientA.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Ada Lovelace-King',
        color: '#f0ece3',
        coeditor: 'standalone',
        tabId: 'tab-a',
        principalId: PID,
      });
      clientB.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Ada Lovelace-King',
        color: '#f0ece3',
        coeditor: 'standalone',
        tabId: 'tab-b',
        principalId: PID,
      });

      const clientAId = clientA.provider.awareness?.clientID ?? 0;
      const clientBId = clientB.provider.awareness?.clientID ?? 0;
      await pollUntil(() => clientA.provider.awareness?.getStates().has(clientBId) === true, 5000);
      await pollUntil(() => clientB.provider.awareness?.getStates().has(clientAId) === true, 5000);

      const humansFromA = buildHumans(clientA.provider);
      const deduped = dedupeHumansByPrincipalId(humansFromA);
      expect(deduped.length).toBe(1);
      expect(deduped[0].tabCount).toBe(2);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });

  test('when one of two deduped clients disconnects, tabCount transitions from 2 to 1', async () => {
    const docName = `presence-disconnect-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    const PID = 'principal-test-disconnect';

    clientA.provider.awareness?.setLocalStateField('user', {
      type: 'human' as const,
      name: 'Miles KT',
      color: '#f0ece3',
      coeditor: 'standalone',
      tabId: 'tab-a',
      principalId: PID,
    });
    clientB.provider.awareness?.setLocalStateField('user', {
      type: 'human' as const,
      name: 'Miles KT',
      color: '#f0ece3',
      coeditor: 'standalone',
      tabId: 'tab-b',
      principalId: PID,
    });

    const clientBId = clientB.provider.awareness?.clientID ?? 0;
    try {
      await pollUntil(() => clientA.provider.awareness?.getStates().has(clientBId) === true, 5000);

      const before = dedupeHumansByPrincipalId(buildHumans(clientA.provider));
      expect(before.length).toBe(1);
      expect(before[0].tabCount).toBe(2);

      clientB.provider.destroy();

      await pollUntil(
        () => clientA.provider.awareness?.getStates().has(clientBId) === false,
        10_000,
      );

      const after = dedupeHumansByPrincipalId(buildHumans(clientA.provider));
      const ownEntry = after.find((h) => h.user.principalId === PID);
      expect(ownEntry?.tabCount ?? 1).toBe(1);
    } finally {
      await clientA.cleanup();
      try {
        await clientB.cleanup();
      } catch {}
    }
  });
});

describe('presence dedupe — tab navigates away (clears local awareness without disconnecting)', () => {
  test('when one tab calls setLocalState(null) without disconnecting, peers see the entry vanish and tabCount drops', async () => {
    const docName = `presence-navigate-away-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    const PID = 'principal-test-navigate-away';

    try {
      clientA.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Miles KT',
        color: '#f0ece3',
        coeditor: 'standalone',
        tabId: 'tab-a',
        principalId: PID,
      });
      clientB.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Miles KT',
        color: '#f0ece3',
        coeditor: 'standalone',
        tabId: 'tab-b',
        principalId: PID,
      });

      const clientAId = clientA.provider.awareness?.clientID ?? 0;
      await pollUntil(() => clientB.provider.awareness?.getStates().has(clientAId) === true, 5000);

      expect(dedupeHumansByPrincipalId(buildHumans(clientB.provider))[0].tabCount).toBe(2);

      clientA.provider.awareness?.setLocalState(null);

      await pollUntil(() => clientB.provider.awareness?.getStates().has(clientAId) === false, 2000);

      const afterClear = dedupeHumansByPrincipalId(buildHumans(clientB.provider));
      const ownEntry = afterClear.find((h) => h.user.principalId === PID);
      expect(ownEntry?.tabCount ?? 1).toBe(1);

      clientA.provider.awareness?.setLocalState({
        user: {
          type: 'human' as const,
          name: 'Miles KT',
          color: '#f0ece3',
          coeditor: 'standalone',
          tabId: 'tab-a',
          principalId: PID,
        },
        mode: 'wysiwyg',
      });
      await pollUntil(() => clientB.provider.awareness?.getStates().has(clientAId) === true, 2000);
      expect(dedupeHumansByPrincipalId(buildHumans(clientB.provider))[0].tabCount).toBe(2);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });
});

describe('presence dedupe — different principalIds', () => {
  test('two clients with different principalIds produce two distinct HumanParticipants', async () => {
    const docName = `presence-distinct-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    try {
      clientA.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Miles KT',
        color: '#f0ece3',
        coeditor: 'standalone',
        tabId: 'tab-a',
        principalId: 'principal-user-a',
      });
      clientB.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Ada D',
        color: '#dce8fa',
        coeditor: 'standalone',
        tabId: 'tab-b',
        principalId: 'principal-user-b',
      });

      const clientBId = clientB.provider.awareness?.clientID ?? 0;
      await pollUntil(() => clientA.provider.awareness?.getStates().has(clientBId) === true, 5000);

      const deduped = dedupeHumansByPrincipalId(buildHumans(clientA.provider));
      expect(deduped.length).toBe(2);
      expect(deduped.every((h) => h.tabCount === 1)).toBe(true);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });
});

describe('awareness payload shape under each principal-resolution state', () => {
  test('boot race — principal not yet resolved: no principalId in payload, type===human', async () => {
    const docName = `presence-fr3-a-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    try {
      clientA.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Curious Squirrel',
        color: '#f9e1db',
        coeditor: 'standalone',
        tabId: 'tab-state-a',
      });

      const clientAId = clientA.provider.awareness?.clientID ?? 0;
      await pollUntil(() => clientB.provider.awareness?.getStates().has(clientAId) === true, 5000);

      const user = getAwarenessUser(clientB.provider, clientAId);
      expect(user?.type).toBe('human');
      expect(user?.coeditor).toBe('standalone');
      expect('principalId' in (user ?? {})).toBe(false);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });

  test('git-config principal: principalId present, type===human, coeditor preserved', async () => {
    const docName = `presence-fr3-b-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    try {
      clientA.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Ada Lovelace-King',
        color: '#f0ece3',
        coeditor: 'cursor',
        tabId: 'tab-state-b',
        principalId: 'principal-git-config-id',
      });

      const clientAId = clientA.provider.awareness?.clientID ?? 0;
      await pollUntil(() => clientB.provider.awareness?.getStates().has(clientAId) === true, 5000);

      const user = getAwarenessUser(clientB.provider, clientAId);
      expect(user?.type).toBe('human');
      expect(user?.coeditor).toBe('cursor');
      expect(user?.principalId).toBe('principal-git-config-id');
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });

  test('synthesized principal: no principalId in payload, type===human, coeditor preserved', async () => {
    const docName = `presence-fr3-c-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    try {
      clientA.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Brave Bird',
        color: '#dce8fa',
        coeditor: 'standalone',
        tabId: 'tab-state-c',
      });

      const clientAId = clientA.provider.awareness?.clientID ?? 0;
      await pollUntil(() => clientB.provider.awareness?.getStates().has(clientAId) === true, 5000);

      const user = getAwarenessUser(clientB.provider, clientAId);
      expect(user?.type).toBe('human');
      expect(user?.coeditor).toBe('standalone');
      expect('principalId' in (user ?? {})).toBe(false);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });
});

describe('synthesized principals never publish principalId — no false dedupe', () => {
  test('two synthesized users without principalId render as two separate participants', async () => {
    const docName = `presence-synthesized-${crypto.randomUUID()}`;
    const clientA = await createTestClient(server.port, docName);
    const clientB = await createTestClient(server.port, docName);
    try {
      clientA.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Curious Squirrel',
        color: '#f9e1db',
        coeditor: 'standalone',
        tabId: 'tab-profile-1',
      });
      clientB.provider.awareness?.setLocalStateField('user', {
        type: 'human' as const,
        name: 'Brave Bird',
        color: '#dce8fa',
        coeditor: 'standalone',
        tabId: 'tab-profile-2',
      });

      const clientBId = clientB.provider.awareness?.clientID ?? 0;
      await pollUntil(() => clientA.provider.awareness?.getStates().has(clientBId) === true, 5000);

      const deduped = dedupeHumansByPrincipalId(buildHumans(clientA.provider));
      expect(deduped.length).toBe(2);
      expect(deduped.every((h) => h.tabCount === 1)).toBe(true);
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });
});
