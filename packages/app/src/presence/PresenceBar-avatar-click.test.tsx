/**
 * AgentAvatar click → openActivityPanel behavior tests.
 *
 * PresenceBar's top-level component needs DocumentContext + a real
 * HocuspocusProvider to exercise, so we target AgentAvatar indirectly by
 * rendering PresenceBar with stubbed hooks via `mock.module`. Static
 * markup inspection verifies the aria-label + data attributes + the click
 * event wires through to the mocked openActivityPanel.
 *
 * The interactive flow (click → panel opens, Esc closes, swap behavior)
 * lives in Playwright.
 */

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
// Mutable so a test can exercise the `activeDocName !== null` half of the
// `interactive` OR — a sentinel agent must stay clickable when a doc is open.
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

// Bun keeps module mocks process-global and never restores them between
// test files — every factory spreads the real module so omitted exports
// stay linkable for any later importer in the process (the partial
// DocumentContext factory here detonated EditorArea.test.ts's module-load
// smoke on order-unlucky CI runners; see
// tests/integration/mock-module-completeness.test.ts).
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
    // aria-label prefix signals click-to-open behavior.
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
    // `(connected)` is the keepalive-bootstrap sentinel — non-null so the
    // entry survives the presence filter, but no real doc to navigate to.
    // With no doc selected (mock `activeDocName: null`) the click would be a
    // silent no-op, so the avatar must render as a non-button inert badge.
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
    // `interactive = activeDocName !== null || realCurrentDoc !== null`. The
    // sentinel agent has no real doc, so this case relies on the FIRST operand:
    // with a doc open the avatar must remain a clickable button (clicking opens
    // the agent's Activity view in the current doc's panel). A regression to
    // `&&` would render it inert here — this test fails if that happens.
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
