import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { AwarenessUser } from './identity';
import { usePresence } from './use-presence';

interface FakeAwarenessState {
  user?: AwarenessUser;
  mode?: 'wysiwyg' | 'source';
  agentPresence?: Record<string, AgentPresenceEntry>;
}

interface FakeAwareness {
  clientID: number;
  getLocalState: () => FakeAwarenessState | undefined;
  getStates: () => Map<number, FakeAwarenessState>;
  on: (_event: 'change', _handler: () => void) => void;
  off: (_event: 'change', _handler: () => void) => void;
}

function makeHuman(name: string, principalId?: string): AwarenessUser {
  return {
    type: 'human',
    name,
    color: '#fff',
    tabId: `tab-${name}`,
    ...(principalId !== undefined ? { principalId } : {}),
  };
}

function makeAgent(overrides: Partial<AgentPresenceEntry> = {}): AgentPresenceEntry {
  return {
    displayName: 'Claude',
    icon: 'claude',
    color: '#d97757',
    currentDoc: 'doc.md',
    mode: 'writing',
    ts: Date.now(),
    ...overrides,
  };
}

function makeAwareness(args: {
  clientID?: number;
  localState?: FakeAwarenessState;
  states?: Array<[number, FakeAwarenessState]>;
}): FakeAwareness {
  return {
    clientID: args.clientID ?? 1,
    getLocalState: () => args.localState,
    getStates: () => new Map(args.states ?? []),
    on: () => {},
    off: () => {},
  };
}

function asProvider(awareness: FakeAwareness): HocuspocusProvider {
  return { awareness } as unknown as HocuspocusProvider;
}

function PresenceProbe({
  activeProvider,
  systemProvider = null,
}: {
  activeProvider: HocuspocusProvider | null;
  systemProvider?: HocuspocusProvider | null;
}) {
  const presence = usePresence(activeProvider, systemProvider, 'doc.md');
  const current = presence.current
    .map((participant) =>
      participant.kind === 'human'
        ? `human:${participant.clientId}:${participant.tabCount}`
        : `agent:${participant.agentId}:${participant.presence.currentDoc}`,
    )
    .join('|');
  return <output data-testid="presence-current">{current}</output>;
}

describe('usePresence runtime self-filtering', () => {
  afterEach(() => cleanup());

  test('filters local principal before human dedupe', async () => {
    const activeAwareness = makeAwareness({
      clientID: 101,
      localState: { user: makeHuman('Me', 'principal-me') },
      states: [
        [101, { user: makeHuman('Me current tab', 'principal-me'), mode: 'wysiwyg' }],
        [202, { user: makeHuman('Me second tab', 'principal-me'), mode: 'source' }],
        [303, { user: makeHuman('Remote', 'principal-remote'), mode: 'wysiwyg' }],
      ],
    });

    render(<PresenceProbe activeProvider={asProvider(activeAwareness)} />);

    await waitFor(() => {
      expect(screen.getByTestId('presence-current').textContent).toBe('human:303:1');
    });
  });

  test('falls back to active awareness clientID when local principal is absent', async () => {
    const activeAwareness = makeAwareness({
      clientID: 101,
      localState: { user: makeHuman('Me') },
      states: [
        [101, { user: makeHuman('Me current tab'), mode: 'wysiwyg' }],
        [202, { user: makeHuman('Synthesized remote tab'), mode: 'source' }],
      ],
    });

    render(<PresenceProbe activeProvider={asProvider(activeAwareness)} />);

    await waitFor(() => {
      expect(screen.getByTestId('presence-current').textContent).toBe('human:202:1');
    });
  });

  test('agent presence is not filtered by the human self discriminator', async () => {
    const activeAwareness = makeAwareness({
      clientID: 101,
      localState: { user: makeHuman('Me', 'agent-1') },
      states: [],
    });
    const systemAwareness = makeAwareness({
      states: [[1, { agentPresence: { 'agent-1': makeAgent() } }]],
    });

    render(
      <PresenceProbe
        activeProvider={asProvider(activeAwareness)}
        systemProvider={asProvider(systemAwareness)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('presence-current').textContent).toBe('agent:agent-1:doc.md');
    });
  });
});
