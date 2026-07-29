import { describe, expect, test } from 'vitest';
import { recallComponentStack, rememberComponentStack } from './component-stack-registry';

describe('component-stack-registry', () => {
  test('round-trips a stack for the error it was recorded against', () => {
    const error = new Error('boom');
    rememberComponentStack(error, '\n    at Editor (bundle.js:1:1)\n');

    expect(recallComponentStack(error)).toBe('\n    at Editor (bundle.js:1:1)\n');
  });

  test('keys on the thrown value so a nested boundary cannot leak into an outer one', () => {
    const inner = new Error('inner');
    const outer = new Error('outer');
    rememberComponentStack(inner, '    at DocumentBoundary');

    expect(recallComponentStack(outer)).toBeUndefined();
  });

  test('ignores primitives, which cannot key the registry', () => {
    rememberComponentStack('a thrown string', '    at Editor');

    expect(recallComponentStack('a thrown string')).toBeUndefined();
    expect(recallComponentStack(null)).toBeUndefined();
    expect(recallComponentStack(undefined)).toBeUndefined();
  });

  test('ignores absent and blank stacks so the report omits the section entirely', () => {
    const missing = new Error('missing');
    const blank = new Error('blank');
    const nulled = new Error('nulled');
    rememberComponentStack(missing, undefined);
    rememberComponentStack(blank, '   \n  ');
    rememberComponentStack(nulled, null);

    expect(recallComponentStack(missing)).toBeUndefined();
    expect(recallComponentStack(blank)).toBeUndefined();
    expect(recallComponentStack(nulled)).toBeUndefined();
  });

  test('a later record for the same error wins', () => {
    const error = new Error('boom');
    rememberComponentStack(error, '    at First');
    rememberComponentStack(error, '    at Second');

    expect(recallComponentStack(error)).toBe('    at Second');
  });
});
