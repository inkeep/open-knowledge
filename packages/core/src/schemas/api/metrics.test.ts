import { describe, expect, test } from 'bun:test';
import {
  ActivityAgentHeaderSchema,
  ActivityBurstSchema,
  ActivityFileSchema,
  AgentActivitySuccessSchema,
  AgentBurstDiffSuccessSchema,
  AgentPresenceEntrySchema,
  InstalledAgentsSuccessSchema,
  MetricsAgentPresenceSuccessSchema,
  MetricsParseHealthSuccessSchema,
  MetricsReconciliationSuccessSchema,
  TestFlushGitSuccessSchema,
  TestRescanBacklinksSuccessSchema,
  TestRescanFilesSuccessSchema,
  TestResetSuccessSchema,
} from './index.ts';

describe('ActivityBurstSchema', () => {
  test('parses a happy-path burst', () => {
    expect(
      ActivityBurstSchema.safeParse({
        stackIndex: 0,
        ts: 1714512345000,
        additions: 12,
        deletions: 3,
      }).success,
    ).toBe(true);
  });
  test('rejects negative stackIndex', () => {
    expect(
      ActivityBurstSchema.safeParse({
        stackIndex: -1,
        ts: 1,
        additions: 0,
        deletions: 0,
      }).success,
    ).toBe(false);
  });
  test('rejects non-integer additions', () => {
    expect(
      ActivityBurstSchema.safeParse({
        stackIndex: 0,
        ts: 1,
        additions: 1.5,
        deletions: 0,
      }).success,
    ).toBe(false);
  });
});

describe('ActivityFileSchema', () => {
  test('parses a populated file entry', () => {
    expect(
      ActivityFileSchema.safeParse({
        docName: 'notes/draft',
        additionsTotal: 50,
        deletionsTotal: 20,
        lastTs: 1714512345000,
        bursts: [{ stackIndex: 0, ts: 1714512000000, additions: 10, deletions: 4 }],
      }).success,
    ).toBe(true);
  });
  test('parses an empty bursts array', () => {
    expect(
      ActivityFileSchema.safeParse({
        docName: 'notes/draft',
        additionsTotal: 0,
        deletionsTotal: 0,
        lastTs: 0,
        bursts: [],
      }).success,
    ).toBe(true);
  });
  test('rejects empty docName', () => {
    expect(
      ActivityFileSchema.safeParse({
        docName: '',
        additionsTotal: 0,
        deletionsTotal: 0,
        lastTs: 0,
        bursts: [],
      }).success,
    ).toBe(false);
  });
});

describe('ActivityAgentHeaderSchema', () => {
  test('parses a populated header', () => {
    expect(
      ActivityAgentHeaderSchema.safeParse({
        displayName: 'Claude',
        color: '#D97757',
        icon: 'claude',
        connectionId: 'agent-claude-1',
      }).success,
    ).toBe(true);
  });
  test('parses a header without optional icon', () => {
    expect(
      ActivityAgentHeaderSchema.safeParse({
        displayName: 'Cursor',
        color: '#1f2937',
        connectionId: 'agent-cursor-1',
      }).success,
    ).toBe(true);
  });
  test('rejects empty displayName', () => {
    expect(
      ActivityAgentHeaderSchema.safeParse({
        displayName: '',
        color: '#000',
        connectionId: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('AgentActivitySuccessSchema', () => {
  test('parses sessionAlive=false zero-state response', () => {
    expect(
      AgentActivitySuccessSchema.safeParse({
        sessionAlive: false,
        agent: null,
        files: [],
      }).success,
    ).toBe(true);
  });
  test('parses a populated response', () => {
    expect(
      AgentActivitySuccessSchema.safeParse({
        sessionAlive: true,
        agent: {
          displayName: 'Claude',
          color: '#D97757',
          connectionId: 'agent-1',
        },
        files: [
          {
            docName: 'a',
            additionsTotal: 10,
            deletionsTotal: 5,
            lastTs: 1,
            bursts: [],
          },
        ],
      }).success,
    ).toBe(true);
  });
  test('rejects body missing files array', () => {
    expect(AgentActivitySuccessSchema.safeParse({ sessionAlive: false, agent: null }).success).toBe(
      false,
    );
  });
});

describe('AgentBurstDiffSuccessSchema', () => {
  test('parses a populated diff response', () => {
    expect(
      AgentBurstDiffSuccessSchema.safeParse({
        diff: '@@ -1 +1 @@\n-old\n+new\n',
        generatedAt: 1714512345000,
      }).success,
    ).toBe(true);
  });
  test('parses an empty diff string', () => {
    expect(
      AgentBurstDiffSuccessSchema.safeParse({
        diff: '',
        generatedAt: 0,
      }).success,
    ).toBe(true);
  });
  test('rejects negative generatedAt', () => {
    expect(
      AgentBurstDiffSuccessSchema.safeParse({
        diff: '',
        generatedAt: -1,
      }).success,
    ).toBe(false);
  });
});

describe('TestResetSuccessSchema', () => {
  test('parses an empty body', () => {
    expect(TestResetSuccessSchema.safeParse({}).success).toBe(true);
  });
  test('parses a body with extra fields (.loose())', () => {
    expect(TestResetSuccessSchema.safeParse({ extraField: 'forward-compat' }).success).toBe(true);
  });
});

describe('TestRescanBacklinksSuccessSchema', () => {
  test('parses an empty body', () => {
    expect(TestRescanBacklinksSuccessSchema.safeParse({}).success).toBe(true);
  });
});

describe('TestRescanFilesSuccessSchema', () => {
  test('parses an empty body', () => {
    expect(TestRescanFilesSuccessSchema.safeParse({}).success).toBe(true);
  });
  test('parses a body with extra fields (.loose())', () => {
    expect(TestRescanFilesSuccessSchema.safeParse({ extraField: 'forward-compat' }).success).toBe(
      true,
    );
  });
});

describe('TestFlushGitSuccessSchema', () => {
  test('parses an empty body', () => {
    expect(TestFlushGitSuccessSchema.safeParse({}).success).toBe(true);
  });
  test('parses a body with extra fields (.loose())', () => {
    expect(TestFlushGitSuccessSchema.safeParse({ extraField: 'forward-compat' }).success).toBe(
      true,
    );
  });
});

describe('MetricsReconciliationSuccessSchema', () => {
  test('parses a typical metrics snapshot (.loose() permissive)', () => {
    expect(
      MetricsReconciliationSuccessSchema.safeParse({
        reconcileCount: 5,
        conflictCount: 0,
        cc1LastSeq: { 'doc-1': 12 },
      }).success,
    ).toBe(true);
  });
  test('parses an empty object', () => {
    expect(MetricsReconciliationSuccessSchema.safeParse({}).success).toBe(true);
  });
});

describe('MetricsParseHealthSuccessSchema', () => {
  test('parses a typical parse-health snapshot (.loose() permissive)', () => {
    expect(
      MetricsParseHealthSuccessSchema.safeParse({
        parseFallback: { blockLevel: 0, wholeDoc: 0 },
        ypsMismatch: { block: 0, inline: 0 },
      }).success,
    ).toBe(true);
  });
});

describe('AgentPresenceEntrySchema', () => {
  test('parses a writing entry', () => {
    expect(
      AgentPresenceEntrySchema.safeParse({
        displayName: 'Claude',
        icon: 'claude',
        color: '#D97757',
        currentDoc: 'notes/draft',
        mode: 'writing',
        ts: 1714512345000,
      }).success,
    ).toBe(true);
  });
  test('parses an idle entry with null currentDoc', () => {
    expect(
      AgentPresenceEntrySchema.safeParse({
        displayName: 'Claude',
        icon: 'claude',
        color: '#D97757',
        currentDoc: null,
        mode: 'idle',
        ts: 1714512345000,
      }).success,
    ).toBe(true);
  });
  test('rejects unknown mode', () => {
    expect(
      AgentPresenceEntrySchema.safeParse({
        displayName: 'Claude',
        icon: 'claude',
        color: '#D97757',
        currentDoc: null,
        mode: 'editing',
        ts: 1,
      }).success,
    ).toBe(false);
  });
});

describe('MetricsAgentPresenceSuccessSchema', () => {
  test('parses an empty presence map', () => {
    expect(
      MetricsAgentPresenceSuccessSchema.safeParse({
        presence: {},
      }).success,
    ).toBe(true);
  });
  test('parses a populated presence map', () => {
    expect(
      MetricsAgentPresenceSuccessSchema.safeParse({
        presence: {
          'agent-1': {
            displayName: 'Claude',
            icon: 'claude',
            color: '#D97757',
            currentDoc: 'a',
            mode: 'writing',
            ts: 1,
          },
        },
      }).success,
    ).toBe(true);
  });
  test('rejects body missing presence field', () => {
    expect(MetricsAgentPresenceSuccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('InstalledAgentsSuccessSchema', () => {
  test('parses a populated boolean record', () => {
    expect(
      InstalledAgentsSuccessSchema.safeParse({
        claude: true,
        codex: false,
        cursor: true,
      }).success,
    ).toBe(true);
  });
  test('parses an empty record', () => {
    expect(InstalledAgentsSuccessSchema.safeParse({}).success).toBe(true);
  });
  test('rejects non-boolean values', () => {
    expect(
      InstalledAgentsSuccessSchema.safeParse({
        claude: 'true',
      }).success,
    ).toBe(false);
  });
});

// LocalOp + auth -----------------------------------------
