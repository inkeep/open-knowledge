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
  pageListFollowOptions,
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
    // Real Codex rawInput shape from a live run: one `write` call carrying a
    // 12-page batch under `documents: [...]`. Before the batch branch existed
    // this resolved to null and the editor never followed the build.
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
    // The last OBJECT entry wins — a stray non-object tail (adapter quirk)
    // must not blank the whole batch.
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
    // Real shape from the same live run: `write` with `folder: {path}` creates
    // a folder — there is no document to follow.
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

describe('followTargetFromToolCall — exec command strings', () => {
  test('command reads of MISSING docs never navigate; write targets are not gated', () => {
    // Live-run regression: the agent ran `cat log.md` on a doc that was never
    // created, and follow parked the editor on a blank create-on-open tab.
    const missingRead = call({
      rawInput: { tool: 'exec', arguments: { command: 'cat log.md' } },
    });
    const exists = (docName: string) => docName !== 'log';
    expect(followTargetFromToolCall(missingRead, posix, { docExists: exists })).toBeNull();
    // The same read WITH the doc present follows normally.
    expect(followTargetFromToolCall(missingRead, posix, { docExists: () => true })).toBe('log');
    // No predicate (page list still loading) → ungated, previous behavior.
    expect(followTargetFromToolCall(missingRead, posix)).toBe('log');
    // Write targets may name docs that don't exist YET — never gated.
    expect(
      followTargetFromToolCall(
        call({
          rawInput: {
            tool: 'write',
            arguments: { document: { path: 'brand/new-page' } },
          },
        }),
        posix,
        { docExists: () => false },
      ),
    ).toBe('brand/new-page');
  });

  test('latestFollowTarget falls back past a gated command read to the last write', () => {
    const items = [
      {
        kind: 'tool_call',
        toolKind: 'execute',
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
    expect(latestFollowTarget(items, posix, { docExists: (d) => d !== 'log' })).toBe(
      'articles/caffeine',
    );
  });

  test('cat with a relative markdown path', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'cat specs/foo/SPEC.md' } } }),
        posix,
      ),
    ).toBe('specs/foo/SPEC');
  });

  test('quoted paths with spaces', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'cat "my notes/plan.md"' } } }),
        posix,
      ),
    ).toBe('my notes/plan');
  });

  test('leading ./ is normalized', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'head -25 ./readme.md' } } }),
        posix,
      ),
    ).toBe('readme');
  });

  test('flags are skipped; the first md operand wins', () => {
    expect(
      followTargetFromToolCall(
        call({
          rawInput: { tool: 'exec', arguments: { command: 'grep -rn oauth articles/auth.md' } },
        }),
        posix,
      ),
    ).toBe('articles/auth');
  });

  test('globs carry no single target', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'head -25 specs/*/SPEC.md' } } }),
        posix,
      ),
    ).toBeNull();
  });

  test('directory listings carry no doc target', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'ls specs/' } } }),
        posix,
      ),
    ).toBeNull();
  });

  test('non-read command heads never navigate', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'rm wiki/tea.md' } } }),
        posix,
      ),
    ).toBeNull();
  });

  test('absolute in-workspace paths map through the workspace root', () => {
    expect(
      followTargetFromToolCall(
        call({
          rawInput: { tool: 'exec', arguments: { command: 'cat /home/me/notes/wiki/tea.md' } },
        }),
        posix,
      ),
    ).toBe('wiki/tea');
  });

  test('absolute out-of-workspace paths resolve to null', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'cat /etc/motd.md' } } }),
        posix,
      ),
    ).toBeNull();
  });

  test('pipes: an md operand anywhere in the pipeline is found', () => {
    expect(
      followTargetFromToolCall(
        call({ rawInput: { tool: 'exec', arguments: { command: 'cat notes.md | head -5' } } }),
        posix,
      ),
    ).toBe('notes');
  });

  test('a native terminal command (bare command field) also follows', () => {
    expect(
      followTargetFromToolCall(
        call({ toolKind: 'execute', rawInput: { command: 'cat wiki/tea.md' } }),
        posix,
      ),
    ).toBe('wiki/tea');
  });
});

describe('followTargetFromToolCall — location existence gate', () => {
  test('a non-edit call whose newest location is a MISSING doc never navigates', () => {
    // Live-run regression: a read-shaped tool call resolved to a phantom doc
    // ("main"), and follow parked the editor on a blank create-on-open tab.
    // Read/search/exec locations are gated on existence.
    const missingLocation = call({
      toolKind: 'read',
      locations: [{ path: '/home/me/notes/main.md' }],
    });
    const exists = (docName: string) => docName !== 'main';
    expect(followTargetFromToolCall(missingLocation, posix, { docExists: exists })).toBeNull();
    // The same read WITH the doc present follows normally.
    expect(followTargetFromToolCall(missingLocation, posix, { docExists: () => true })).toBe(
      'main',
    );
    // No predicate (page list still loading) → ungated, previous behavior.
    expect(followTargetFromToolCall(missingLocation, posix)).toBe('main');
  });

  test('non-edit locations gate at the newest miss — no fall-through to an older valid location', () => {
    // Per-call semantic: on a gated miss the newest location wins the veto
    // and the call yields null; the loop must NOT `continue` to an older
    // location. A "be more helpful" refactor that swapped `return null` for
    // `continue` would let the editor silently follow a stale older path,
    // and the transcript-level `latestFollowTarget` fall-back (its own test
    // below) would never get a chance to route to the previous tool call.
    const missingNewest = call({
      toolKind: 'read',
      locations: [
        { path: '/home/me/notes/articles/existing.md' },
        { path: '/home/me/notes/main.md' },
      ],
    });
    expect(
      followTargetFromToolCall(missingNewest, posix, { docExists: (d) => d !== 'main' }),
    ).toBeNull();
  });

  test('every read-shaped toolKind (execute/search/other/read) is gated on location existence', () => {
    // The gate is `toolKind !== 'edit' && toolKind !== 'move'` — a narrowing
    // to `toolKind === 'read'` would re-open the phantom-tab class for
    // execute/search/other calls. The original live-run was an execute-shaped
    // call whose newest location resolved to `main`. Table-drive over the
    // read-shaped kinds so a future kind (`browse`?) needing exemption is
    // explicit at THIS gate, not silently masked.
    const gated = (docName: string) => docName !== 'main';
    for (const kind of ['execute', 'search', 'other', 'read'] as const) {
      const c = call({
        toolKind: kind,
        locations: [{ path: '/home/me/notes/main.md' }],
      });
      expect(followTargetFromToolCall(c, posix, { docExists: gated })).toBeNull();
    }
  });

  test('a move call names the destination — its location stays ungated (the rename case)', () => {
    // `move`'s newest location IS the destination path — by definition not
    // in the page list yet — so gating it on existence would suppress the
    // follow of every rename. The MCP path already treats `stringField(args,
    // 'to')` as write-shaped (ungated); the native-locations path must
    // agree. Without this exemption, `ok mv old new` reported through
    // `locations[]` would silently stop following once the rename lands.
    expect(
      followTargetFromToolCall(
        call({
          toolKind: 'move',
          locations: [{ path: '/home/me/notes/renamed/destination.md' }],
        }),
        posix,
        { docExists: () => false },
      ),
    ).toBe('renamed/destination');
  });

  test('an edit call may name a doc that does not exist YET — its location is not gated', () => {
    // The create case: a native write/edit names the doc it is about to
    // create, so following it before it lands is correct.
    expect(
      followTargetFromToolCall(
        call({ toolKind: 'edit', locations: [{ path: '/home/me/notes/brand/new-page.md' }] }),
        posix,
        { docExists: () => false },
      ),
    ).toBe('brand/new-page');
  });

  test('latestFollowTarget falls back past a gated missing read location to the last write', () => {
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
    expect(latestFollowTarget(items, posix, { docExists: (d) => d !== 'main' })).toBe(
      'articles/caffeine',
    );
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

describe('pageListFollowOptions', () => {
  test('null pageList (no provider — dock in hosts/tests) → no predicate', () => {
    // The ThreadView is rendered from surfaces that don't wrap it in a
    // PageListProvider (docks, standalone previews); the follow-file layer
    // must degrade to ungated navigation there, not throw.
    expect(pageListFollowOptions(null)).toEqual({});
  });

  test('loading pageList → no predicate (unknown ≠ missing during cold fetch)', () => {
    const opts = pageListFollowOptions({ loading: true, error: null, pages: new Set() });
    expect(opts).toEqual({});
  });

  test('errored pageList → no predicate (failed fetch cannot distinguish missing from unknown)', () => {
    // Load-bearing regression guard: if this drops back to `{ docExists:
    // pages.has }` on a failed fetch, follow-file silently stops for all
    // read-shaped targets until the next successful refetch — the empty
    // `pages` set gates every doc as missing. `error !== null` must keep
    // the predicate absent so the transient failure degrades to previous
    // ungated behavior instead of a silent user-visible stop.
    const opts = pageListFollowOptions({
      loading: false,
      error: 'Network error',
      pages: new Set(),
    });
    expect(opts).toEqual({});
  });

  test('errored pageList with non-empty pages → still no predicate', () => {
    // Even if the snapshot carries stale docs from a prior successful fetch,
    // an active error means we cannot trust the set as authoritative — the
    // safe pass-through is ungated, matching the loading branch.
    const opts = pageListFollowOptions({
      loading: false,
      error: 'stale',
      pages: new Set(['a']),
    });
    expect(opts).toEqual({});
  });

  test('loaded + no error → predicate delegates to `pages.has`', () => {
    const opts = pageListFollowOptions({
      loading: false,
      error: null,
      pages: new Set(['articles/caffeine', 'plans/launch']),
    });
    expect(opts.docExists).toBeDefined();
    expect(opts.docExists?.('articles/caffeine')).toBe(true);
    expect(opts.docExists?.('plans/launch')).toBe(true);
    expect(opts.docExists?.('main')).toBe(false);
    expect(opts.docExists?.('')).toBe(false);
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
    // Even when the reader is parked on another page: the first navigation of a
    // turn is follow catching up to the agent (you launched it), not a yank.
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
    // The editor is still where follow last put it (serafin) — the user has not
    // taken control, so follow tracks the agent to its next file.
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    expect(decideFollowNavigation('orbit/plan', 'serafin', state)).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
  });

  test('reader navigated off-track → yields, and stays yielded for later targets', () => {
    // The reported bug: user reading shagun while the agent moves to serafin.
    // The editor (shagun) is neither where follow last put them (serafin from an
    // earlier write) nor the new target — so follow yields instead of yanking.
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    const first = decideFollowNavigation('orbit/plan', 'shagun-show-and-tell', state);
    expect(first).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'serafin', yielded: true, reArmed: false },
    });
    // A further agent write does not resume the yank — the latch holds. Full
    // state assertion pins the invariant that `lastFollowed` stays on the
    // last real anchor ('serafin') and doesn't drift to the yielded target;
    // a refactor overwriting it would poison the next off-track comparison.
    const second = decideFollowNavigation('orbit/deep', 'shagun-show-and-tell', first.state);
    expect(second).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'serafin', yielded: true, reArmed: false },
    });
  });

  test('the user navigating to the exact new target is not treated as off-track', () => {
    // They landed where follow wanted them anyway — record it (no navigation),
    // and keep following so the next target still tracks.
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    const decision = decideFollowNavigation('orbit/plan', 'orbit/plan', state);
    expect(decision).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
    // Not yielded → the agent's next file still follows.
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
    // Guard the `currentDoc !== null` sub-clause of the off-track predicate:
    // an unknown hash (fresh mount, race between navigation and effect) must
    // NOT count as "user is off-track" — treating unknown as missing would
    // silently latch yielded mid-turn. Pinned so a refactor dropping the
    // null-guard fires this test.
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: false, reArmed: false };
    const decision = decideFollowNavigation('orbit/plan', null, state);
    expect(decision).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
  });

  test('a null current hash while yielded stays yielded (unknown hash does not un-latch)', () => {
    // Companion to the null-hash-fresh-mount case above: when yield is
    // already latched, an unknown hash must NOT reset it. A refactor that
    // treated `currentDoc === null` as "safe to follow again" would resume
    // driving navigation mid-turn even though the user had manually taken
    // control and their prior yield is still in effect.
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: true, reArmed: false };
    expect(decideFollowNavigation('orbit/plan', null, state)).toEqual({
      navigateTo: null,
      state, // unchanged — yielded stays latched.
    });
  });

  test('user opening the agent target while yielded does not clear the yield latch', () => {
    // The yielded guard runs BEFORE the currentDoc === followTarget branch
    // — deliberately. A reader who latched a yield earlier this turn and
    // then happens to open the agent's current file (via the omnibar or a
    // link) is not signaling "resume follow"; they're still directing
    // their own navigation. Pinned so a well-meaning reorder that lets
    // the target-match branch fire first (silently un-latching yield)
    // fails this test.
    const state: FollowNavState = { lastFollowed: 'serafin', yielded: true, reArmed: false };
    expect(decideFollowNavigation('orbit/plan', 'orbit/plan', state)).toEqual({
      navigateTo: null,
      state, // yielded stays latched; lastFollowed stays 'serafin'.
    });
  });

  test('re-armed state (fresh cold turn) follows a new target from a parked reader', () => {
    // Cold-start re-arm: no prior lastFollowed. `INITIAL_FOLLOW_NAV_STATE`
    // carries `reArmed: false`, but still behaves like a re-armed turn
    // because `lastFollowed === null` short-circuits off-track. Pins the
    // golden path — launch a fresh agent, editor tracks its first write
    // even if reader is on some unrelated doc.
    expect(decideFollowNavigation('orbit/plan', 'shagun-show-and-tell', initial)).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
  });

  test('turn boundary re-arm dedupes the stale followTarget (no yank to yesterday`s work)', () => {
    // The regression pullfrog surfaced: `followTarget` is scanned from the
    // accumulated event log and doesn't reset between turns, so a new turn
    // begins with the PREVIOUS turn's last file as `followTarget`. If the
    // re-arm zeroed `lastFollowed`, off-track would short-circuit false
    // (lastFollowed=null), the re-armed navigation would fire, and the
    // editor would yank to the stale target — no new agent work required.
    // Preserving `lastFollowed` on re-arm makes the stale target dedupe
    // via the `lastFollowed === followTarget` early return, and `reArmed`
    // stays intact for the NEXT fresh target this turn.
    const yielded: FollowNavState = { lastFollowed: 'serafin', yielded: true, reArmed: false };
    // Turn boundary re-arm: yielded cleared, reArmed set, lastFollowed preserved.
    const rearmed: FollowNavState = { ...yielded, yielded: false, reArmed: true };
    const staleTick = decideFollowNavigation('serafin', 'shagun-show-and-tell', rearmed);
    // Dedupe hit — no navigation to the stale target, state unchanged so
    // the bypass survives for the next real target.
    expect(staleTick).toEqual({ navigateTo: null, state: rearmed });
    // Now the agent actually produces new work; the re-arm bypass fires and
    // the user's new intent (they pressed send) wins over their prior yield.
    const fresh = decideFollowNavigation('orbit/plan', 'shagun-show-and-tell', staleTick.state);
    expect(fresh).toEqual({
      navigateTo: 'orbit/plan',
      state: { lastFollowed: 'orbit/plan', yielded: false, reArmed: false },
    });
    // reArmed is one-shot: a subsequent off-track target from the same turn
    // yields, matching the pre-re-arm semantics inside a single turn.
    const later = decideFollowNavigation('orbit/deep', 'shagun-show-and-tell', fresh.state);
    expect(later).toEqual({
      navigateTo: null,
      state: { lastFollowed: 'orbit/plan', yielded: true, reArmed: false },
    });
  });
});
