import { describe, expect, test } from 'vitest';
import type { RenderedToolCall } from '@/lib/acp/thread-event-model';
import type { Workspace } from '@/lib/workspace-paths';
import {
  decideFollowNavigation,
  docNameFromAbsolutePath,
  type FollowNavState,
  followTargetFromToolCall,
  INITIAL_FOLLOW_NAV_STATE,
  latestFollowTarget,
} from './follow-file';

const posix: Workspace = { contentDir: '/home/me/notes', pathSeparator: '/' };
const windows: Workspace = { contentDir: 'C:\\Users\\me\\notes', pathSeparator: '\\' };

function call(overrides: Partial<RenderedToolCall>): RenderedToolCall {
  return {
    kind: 'tool_call',
    toolCallId: 'c1',
    title: 'Tool',
    toolKind: 'edit',
    status: 'in_progress',
    diffs: [],
    terminalIds: [],
    content: [],
    locations: [],
    rawInput: undefined,
    ...overrides,
  };
}

describe('docNameFromAbsolutePath', () => {
  test('maps markdown files inside the workspace to docNames', () => {
    expect(docNameFromAbsolutePath('/home/me/notes/plans/launch.md', posix)).toBe('plans/launch');
    expect(docNameFromAbsolutePath('/home/me/notes/intro.mdx', posix)).toBe('intro');
  });

  test('rejects paths outside the workspace and non-markdown files', () => {
    expect(docNameFromAbsolutePath('/etc/passwd', posix)).toBeNull();
    expect(docNameFromAbsolutePath('/home/me/notes-other/x.md', posix)).toBeNull();
    expect(docNameFromAbsolutePath('/home/me/notes/image.png', posix)).toBeNull();
  });

  test('handles Windows separators', () => {
    expect(docNameFromAbsolutePath('C:\\Users\\me\\notes\\a\\b.md', windows)).toBe('a/b');
  });
});

describe('followTargetFromToolCall', () => {
  test('OK MCP write (real Codex rawInput shape: arguments.document.path) resolves', () => {
    const target = followTargetFromToolCall(
      call({
        toolKind: 'execute',
        rawInput: {
          server: 'open-knowledge',
          tool: 'write',
          arguments: {
            cwd: '/somewhere',
            document: { path: 'orbit/plan', frontmatter: { title: 'Plan' } },
          },
        },
      }),
      posix,
    );
    expect(target).toBe('orbit/plan');
  });

  test('an .md-suffixed MCP doc path normalizes to the extension-less docName', () => {
    const target = followTargetFromToolCall(
      call({
        rawInput: {
          server: 'open-knowledge',
          tool: 'edit',
          arguments: { document: { path: 'orbit/plan.md', find: 'a', replace: 'b' } },
        },
      }),
      posix,
    );
    expect(target).toBe('orbit/plan');
  });

  test('batch write (documents[]) follows the LAST entry — the most recent write', () => {
    const target = followTargetFromToolCall(
      call({
        toolKind: 'execute',
        rawInput: {
          server: 'open-knowledge',
          tool: 'write',
          arguments: {
            cwd: '/somewhere',
            documents: [
              { path: 'articles/coffee/espresso', frontmatter: { title: 'Espresso' } },
              { path: 'articles/coffee/latte', frontmatter: { title: 'Latte' } },
              { path: 'articles/coffee/french-press', frontmatter: { title: 'French Press' } },
            ],
          },
        },
      }),
      posix,
    );
    expect(target).toBe('articles/coffee/french-press');
  });

  test('batch write skips non-object trailing entries; an empty batch is no target', () => {
    expect(
      followTargetFromToolCall(
        call({
          rawInput: {
            server: 'open-knowledge',
            tool: 'write',
            arguments: {
              documents: [{ path: 'articles/coffee/beans.md' }, 'junk'],
            },
          },
        }),
        posix,
      ),
    ).toBe('articles/coffee/beans');
    expect(
      followTargetFromToolCall(
        call({
          rawInput: {
            server: 'open-knowledge',
            tool: 'write',
            arguments: { documents: [] },
          },
        }),
        posix,
      ),
    ).toBeNull();
  });

  test('folder-creation write (folder.path, no documents) is not a doc target', () => {
    expect(
      followTargetFromToolCall(
        call({
          rawInput: {
            server: 'open-knowledge',
            tool: 'write',
            arguments: {
              cwd: '/somewhere',
              folder: { path: 'articles/coffee', frontmatter: { title: 'Coffee Wiki' } },
            },
          },
        }),
        posix,
      ),
    ).toBeNull();
  });

  test.each([
    'read',
    'search',
    'execute',
    'other',
  ] as const)('flat docName on a %s-shaped tool call never follows', (kind) => {
    expect(
      followTargetFromToolCall(
        call({
          toolKind: kind,
          rawInput: {
            server: 'open-knowledge',
            tool: 'history',
            arguments: { docName: 'notes/today' },
          },
        }),
        posix,
      ),
    ).toBeNull();
    expect(
      followTargetFromToolCall(
        call({ toolKind: kind, rawInput: { docName: 'notes/today' } }),
        posix,
      ),
    ).toBeNull();
  });

  test('flat docName argument shape also resolves', () => {
    const target = followTargetFromToolCall(
      call({
        toolKind: 'other',
        rawInput: {
          server: 'open-knowledge',
          tool: 'write',
          arguments: { docName: 'demo/plan', content: '# hi' },
        },
      }),
      posix,
    );
    expect(target).toBe('demo/plan');
  });

  test('arguments-direct rawInput shape also resolves', () => {
    expect(followTargetFromToolCall(call({ rawInput: { docName: 'notes/today' } }), null)).toBe(
      'notes/today',
    );
  });

  test('move follows the destination', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'move', arguments: { from: 'a', to: 'b' } } }),
        posix,
      ),
    ).toBe('b');
  });

  test('deletions never navigate', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'delete', arguments: { docName: 'gone' } } }),
        posix,
      ),
    ).toBeNull();
    expect(
      followTargetFromToolCall(
        call({ toolKind: 'delete', locations: [{ path: '/home/me/notes/x.md' }] }),
        posix,
      ),
    ).toBeNull();
  });

  test('falls back to the newest resolvable location', () => {
    const target = followTargetFromToolCall(
      call({
        locations: [
          { path: '/home/me/notes/first.md' },
          { path: '/elsewhere/skip.md' },
          { path: '/home/me/notes/deep/second.md', line: 4 },
        ],
      }),
      posix,
    );
    expect(target).toBe('deep/second');
  });

  test('sanitizes hostile docNames', () => {
    expect(
      followTargetFromToolCall(call({ rawInput: { docName: '../escape' } }), posix),
    ).toBeNull();
    expect(followTargetFromToolCall(call({ rawInput: { docName: '/abs' } }), posix)).toBeNull();
    expect(followTargetFromToolCall(call({ rawInput: { docName: '' } }), posix)).toBeNull();
  });

  test('skips dot-segment plumbing docs (agent skills, .ok config)', () => {
    expect(
      followTargetFromToolCall(
        call({
          toolKind: 'read',
          locations: [{ path: '/home/me/notes/.codex/skills/open-knowledge/SKILL.md' }],
        }),
        posix,
      ),
    ).toBeNull();
    expect(
      followTargetFromToolCall(call({ rawInput: { docName: '.ok/config' } }), posix),
    ).toBeNull();
  });

  test('JSON-string arguments (adapter-serialized) resolve like object arguments', () => {
    const target = followTargetFromToolCall(
      call({
        rawInput: {
          tool: 'write',
          arguments: JSON.stringify({ document: { path: 'wiki/tea', content: '# Tea' } }),
        },
      }),
      posix,
    );
    expect(target).toBe('wiki/tea');
  });

  test('tool name at `name` (adapter-dependent) still gates deletions', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { name: 'delete', arguments: { document: { path: 'wiki/tea' } } } }),
        posix,
      ),
    ).toBeNull();
  });

  test('bare-arguments delete is guarded by the call title', () => {
    expect(
      followTargetFromToolCall(
        call({
          title: 'open-knowledge - delete',
          rawInput: { document: { path: 'wiki/tea' } },
        }),
        posix,
      ),
    ).toBeNull();
  });

  test('template move (nested from/to) is not a document target', () => {
    expect(
      followTargetFromToolCall(
        call({
          rawInput: { tool: 'move', arguments: { template: { from: 'log/a', to: 'log/b' } } },
        }),
        posix,
      ),
    ).toBeNull();
  });
});

describe('followTargetFromToolCall — exec commands never follow', () => {
  test.each([
    [
      'cat with a relative markdown path',
      { tool: 'exec', arguments: { command: 'cat specs/foo/SPEC.md' } },
    ],
    [
      'quoted paths with spaces',
      { tool: 'exec', arguments: { command: 'cat "my notes/plan.md"' } },
    ],
    ['leading ./ normalization', { tool: 'exec', arguments: { command: 'head -25 ./readme.md' } }],
    [
      'flags-then-md operand',
      { tool: 'exec', arguments: { command: 'grep -rn oauth articles/auth.md' } },
    ],
    ['globs', { tool: 'exec', arguments: { command: 'head -25 specs/*/SPEC.md' } }],
    ['directory listing', { tool: 'exec', arguments: { command: 'ls specs/' } }],
    ['destructive head', { tool: 'exec', arguments: { command: 'rm wiki/tea.md' } }],
    [
      'absolute in-workspace path',
      { tool: 'exec', arguments: { command: 'cat /home/me/notes/wiki/tea.md' } },
    ],
    [
      'absolute out-of-workspace path',
      { tool: 'exec', arguments: { command: 'cat /etc/motd.md' } },
    ],
    ['piped md operand', { tool: 'exec', arguments: { command: 'cat notes.md | head -5' } }],
    ['bare command field (native terminal)', { command: 'cat wiki/tea.md' }],
  ])('%s never follows', (_label, rawInput) => {
    expect(followTargetFromToolCall(call({ toolKind: 'execute', rawInput }), posix)).toBeNull();
  });

  test('latestFollowTarget picks up the most recent write while ignoring intervening reads', () => {
    const items = [
      {
        kind: 'tool_call',
        toolKind: 'edit',
        title: 'write',
        locations: [],
        rawInput: { tool: 'write', arguments: { documents: [{ path: 'articles/caffeine' }] } },
      },
      {
        kind: 'tool_call',
        toolKind: 'execute',
        title: 'exec',
        locations: [],
        rawInput: { tool: 'exec', arguments: { command: 'cat log.md' } },
      },
    ];
    expect(latestFollowTarget(items, posix)).toBe('articles/caffeine');
  });
});

describe('followTargetFromToolCall — location-based follow is write-only', () => {
  test.each([
    'execute',
    'search',
    'other',
    'read',
  ] as const)('%s never navigates from its locations (even when the doc exists)', (kind) => {
    expect(
      followTargetFromToolCall(
        call({ toolKind: kind, locations: [{ path: '/home/me/notes/main.md' }] }),
        posix,
      ),
    ).toBeNull();
  });

  test('a move call names the destination — its location follows even when the doc does not exist yet', () => {
    expect(
      followTargetFromToolCall(
        call({
          toolKind: 'move',
          locations: [{ path: '/home/me/notes/renamed/destination.md' }],
        }),
        posix,
      ),
    ).toBe('renamed/destination');
  });

  test('an edit call may name a doc that does not exist YET — its location still follows', () => {
    expect(
      followTargetFromToolCall(
        call({ toolKind: 'edit', locations: [{ path: '/home/me/notes/brand/new-page.md' }] }),
        posix,
      ),
    ).toBe('brand/new-page');
  });

  test('latestFollowTarget ignores a read location and lands on the last write', () => {
    const items = [
      {
        kind: 'tool_call',
        toolKind: 'edit',
        title: 'write',
        locations: [{ path: '/home/me/notes/articles/caffeine.md' }],
        rawInput: undefined,
      },
      {
        kind: 'tool_call',
        toolKind: 'read',
        title: 'read',
        locations: [{ path: '/home/me/notes/main.md' }],
        rawInput: undefined,
      },
    ];
    expect(latestFollowTarget(items, posix)).toBe('articles/caffeine');
  });
});

describe('latestFollowTarget', () => {
  test('the last tool call with a resolvable target wins', () => {
    const items = [
      { kind: 'message' },
      call({ rawInput: { docName: 'one' } }),
      call({ rawInput: { tool: 'exec', arguments: { command: 'ls' } } }),
      call({ rawInput: { docName: 'two' } }),
      { kind: 'notice' },
    ];
    expect(latestFollowTarget(items, posix)).toBe('two');
  });

  test('null when nothing followable happened', () => {
    expect(latestFollowTarget([{ kind: 'message' }], posix)).toBeNull();
  });
});

describe('decideFollowNavigation', () => {
  const initial: FollowNavState = INITIAL_FOLLOW_NAV_STATE;

  test('no target → stay put, state unchanged', () => {
    expect(decideFollowNavigation(null, 'reading/here', initial)).toEqual({
      navigateTo: null,
      state: initial,
    });
  });

  test('first follow of a turn navigates and records the target', () => {
    expect(decideFollowNavigation('serafin', 'shagun-show-and-tell', initial)).toEqual({
      navigateTo: 'serafin',
      state: { lastFollowed: 'serafin', yielded: false, reArmed: false },
    });
  });

  test('same target again → no re-navigation', () => {
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    expect(decideFollowNavigation('serafin', 'serafin', state)).toEqual({
      navigateTo: null,
      state,
    });
  });

  test('agent moves to a new file while the reader stayed on track → follows along', () => {
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    expect(decideFollowNavigation('orbit/plan', 'serafin', state)).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
  });

  test('reader navigated off-track → yields, and stays yielded for later targets', () => {
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    const first = decideFollowNavigation('orbit/plan', 'shagun-show-and-tell', state);
    expect(first).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'serafin', yielded: true, reArmed: false },
    });
    const second = decideFollowNavigation('orbit/deep', 'shagun-show-and-tell', first.state);
    expect(second).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'serafin', yielded: true, reArmed: false },
    });
  });

  test('the user navigating to the exact new target is not treated as off-track', () => {
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    const decision = decideFollowNavigation('orbit/plan', 'orbit/plan', state);
    expect(decision).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
    expect(decideFollowNavigation('orbit/next', 'orbit/plan', decision.state).navigateTo).toBe(
      'orbit/next',
    );
  });

  test('an unknown current doc (null hash) on first follow still navigates', () => {
    expect(decideFollowNavigation('serafin', null, initial)).toEqual({
      navigateTo: 'serafin',
      state: { lastFollowed: 'serafin', yielded: false, reArmed: false },
    });
  });

  test('a null current hash after a prior follow still follows the next target', () => {
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    const decision = decideFollowNavigation('orbit/plan', null, state);
    expect(decision).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
  });

  test('a null current hash while yielded stays yielded (unknown hash does not un-latch)', () => {
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: true, reArmed: false };
    expect(decideFollowNavigation('orbit/plan', null, state)).toEqual({
      navigateTo: null,
      state,
    });
  });

  test('user opening the agent target while yielded does not clear the yield latch', () => {
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: true, reArmed: false };
    expect(decideFollowNavigation('orbit/plan', 'orbit/plan', state)).toEqual({
      navigateTo: null,
      state,
    });
  });

  test('re-armed state (fresh cold turn) follows a new target from a parked reader', () => {
    expect(decideFollowNavigation('orbit/plan', 'shagun-show-and-tell', initial)).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
  });

  test('turn boundary re-arm dedupes the stale followTarget (no yank to yesterday`s work)', () => {
    const yielded: FollowNavState = { lastFollowed: 'serafin', yielded: true, reArmed: false };
    const rearmed: FollowNavState = { ...yielded, yielded: false, reArmed: true };
    const staleTick = decideFollowNavigation('serafin', 'shagun-show-and-tell', rearmed);
    expect(staleTick).toEqual({ navigateTo: null, state: rearmed });
    const fresh = decideFollowNavigation('orbit/plan', 'shagun-show-and-tell', staleTick.state);
    expect(fresh).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
    const later = decideFollowNavigation('orbit/deep', 'shagun-show-and-tell', fresh.state);
    expect(later).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'orbit/plan', yielded: true, reArmed: false },
    });
  });
});
