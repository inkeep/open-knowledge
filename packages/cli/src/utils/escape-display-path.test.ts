import { describe, expect, test } from 'vitest';
import { escapeDisplayPath } from './escape-display-path.ts';

describe('escapeDisplayPath', () => {
  test.each([
    ['\u001b', '\\u001b'],
    ['\r', '\\u000d'],
    ['\n', '\\u000a'],
    ['\u0085', '\\u0085'],
    ['\u2028', '\\u2028'],
    ['\u2029', '\\u2029'],
    ['\u061c', '\\u061c'],
    ['\u200b', '\\u200b'],
    ['\u200e', '\\u200e'],
    ['\u200f', '\\u200f'],
    ['\u202a', '\\u202a'],
    ['\u202b', '\\u202b'],
    ['\u202c', '\\u202c'],
    ['\u202d', '\\u202d'],
    ['\u202e', '\\u202e'],
    ['\u2066', '\\u2066'],
    ['\u2067', '\\u2067'],
    ['\u2068', '\\u2068'],
    ['\u2069', '\\u2069'],
    ['\ufeff', '\\ufeff'],
  ])('makes display control %j visible in a path', (control, visible) => {
    expect(escapeDisplayPath(`project/${control}notes`)).toBe(`project/${visible}notes`);
  });

  test('preserves script joiners, emoji and already-visible escapes', () => {
    const path = 'notes/क्\u200dष/می\u200cروم/👩\u200d💻/\\u202e.md';
    expect(escapeDisplayPath(path)).toBe(path);
  });
});
