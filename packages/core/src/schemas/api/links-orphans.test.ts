import { describe, expect, test } from 'bun:test';
import {
  DeadLinkEntrySchema,
  DeadLinkSourceSchema,
  DeadLinksSuccessSchema,
  HubEntrySchema,
  HubsSuccessSchema,
  OrphanEntrySchema,
  OrphansSuccessSchema,
  SuggestLinksMentionSchema,
  SuggestLinksSuccessSchema,
  SuggestLinksTargetSchema,
} from './index.ts';

describe('OrphanEntrySchema', () => {
  test('accepts a populated entry', () => {
    expect(OrphanEntrySchema.safeParse({ docName: 'lonely', title: 'Lonely Page' }).success).toBe(
      true,
    );
  });
  test('accepts empty title (handler falls back to docName for missing H1)', () => {
    expect(OrphanEntrySchema.safeParse({ docName: 'lonely', title: '' }).success).toBe(true);
  });
  test('rejects empty docName', () => {
    expect(OrphanEntrySchema.safeParse({ docName: '', title: 'X' }).success).toBe(false);
  });
});

describe('OrphansSuccessSchema', () => {
  test('parses an empty list', () => {
    expect(OrphansSuccessSchema.safeParse({ orphans: [] }).success).toBe(true);
  });
  test('parses a populated list', () => {
    expect(
      OrphansSuccessSchema.safeParse({
        orphans: [
          { docName: 'a', title: 'A' },
          { docName: 'b', title: 'B' },
        ],
      }).success,
    ).toBe(true);
  });
  test('preserves unknown fields per .loose() forward-compat', () => {
    expect(
      OrphansSuccessSchema.safeParse({ orphans: [], extension: { future: true } }).success,
    ).toBe(true);
  });
});

describe('HubEntrySchema', () => {
  test('accepts a populated entry', () => {
    expect(HubEntrySchema.safeParse({ docName: 'index', title: 'Index', count: 42 }).success).toBe(
      true,
    );
  });
  test('accepts count=0 (technically possible if a hub registers but loses backlinks)', () => {
    expect(HubEntrySchema.safeParse({ docName: 'x', title: 'X', count: 0 }).success).toBe(true);
  });
  test('rejects negative count', () => {
    expect(HubEntrySchema.safeParse({ docName: 'x', title: 'X', count: -1 }).success).toBe(false);
  });
  test('rejects non-integer count', () => {
    expect(HubEntrySchema.safeParse({ docName: 'x', title: 'X', count: 1.5 }).success).toBe(false);
  });
});

describe('HubsSuccessSchema', () => {
  test('parses an empty list', () => {
    expect(HubsSuccessSchema.safeParse({ hubs: [] }).success).toBe(true);
  });
  test('parses a populated list', () => {
    expect(
      HubsSuccessSchema.safeParse({
        hubs: [{ docName: 'index', title: 'Index', count: 5 }],
      }).success,
    ).toBe(true);
  });
});

describe('DeadLinkSourceSchema', () => {
  test('accepts a populated source with snippet', () => {
    expect(
      DeadLinkSourceSchema.safeParse({
        source: 'alpha',
        title: 'Alpha',
        snippet: 'See missing-target.',
      }).success,
    ).toBe(true);
  });
  test('accepts null snippet (empty doc / no surrounding text)', () => {
    expect(DeadLinkSourceSchema.safeParse({ source: 'a', title: 'A', snippet: null }).success).toBe(
      true,
    );
  });
});

describe('DeadLinkEntrySchema', () => {
  test('accepts populated sources array', () => {
    expect(
      DeadLinkEntrySchema.safeParse({
        target: 'missing',
        sources: [{ source: 'alpha', title: 'Alpha', snippet: 'See missing.' }],
      }).success,
    ).toBe(true);
  });
  test('accepts empty sources array', () => {
    expect(DeadLinkEntrySchema.safeParse({ target: 'missing', sources: [] }).success).toBe(true);
  });
  test('rejects empty target', () => {
    expect(DeadLinkEntrySchema.safeParse({ target: '', sources: [] }).success).toBe(false);
  });
});

describe('DeadLinksSuccessSchema', () => {
  test('parses an empty list', () => {
    expect(DeadLinksSuccessSchema.safeParse({ deadLinks: [] }).success).toBe(true);
  });
  test('parses a populated list', () => {
    expect(
      DeadLinksSuccessSchema.safeParse({
        deadLinks: [
          {
            target: 'missing',
            sources: [{ source: 'alpha', title: 'Alpha', snippet: 'See missing.' }],
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('SuggestLinksTargetSchema', () => {
  test('accepts a populated target', () => {
    expect(
      SuggestLinksTargetSchema.safeParse({
        docName: 'project-alpha',
        title: 'Project Alpha',
        aliases: ['alpha-project', 'PA'],
      }).success,
    ).toBe(true);
  });
  test('accepts empty aliases', () => {
    expect(
      SuggestLinksTargetSchema.safeParse({
        docName: 'project-alpha',
        title: 'Project Alpha',
        aliases: [],
      }).success,
    ).toBe(true);
  });
  test('rejects non-array aliases', () => {
    expect(
      SuggestLinksTargetSchema.safeParse({
        docName: 'p',
        title: 'P',
        aliases: 'alpha',
      }).success,
    ).toBe(false);
  });
});

describe('SuggestLinksMentionSchema', () => {
  test('accepts a populated mention', () => {
    expect(
      SuggestLinksMentionSchema.safeParse({
        source: 'notes',
        excerpt: 'Project Alpha is shipping next week.',
        offset: 0,
      }).success,
    ).toBe(true);
  });
  test('accepts empty excerpt', () => {
    expect(
      SuggestLinksMentionSchema.safeParse({ source: 'notes', excerpt: '', offset: 0 }).success,
    ).toBe(true);
  });
  test('rejects negative offset', () => {
    expect(
      SuggestLinksMentionSchema.safeParse({ source: 'notes', excerpt: 'x', offset: -1 }).success,
    ).toBe(false);
  });
});

describe('SuggestLinksSuccessSchema', () => {
  test('parses an empty mentions array', () => {
    expect(
      SuggestLinksSuccessSchema.safeParse({
        target: { docName: 'p', title: 'P', aliases: [] },
        mentions: [],
        truncated: false,
      }).success,
    ).toBe(true);
  });
  test('parses a populated response with truncation', () => {
    expect(
      SuggestLinksSuccessSchema.safeParse({
        target: { docName: 'p', title: 'P', aliases: ['p-alias'] },
        mentions: [{ source: 'notes', excerpt: 'P found here.', offset: 0 }],
        truncated: true,
      }).success,
    ).toBe(true);
  });
});

