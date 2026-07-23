import { describe, expect, test } from 'vitest';
import {
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
} from '../../logging/renderer-log.ts';
import { ClientLogsRequestSchema, ClientLogsSuccessSchema } from './client-logs.ts';

describe('ClientLogsRequestSchema', () => {
  test('accepts a valid batch with structured + plain entries', () => {
    const result = ClientLogsRequestSchema.safeParse({
      entries: [
        { level: 'warn', message: 'plain', ts: 1 },
        {
          level: 'info',
          message: '{"event":"x"}',
          event: 'x',
          fields: { reason: 'Failed to connect' },
          sourceId: 'app.js',
          lineNumber: 42,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('rejects an unknown level', () => {
    const result = ClientLogsRequestSchema.safeParse({
      entries: [{ level: 'debug', message: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects a batch over the entry cap', () => {
    const entries = Array.from({ length: RENDERER_LOG_MAX_ENTRIES + 1 }, () => ({
      level: 'info' as const,
      message: 'x',
    }));
    expect(ClientLogsRequestSchema.safeParse({ entries }).success).toBe(false);
  });

  test('accepts an optional droppedSinceLastFlush count; rejects a negative one', () => {
    const entries = [{ level: 'info' as const, message: 'x' }];
    expect(ClientLogsRequestSchema.safeParse({ entries, droppedSinceLastFlush: 3 }).success).toBe(
      true,
    );
    expect(ClientLogsRequestSchema.safeParse({ entries }).success).toBe(true);
    expect(ClientLogsRequestSchema.safeParse({ entries, droppedSinceLastFlush: -1 }).success).toBe(
      false,
    );
  });

  test('rejects an oversized message', () => {
    const result = ClientLogsRequestSchema.safeParse({
      entries: [{ level: 'error', message: 'a'.repeat(RENDERER_LOG_MAX_MESSAGE_BYTES + 1) }],
    });
    expect(result.success).toBe(false);
  });
});

describe('ClientLogsSuccessSchema', () => {
  test('accepts a non-negative accepted count', () => {
    expect(ClientLogsSuccessSchema.safeParse({ accepted: 2 }).success).toBe(true);
    expect(ClientLogsSuccessSchema.safeParse({ accepted: -1 }).success).toBe(false);
  });
});
