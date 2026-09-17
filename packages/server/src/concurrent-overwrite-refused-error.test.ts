import { describe, expect, test } from 'vitest';
import { CONCURRENT_REPLACE_WINDOW_MS } from './agent-sessions.ts';
import { CONCURRENT_OVERWRITE_RETRY_AFTER_SECONDS } from './concurrent-overwrite-refused-error.ts';

describe('the advertised retry bound', () => {
  test('covers the guard window that decides when the refusal clears', () => {
    expect(CONCURRENT_OVERWRITE_RETRY_AFTER_SECONDS * 1000).toBeGreaterThanOrEqual(
      CONCURRENT_REPLACE_WINDOW_MS,
    );
  });
});
