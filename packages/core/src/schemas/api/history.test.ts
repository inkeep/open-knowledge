import { describe, expect, test } from 'vitest';
import { ServerInfoSuccessSchema, WorkspaceSuccessSchema } from './index.ts';

describe('ServerInfoSuccessSchema', () => {
  test('parses minimal response (only required serverInstanceId)', () => {
    expect(
      ServerInfoSuccessSchema.safeParse({
        serverInstanceId: 'srv-deadbeef-1234',
      }).success,
    ).toBe(true);
  });

  test('parses fully-populated response with branch + per-doc disk-ack SVs', () => {
    expect(
      ServerInfoSuccessSchema.safeParse({
        serverInstanceId: 'srv-abc',
        currentBranch: 'main',
        currentDiskAckSVs: { 'docs/intro': 'AAAAAA', 'docs/notes': 'BBBBBB' },
      }).success,
    ).toBe(true);
  });

  test('rejects empty serverInstanceId', () => {
    expect(ServerInfoSuccessSchema.safeParse({ serverInstanceId: '' }).success).toBe(false);
  });

  test('rejects missing serverInstanceId', () => {
    expect(ServerInfoSuccessSchema.safeParse({}).success).toBe(false);
  });

  test('rejects empty docName key in currentDiskAckSVs (record value contract)', () => {
    expect(
      ServerInfoSuccessSchema.safeParse({
        serverInstanceId: 'srv-abc',
        currentDiskAckSVs: { '': 'AAAAAA' },
      }).success,
    ).toBe(false);
  });

  test('rejects empty SV value in currentDiskAckSVs', () => {
    expect(
      ServerInfoSuccessSchema.safeParse({
        serverInstanceId: 'srv-abc',
        currentDiskAckSVs: { 'docs/intro': '' },
      }).success,
    ).toBe(false);
  });

  test('preserves unknown extension fields (.loose())', () => {
    const result = ServerInfoSuccessSchema.safeParse({
      serverInstanceId: 'srv-abc',
      futureField: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).futureField).toBe(42);
    }
  });
});

describe('WorkspaceSuccessSchema', () => {
  test('parses POSIX shape', () => {
    expect(
      WorkspaceSuccessSchema.safeParse({
        contentDir: '/Users/n/projects/notes',
        pathSeparator: '/',
        symlinkResolved: true,
      }).success,
    ).toBe(true);
  });

  test('parses Windows shape', () => {
    expect(
      WorkspaceSuccessSchema.safeParse({
        contentDir: 'C:\\Users\\n\\projects\\notes',
        pathSeparator: '\\',
        symlinkResolved: false,
      }).success,
    ).toBe(true);
  });

  test('rejects unknown pathSeparator (closed enum)', () => {
    expect(
      WorkspaceSuccessSchema.safeParse({
        contentDir: '/x',
        pathSeparator: ':',
        symlinkResolved: false,
      }).success,
    ).toBe(false);
  });

  test('rejects empty contentDir', () => {
    expect(
      WorkspaceSuccessSchema.safeParse({
        contentDir: '',
        pathSeparator: '/',
        symlinkResolved: false,
      }).success,
    ).toBe(false);
  });

  test('rejects non-boolean symlinkResolved (no implicit coercion)', () => {
    expect(
      WorkspaceSuccessSchema.safeParse({
        contentDir: '/x',
        pathSeparator: '/',
        symlinkResolved: 'true',
      }).success,
    ).toBe(false);
  });

  test('rejects missing required fields', () => {
    expect(WorkspaceSuccessSchema.safeParse({}).success).toBe(false);
  });
});
