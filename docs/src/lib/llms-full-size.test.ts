import { describe, expect, test } from 'vitest';
import {
  classifyLlmsFullSize,
  describeLlmsFullSize,
  LLMS_FULL_MAX_BYTES,
  LLMS_FULL_WARN_BYTES,
} from './llms-full-size.test-helper';

describe('llms-full.txt size ceiling', () => {
  test('passes a corpus comfortably inside the budget', () => {
    expect(classifyLlmsFullSize(709_000)).toBe('ok');
  });

  test('warns once the corpus passes the warning threshold', () => {
    expect(classifyLlmsFullSize(LLMS_FULL_WARN_BYTES)).toBe('ok');
    expect(classifyLlmsFullSize(LLMS_FULL_WARN_BYTES + 1)).toBe('warn');
  });

  test('fails once the corpus passes the ceiling', () => {
    expect(classifyLlmsFullSize(LLMS_FULL_MAX_BYTES)).toBe('warn');
    expect(classifyLlmsFullSize(LLMS_FULL_MAX_BYTES + 1)).toBe('fail');
  });

  test('reports the measurement and both thresholds so a failure is actionable', () => {
    expect(describeLlmsFullSize(6_000_000)).toBe(
      '/llms-full.txt is 6.0 MB (warn over 2.5 MB, fail over 5.0 MB)',
    );
  });
});
