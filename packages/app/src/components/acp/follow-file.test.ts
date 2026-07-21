import { describe, expect, test } from 'vitest';
import type { RenderedToolCall } from '@/lib/acp/thread-event-model';
import type { Workspace } from '@/lib/workspace-paths';
import {
  docNameFromAbsolutePath,
  followTargetFromToolCall,
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
    expect(
      followTargetFromToolCall(missingRead, posix, { commandTargetExists: exists }),
    ).toBeNull();
    // The same read WITH the doc present follows normally.
    expect(followTargetFromToolCall(missingRead, posix, { commandTargetExists: () => true })).toBe(
      'log',
    );
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
        { commandTargetExists: () => false },
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
    expect(latestFollowTarget(items, posix, { commandTargetExists: (d) => d !== 'log' })).toBe(
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
