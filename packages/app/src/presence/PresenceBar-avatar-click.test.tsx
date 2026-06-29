import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';
import { renderToString } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as actualDocumentContext from '@/editor/DocumentContext';
import type { AgentParticipant } from './use-presence';
import * as actualUsePresence from './use-presence';
import * as actualUseSyncStatus from './use-sync-status';
import * as actualUseSyncToasts from './use-sync-toasts';

const openActivityPanelCalls: Array<[string, string | null]> = [];
const openActivityPanel = (connectionId: string, targetDoc: string | null): void => {
  openActivityPanelCalls.push([connectionId, targetDoc]);
};

let currentAgents: AgentParticipant[] = [];
let crossDocAgents: AgentParticipant[] = [];
let mockActiveDocName: string | null = null;

mock.module('@/editor/DocumentContext', () => ({
  ...actualDocumentContext,
  useDocumentContext: () => ({
    activeProvider: null,
    activeDocName: mockActiveDocName,
    systemProvider: null,
    openActivityPanel,
    docPanelMode: 'doc',
    docPanelAgentId: null,
    docPanelExpandSignal: 0,
    closeActivityPanel: () => {},
  }),
}));

mock.module('./use-presence', () => ({
  ...actualUsePresence,
  usePresence: () => ({ current: currentAgents, crossDoc: crossDocAgents }),
}));

mock.module('./use-sync-status', () => ({
  ...actualUseSyncStatus,
  useSyncStatus: () => ({ state: 'clean' }),
}));

mock.module('./use-sync-toasts', () => ({
  ...actualUseSyncToasts,
  useSyncToasts: () => {},
}));

const { PresenceBar } = await import('./PresenceBar');

function agent(
  agentId: string,
  icon = 'claude',
  currentDoc: string | null = 'x.md',
): AgentParticipant {
  const presence: AgentPresenceEntry = {
    displayName: `Agent-${agentId}`,
    icon,
    color: '#d97757',
    currentDoc,
    mode: 'idle',
    ts: Date.now(),
  };
  return { kind: 'agent', agentId, presence };
}

afterEach(() => {
  openActivityPanelCalls.length = 0;
  currentAgents = [];
  crossDocAgents = [];
  mockActiveDocName = null;
});

describe('PresenceBar avatar click wiring', () => {
  test('each current-doc agent avatar is a button with the open-panel aria-label', () => {
    currentAgents = [agent('abc', 'claude', 'notes.md')];
    const html = renderToString(
      <TooltipProvider>
        <PresenceBar />
      </TooltipProvider>,
    );
    expect(html).toContain('data-presence-badge="agent"');
    expect(html).toContain('<button');
    expect(html).toContain('Open activity panel for Agent-abc');
  });

  test('each cross-doc agent avatar is also a button (regression guard for D-P9 LOCKED)', () => {
    crossDocAgents = [agent('zzz', 'cursor', 'other.md')];
    const html = renderToString(
      <TooltipProvider>
        <PresenceBar />
      </TooltipProvider>,
    );
    expect(html).toContain('data-presence-badge="agent"');
    expect(html).toContain('data-presence-crossdoc="true"');
    expect(html).toContain('Open activity panel for Agent-zzz, editing other.md');
  });

  test('sentinel-only agent with no doc selected renders inert (no dead click target)', () => {
    crossDocAgents = [agent('idle', 'claude', '(connected)')];
    const html = renderToString(
      <TooltipProvider>
        <PresenceBar />
      </TooltipProvider>,
    );
    expect(html).toContain('data-presence-badge="agent"');
    expect(html).toContain('data-presence-inert="true"');
    expect(html).not.toContain('<button');
  });

  test('sentinel agent stays interactive when a doc IS selected (guards the interactive OR)', () => {
    mockActiveDocName = 'current.md';
    crossDocAgents = [agent('idle', 'claude', '(connected)')];
    const html = renderToString(
      <TooltipProvider>
        <PresenceBar />
      </TooltipProvider>,
    );
    expect(html).toContain('<button');
    expect(html).not.toContain('data-presence-inert');
  });

  test('presence bar renders an overflow chip when current-doc agents exceed the primary limit', () => {
    currentAgents = [
      agent('a', 'claude', 'x.md'),
      agent('b', 'cursor', 'x.md'),
      agent('c', 'windsurf', 'x.md'),
      agent('d', 'openai', 'x.md'),
      agent('e', 'cline', 'x.md'),
    ];
    const html = renderToString(
      <TooltipProvider>
        <PresenceBar />
      </TooltipProvider>,
    );
    expect(html).toContain('data-slot="presence-overflow"');
  });
});
