import { describe, expect, test } from 'vitest';
import { appendPresenceWrite, latestAgentWrite } from './presence-follow';

function awarenessWith(entries: Record<string, { currentDoc: string | null; ts: number }>) {
  return {
    getStates: () =>
      new Map([
        [
          1,
          {
            agentPresence: Object.fromEntries(
              Object.entries(entries).map(([id, e]) => [
                id,
                { displayName: id, icon: 'claude', color: '#000', mode: 'writing', ...e },
              ]),
            ),
          },
        ],
      ]),
  };
}

describe('latestAgentWrite', () => {
  const NOW = 1_000_000;

  test('freshest write across agents wins; stale and doc-less entries are skipped', () => {
    const awareness = awarenessWith({
      'agent-a': { currentDoc: 'articles/wine/tannins', ts: NOW - 100 },
      'agent-b': { currentDoc: 'articles/wine/terroir', ts: NOW - 50 },
      'agent-idle': { currentDoc: null, ts: NOW },
      'agent-stale': { currentDoc: 'old/doc', ts: NOW - 60_000 },
    });
    expect(latestAgentWrite(awareness, NOW)).toEqual({
      doc: 'articles/wine/terroir',
      ts: NOW - 50,
    });
  });

  test('dot-segment plumbing targets never become follow targets', () => {
    const awareness = awarenessWith({
      'agent-a': { currentDoc: '.ok/skills/foo/SKILL', ts: NOW - 10 },
    });
    expect(latestAgentWrite(awareness, NOW)).toBeNull();
  });

  test('presence sentinels never become follow targets', () => {
    // The server publishes these to keep an idle agent visible in the presence
    // bar — following them opens a phantom tab and, at turn end, drags the
    // editor off the last real page.
    expect(
      latestAgentWrite(awarenessWith({ a: { currentDoc: '(agent thread)', ts: NOW } }), NOW),
    ).toBeNull();
    expect(
      latestAgentWrite(awarenessWith({ a: { currentDoc: '(connected)', ts: NOW } }), NOW),
    ).toBeNull();
  });

  test('a real write still wins over a fresher sentinel from another agent', () => {
    const awareness = awarenessWith({
      writer: { currentDoc: 'articles/tea/terroir', ts: NOW - 100 },
      idler: { currentDoc: '(agent thread)', ts: NOW },
    });
    expect(latestAgentWrite(awareness, NOW)).toEqual({
      doc: 'articles/tea/terroir',
      ts: NOW - 100,
    });
  });

  test('non-awareness values return null', () => {
    expect(latestAgentWrite(null, NOW)).toBeNull();
    expect(latestAgentWrite({}, NOW)).toBeNull();
  });
});

describe('appendPresenceWrite', () => {
  test('re-observations of the same (doc, ts) do not extend the stream', () => {
    const first = appendPresenceWrite([], { doc: 'a', ts: 1 });
    expect(appendPresenceWrite(first, { doc: 'a', ts: 1 })).toBe(first);
    expect(appendPresenceWrite(first, { doc: 'a', ts: 2 })).toHaveLength(2);
    expect(appendPresenceWrite(first, { doc: 'b', ts: 1 })).toHaveLength(2);
  });
});
