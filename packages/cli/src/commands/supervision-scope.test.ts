import { describe, expect, test } from 'vitest';
import { requiresProjectConfigForV1 } from './supervision-scope.ts';

describe('versioned supervision project config scope', () => {
  test.each([
    ['ps', [], false],
    ['ps', ['all'], false],
    ['stop', ['all'], false],
    ['stop', ['4242'], false],
    ['stop', [], true],
    ['stop', ['/tmp/wiki'], true],
    ['status', [], true],
    ['clean', [], true],
  ] as const)('%s %j requires project config: %s', (command, args, expected) => {
    expect(requiresProjectConfigForV1(command, args)).toBe(expected);
  });
});
