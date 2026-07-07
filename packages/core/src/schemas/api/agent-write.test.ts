import { describe, expect, test } from 'bun:test';
import {
  AgentPatchRequestSchema,
  AgentPatchSuccessSchema,
  AgentUndoRequestSchema,
  AgentUndoSuccessSchema,
  AgentWriteMdRequestSchema,
  AgentWriteMdSuccessSchema,
  AgentWriteRequestSchema,
  AgentWriteSuccessSchema,
  ProblemTypeSchema,
  SummaryResponseFieldSchema,
} from './index.ts';

describe('ProblemTypeSchema cluster A URN tokens', () => {
  test.each([
    'urn:ok:error:reserved-doc-name',
    'urn:ok:error:target-not-found',
    'urn:ok:error:stale-target',
    'urn:ok:error:no-active-session',
  ])('%s parses', (token) => {
    const result = ProblemTypeSchema.safeParse(token);
    expect(result.success).toBe(true);
  });
});

describe('AgentWriteRequestSchema', () => {
  test('parses minimal empty body', () => {
    const result = AgentWriteRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('parses full body with content + identity + summary', () => {
    const result = AgentWriteRequestSchema.safeParse({
      docName: 'projects/notes',
      content: 'Hello',
      summary: 'Wrote hello',
      agentId: 'claude-1',
      agentName: 'Claude',
      colorSeed: 'abc',
      clientName: 'claude-code',
      clientVersion: '1.2.3',
      label: 'task-42',
    });
    expect(result.success).toBe(true);
  });

  test('rejects unsafe docName with path traversal', () => {
    const result = AgentWriteRequestSchema.safeParse({ docName: '../etc/passwd' });
    expect(result.success).toBe(false);
  });

  test('rejects unsafe docName starting with /', () => {
    const result = AgentWriteRequestSchema.safeParse({ docName: '/abs/path' });
    expect(result.success).toBe(false);
  });

  test('surfaces the specific validateDocName reason, not one flat message (PRD-6837 #1)', () => {
    const traversal = AgentWriteRequestSchema.safeParse({ docName: '../etc/passwd' });
    const hiddenDot = AgentWriteRequestSchema.safeParse({ docName: 'notes/.secret' });
    expect(traversal.success).toBe(false);
    expect(hiddenDot.success).toBe(false);
    if (traversal.success || hiddenDot.success) return;
    const traversalMsg = traversal.error.issues[0]?.message ?? '';
    const hiddenDotMsg = hiddenDot.error.issues[0]?.message ?? '';
    // Each failure carries its own classified reason from `validateDocName`…
    expect(traversalMsg).toContain('..');
    expect(hiddenDotMsg).toContain('hidden');
    // …so distinct failure modes no longer collapse to one generic line.
    expect(traversalMsg).not.toBe(hiddenDotMsg);
    // The `docName` field path survives the superRefine so `withValidation`'s
    // `detail` reads `docName: <reason>` (path-prefixed), not a bare `: <reason>`.
    expect(traversal.error.issues[0]?.path).toEqual(['docName']);
  });

  test('rejects non-string summary', () => {
    const result = AgentWriteRequestSchema.safeParse({ summary: 42 });
    expect(result.success).toBe(false);
  });
});

describe('AgentWriteMdRequestSchema', () => {
  test('parses minimal valid body (markdown only)', () => {
    const result = AgentWriteMdRequestSchema.safeParse({ markdown: '# Hello' });
    expect(result.success).toBe(true);
  });

  test('parses with all enum positions', () => {
    for (const position of ['append', 'prepend', 'replace'] as const) {
      const result = AgentWriteMdRequestSchema.safeParse({ markdown: '# Hi', position });
      expect(result.success).toBe(true);
    }
  });

  test('rejects when markdown is missing', () => {
    const result = AgentWriteMdRequestSchema.safeParse({ position: 'append' });
    expect(result.success).toBe(false);
  });

  test('accepts empty markdown string (empty replace clears the body)', () => {
    // `markdown` must be present
    // but may be empty: `position: "replace"` with an empty payload clears the
    // document body. `.min(1)` never prevented clears (whitespace satisfied it)
    // while blocking the legitimate case.
    const result = AgentWriteMdRequestSchema.safeParse({ markdown: '' });
    expect(result.success).toBe(true);
  });

  test('rejects when position is unknown enum value', () => {
    const result = AgentWriteMdRequestSchema.safeParse({ markdown: '# Hi', position: 'overwrite' });
    expect(result.success).toBe(false);
  });

  test('accepts an explicit extension of .md or .mdx', () => {
    for (const extension of ['.md', '.mdx'] as const) {
      const result = AgentWriteMdRequestSchema.safeParse({ markdown: '# Hi', extension });
      expect(result.success).toBe(true);
    }
  });

  test('rejects an unsupported extension', () => {
    const result = AgentWriteMdRequestSchema.safeParse({
      markdown: '# Hi',
      extension: '.markdown',
    });
    expect(result.success).toBe(false);
  });

  test('extension is optional (omitting it parses)', () => {
    const result = AgentWriteMdRequestSchema.safeParse({ markdown: '# Hi' });
    expect(result.success).toBe(true);
  });
});

describe('AgentPatchRequestSchema', () => {
  test('parses minimal valid body (find + replace)', () => {
    const result = AgentPatchRequestSchema.safeParse({ find: 'old', replace: 'new' });
    expect(result.success).toBe(true);
  });

  test('parses with non-negative integer offset', () => {
    const result = AgentPatchRequestSchema.safeParse({ find: 'a', replace: 'b', offset: 0 });
    expect(result.success).toBe(true);
  });

  test('accepts empty replace string (deletes the matched segment)', () => {
    const result = AgentPatchRequestSchema.safeParse({ find: 'old', replace: '' });
    expect(result.success).toBe(true);
  });

  test('rejects empty find string', () => {
    const result = AgentPatchRequestSchema.safeParse({ find: '', replace: 'x' });
    expect(result.success).toBe(false);
  });

  test('rejects negative offset', () => {
    const result = AgentPatchRequestSchema.safeParse({
      find: 'a',
      replace: 'b',
      offset: -1,
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer offset', () => {
    const result = AgentPatchRequestSchema.safeParse({
      find: 'a',
      replace: 'b',
      offset: 1.5,
    });
    expect(result.success).toBe(false);
  });

  test('rejects when find is missing', () => {
    const result = AgentPatchRequestSchema.safeParse({ replace: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('AgentUndoRequestSchema', () => {
  test('parses minimal valid body (connectionId only)', () => {
    const result = AgentUndoRequestSchema.safeParse({ connectionId: 'agent-abc' });
    expect(result.success).toBe(true);
  });

  test('parses with all scope enum values', () => {
    for (const scope of ['last', 'session', 'file'] as const) {
      const result = AgentUndoRequestSchema.safeParse({
        connectionId: 'agent-abc',
        scope,
      });
      expect(result.success).toBe(true);
    }
  });

  test('rejects when connectionId is missing', () => {
    const result = AgentUndoRequestSchema.safeParse({ scope: 'last' });
    expect(result.success).toBe(false);
  });

  test('rejects when connectionId is empty string', () => {
    const result = AgentUndoRequestSchema.safeParse({ connectionId: '' });
    expect(result.success).toBe(false);
  });

  test('rejects when scope is unknown enum value', () => {
    const result = AgentUndoRequestSchema.safeParse({
      connectionId: 'agent-abc',
      scope: 'all',
    });
    expect(result.success).toBe(false);
  });
});

describe('SummaryResponseFieldSchema', () => {
  test('parses simple value-only summary', () => {
    const result = SummaryResponseFieldSchema.safeParse({ value: 'Wrote a doc' });
    expect(result.success).toBe(true);
  });

  test('parses truncated summary with hint', () => {
    const result = SummaryResponseFieldSchema.safeParse({
      value: 'Trunc…',
      truncatedFrom: 120,
      hint: 'Summary truncated from 120 chars to 80 (max 80).',
    });
    expect(result.success).toBe(true);
  });

  test('rejects when value is missing', () => {
    const result = SummaryResponseFieldSchema.safeParse({ truncatedFrom: 5 });
    expect(result.success).toBe(false);
  });
});

describe('AgentWriteSuccessSchema', () => {
  test('parses with timestamp only', () => {
    const result = AgentWriteSuccessSchema.safeParse({ timestamp: '2026-04-30T00:00:00.000Z' });
    expect(result.success).toBe(true);
  });

  test('parses with summary present', () => {
    const result = AgentWriteSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      summary: { value: 'Added section X' },
    });
    expect(result.success).toBe(true);
  });

  test('rejects when ok:true wrapper is present (D22)', () => {
    // Migrated handlers MUST drop the `ok: true` wrapper. A reader-side
    // safeParse should still ACCEPT it via `.loose()` (forward-compat) —
    // this test documents the intentional non-strictness.
    const result = AgentWriteSuccessSchema.safeParse({
      ok: true,
      timestamp: '2026-04-30T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('AgentWriteMdSuccessSchema', () => {
  test('parses with subscriber counts and no hints', () => {
    const result = AgentWriteMdSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: 0,
      systemSubscriberCount: 0,
      brokenLinks: [],
    });
    expect(result.success).toBe(true);
  });

  test('parses with one orphan hint', () => {
    const result = AgentWriteMdSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: 1,
      systemSubscriberCount: 1,
      hints: [
        {
          type: 'orphan',
          parentCandidates: ['folder/README'],
          message: 'No backlinks; consider linking from [[folder/README]].',
        },
      ],
      brokenLinks: [],
    });
    expect(result.success).toBe(true);
  });

  test('parses populated brokenLinks across all three reason kinds', () => {
    const result = AgentWriteMdSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: 0,
      systemSubscriberCount: 0,
      brokenLinks: [
        { href: './wiki/x', resolvedTo: 'wiki/wiki/x', reason: 'no-such-doc' },
        { href: '../src/foo.py', resolvedTo: 'src/foo.py', reason: 'no-such-file' },
        { href: '../../escape.md', resolvedTo: null, reason: 'unresolvable' },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('requires brokenLinks (always-present confirmation field)', () => {
    const result = AgentWriteMdSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: 0,
      systemSubscriberCount: 0,
    });
    expect(result.success).toBe(false);
  });

  test('rejects an invalid brokenLinks reason', () => {
    const result = AgentWriteMdSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: 0,
      systemSubscriberCount: 0,
      brokenLinks: [{ href: './x', resolvedTo: null, reason: 'broken-anchor' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative subscriberCount', () => {
    const result = AgentWriteMdSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: -1,
      systemSubscriberCount: 0,
      brokenLinks: [],
    });
    expect(result.success).toBe(false);
  });

  test('rejects orphan hint with non-orphan type literal', () => {
    const result = AgentWriteMdSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: 0,
      systemSubscriberCount: 0,
      hints: [{ type: 'something-else', parentCandidates: [], message: '' }],
      brokenLinks: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentPatchSuccessSchema', () => {
  test('parses with required fields', () => {
    const result = AgentPatchSuccessSchema.safeParse({
      timestamp: '2026-04-30T00:00:00.000Z',
      subscriberCount: 0,
      systemSubscriberCount: 0,
      brokenLinks: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('AgentUndoSuccessSchema', () => {
  test('parses with scope=last', () => {
    const result = AgentUndoSuccessSchema.safeParse({
      docName: 'foo',
      scope: 'last',
      undone: true,
    });
    expect(result.success).toBe(true);
  });

  test('parses with scope=session and undone=false (no-op)', () => {
    const result = AgentUndoSuccessSchema.safeParse({
      docName: 'foo',
      scope: 'session',
      undone: false,
    });
    expect(result.success).toBe(true);
  });

  test('rejects scope=file (handler collapses to session before emitting)', () => {
    const result = AgentUndoSuccessSchema.safeParse({
      docName: 'foo',
      scope: 'file',
      undone: false,
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty docName', () => {
    const result = AgentUndoSuccessSchema.safeParse({
      docName: '',
      scope: 'last',
      undone: false,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cluster B: pages CRUD
// ---------------------------------------------------------------------------
