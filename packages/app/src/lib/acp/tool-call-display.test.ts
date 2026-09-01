import { OPEN_KNOWLEDGE_MCP_TOOLS } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { describeToolCall } from './tool-call-display';

describe('describeToolCall — Open Knowledge MCP tools', () => {
  test('Claude names the tool in the title and puts the arguments in rawInput', () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__write',
        toolKind: 'other',
        rawInput: {
          cwd: '/Users/mike/src/agents-private/public/open-knowledge',
          summary: 'Map every OK data store',
          document: { path: 'reports/data-architecture/REPORT.md', content: '# Data' },
        },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge wrote to reports/data-architecture/REPORT' });
  });

  test('Codex wraps the call in a server/tool/arguments envelope', () => {
    expect(
      describeToolCall({
        title: 'mcp.open-knowledge.edit',
        toolKind: 'execute',
        rawInput: {
          server: 'open-knowledge',
          tool: 'edit',
          arguments: {
            cwd: '/Users/mike/Documents/OpenKnowledge/wine',
            summary: 'Added Sauvignon Blanc stub metadata',
            document: { path: 'articles/sauvignon-blanc.md', frontmatter: { title: 'SB' } },
          },
        },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge edited articles/sauvignon-blanc' });
  });

  test("Pi has no MCP namespacing, so OK's extension prefixes the tool instead", () => {
    expect(describeToolCall({ title: 'ok_exec', toolKind: 'other', rawInput: {} })).toEqual({
      glyph: 'execute',
      text: 'OpenKnowledge ran a command',
    });
  });

  test('a batch write reports how many documents it touched', () => {
    expect(
      describeToolCall({
        title: 'mcp.open-knowledge.write',
        toolKind: 'execute',
        rawInput: {
          server: 'open-knowledge',
          tool: 'write',
          arguments: {
            cwd: '/Users/mike/Documents/OpenKnowledge/wine',
            documents: [
              { path: 'articles/malbec', template: 'article' },
              { path: 'articles/sauvignon-blanc', template: 'article' },
            ],
          },
        },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge wrote to 2 documents' });
  });

  test('a search reads back the query it ran', () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__search',
        toolKind: 'other',
        rawInput: { cwd: '/repo', query: 'bordeaux blend', limit: 5 },
      }),
    ).toEqual({ glyph: 'search', text: 'OpenKnowledge searched for bordeaux blend' });
  });

  test('an exec reads back the command, collapsed onto one line', () => {
    expect(
      describeToolCall({
        title: 'mcp.open-knowledge.exec',
        toolKind: 'execute',
        rawInput: {
          server: 'open-knowledge',
          tool: 'exec',
          arguments: { cwd: '/repo', command: 'ls -A\n  articles' },
        },
      }),
    ).toEqual({ glyph: 'execute', text: 'OpenKnowledge ran ls -A articles' });
  });

  test('a move names both ends', () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__move',
        toolKind: 'other',
        rawInput: { from: 'notes/draft.md', to: 'articles/draft.md' },
      }),
    ).toEqual({ glyph: 'move', text: 'OpenKnowledge moved notes/draft to articles/draft' });
  });

  test('the arguments stream in, so a call with none yet still reads as OK work', () => {
    expect(
      describeToolCall({ title: 'mcp__open-knowledge__write', toolKind: 'other', rawInput: {} }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge wrote a document' });
  });

  test('the non-document tools get their own glyphs', () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__lint',
        toolKind: 'other',
        rawInput: { cwd: '/repo', document: 'articles/malbec' },
      }),
    ).toEqual({ glyph: 'check', text: 'OpenKnowledge checked articles/malbec' });
    expect(
      describeToolCall({
        title: 'mcp.open-knowledge.audit',
        toolKind: 'execute',
        rawInput: {
          server: 'open-knowledge',
          tool: 'audit',
          arguments: { cwd: '/repo', path: 'articles' },
        },
      }),
    ).toEqual({ glyph: 'check', text: 'OpenKnowledge checked articles' });
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__history',
        toolKind: 'other',
        rawInput: { document: 'log' },
      }),
    ).toEqual({ glyph: 'history', text: 'OpenKnowledge read the history of log' });
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__links',
        toolKind: 'other',
        rawInput: { kind: 'backlinks', document: 'articles/merlot' },
      }),
    ).toEqual({ glyph: 'link', text: 'OpenKnowledge looked up links for articles/merlot' });
  });

  test('an envelope without a server key still identifies the tool', () => {
    expect(
      describeToolCall({
        title: 'MCP: tool',
        toolKind: 'other',
        rawInput: { tool: 'edit', arguments: { document: { path: 'articles/merlot.md' } } },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge edited articles/merlot' });
  });

  test('arguments serialized as a JSON string are parsed, not dropped', () => {
    expect(
      describeToolCall({
        title: 'mcp.open-knowledge.write',
        toolKind: 'execute',
        rawInput: {
          server: 'open-knowledge',
          tool: 'write',
          arguments: JSON.stringify({ document: { path: 'meetings/standup' } }),
        },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge wrote to meetings/standup' });
  });

  test('a tool reported under `name` is identified', () => {
    expect(
      describeToolCall({
        title: 'MCP: tool',
        toolKind: 'other',
        rawInput: { name: 'search', arguments: { query: 'bordeaux' } },
      }),
    ).toEqual({ glyph: 'search', text: 'OpenKnowledge searched for bordeaux' });
  });

  test("a skill's `name` argument is not mistaken for the tool name", () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__install',
        toolKind: 'other',
        rawInput: { name: 'trip-log' },
      }),
    ).toEqual({ glyph: 'install', text: 'OpenKnowledge installed trip-log' });
  });

  test('resolve_conflict names its target with a bare `file` string', () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__resolve_conflict',
        toolKind: 'other',
        rawInput: { file: 'notes/sso.md', strategy: 'mine' },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge resolved a conflict in notes/sso' });
  });

  test('template and asset writes name what they wrote', () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__write',
        toolKind: 'other',
        rawInput: { template: { path: 'fishing-log/trip-log', content: '# {{date}}' } },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge wrote to fishing-log/trip-log' });
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__write',
        toolKind: 'other',
        rawInput: { asset: { path: 'images/diagram.png' } },
      }),
    ).toEqual({ glyph: 'edit', text: 'OpenKnowledge wrote to images/diagram.png' });
  });

  test('every registered tool has its own copy, none falls through', () => {
    for (const tool of OPEN_KNOWLEDGE_MCP_TOOLS) {
      const { text } = describeToolCall({
        title: `mcp__open-knowledge__${tool}`,
        toolKind: 'other',
        rawInput: {},
      });
      expect(text).not.toBe(`OpenKnowledge ran ${tool}`);
      expect(text.startsWith('OpenKnowledge ')).toBe(true);
    }
  });

  test('a two-word tool name survives the split', () => {
    expect(
      describeToolCall({
        title: 'mcp__open-knowledge__preview_url',
        toolKind: 'other',
        rawInput: {},
      }),
    ).toEqual({ glyph: 'fetch', text: 'OpenKnowledge opened the live preview' });
    expect(
      describeToolCall({ title: 'ok_restore_version', toolKind: 'other', rawInput: {} }),
    ).toEqual({ glyph: 'restore', text: 'OpenKnowledge restored an earlier version' });
  });
});

describe('describeToolCall — everything that is not an OK tool', () => {
  test("an ordinary call keeps the adapter's title and takes its glyph from the kind", () => {
    expect(
      describeToolCall({
        title: 'git status --short',
        toolKind: 'execute',
        rawInput: { command: 'git status --short' },
      }),
    ).toEqual({ glyph: 'execute', text: 'git status --short' });
    expect(
      describeToolCall({
        title: "Read file '/Users/mike/notes/SKILL.md'",
        toolKind: 'read',
        rawInput: null,
      }),
    ).toEqual({ glyph: 'read', text: "Read file '/Users/mike/notes/SKILL.md'" });
  });

  test("Cursor's opaque MCP label falls through rather than guessing", () => {
    expect(describeToolCall({ title: 'MCP: tool', toolKind: 'other', rawInput: {} })).toEqual({
      glyph: 'other',
      text: 'MCP: tool',
    });
  });

  test("another server's MCP tool is not claimed as ours", () => {
    expect(
      describeToolCall({
        title: 'mcp__linear-server__list_issues',
        toolKind: 'other',
        rawInput: { teamId: 'abc' },
      }),
    ).toEqual({ glyph: 'other', text: 'mcp__linear-server__list_issues' });
    expect(
      describeToolCall({
        title: 'mcp.github.create_issue',
        toolKind: 'execute',
        rawInput: { server: 'github', tool: 'create_issue', arguments: {} },
      }),
    ).toEqual({ glyph: 'execute', text: 'mcp.github.create_issue' });
  });

  test('an ok-prefixed tool OK does not serve keeps its own name', () => {
    expect(describeToolCall({ title: 'ok_deploy', toolKind: 'execute', rawInput: {} })).toEqual({
      glyph: 'execute',
      text: 'ok_deploy',
    });
  });

  test('an unknown kind falls back to the generic glyph', () => {
    expect(
      describeToolCall({ title: 'Something new', toolKind: 'teleport', rawInput: undefined }),
    ).toEqual({ glyph: 'other', text: 'Something new' });
  });

  test('every ACP tool kind resolves to its own glyph', () => {
    const kinds = [
      'read',
      'edit',
      'delete',
      'move',
      'search',
      'execute',
      'think',
      'fetch',
      'switch_mode',
      'other',
    ];
    const glyphs = kinds.map(
      (toolKind) => describeToolCall({ title: 'x', toolKind, rawInput: undefined }).glyph,
    );
    expect(glyphs).toEqual(kinds);
    expect(new Set(glyphs).size).toBe(kinds.length);
  });
});
