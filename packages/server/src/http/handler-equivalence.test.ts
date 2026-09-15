import { describe, expect, test } from 'vitest';
import {
  handlerNames,
  normalizedHandler,
  orderedComments,
} from './handler-equivalence.test-helper.ts';

const HANDLER_NAME = 'handleExample';
const BASELINE = `
  const handleExample = () => {
    /* first */
    const value = 'two  spaces';
    return value;
  };
`;

describe('handler equivalence test helper', () => {
  test('normalizes syntax formatting without weakening literal comparisons', () => {
    const reformatted = `const handleExample=()=>{/* first */const value='two  spaces';return value;};`;
    const changedLiteral = BASELINE.replace('two  spaces', 'two spaces');
    expect(normalizedHandler(reformatted, HANDLER_NAME)).toEqual(
      normalizedHandler(BASELINE, HANDLER_NAME),
    );
    expect(normalizedHandler(changedLiteral, HANDLER_NAME)).not.toEqual(
      normalizedHandler(BASELINE, HANDLER_NAME),
    );
  });

  test('compares ordered comments independently from syntax', () => {
    const changedComment = BASELINE.replace('first', 'changed');
    expect(normalizedHandler(changedComment, HANDLER_NAME)).toEqual(
      normalizedHandler(BASELINE, HANDLER_NAME),
    );
    expect(orderedComments(changedComment, HANDLER_NAME)).not.toEqual(
      orderedComments(BASELINE, HANDLER_NAME),
    );
  });

  test('fails when the requested declaration is absent', () => {
    expect(() => normalizedHandler('const other = 1;', HANDLER_NAME)).toThrow(
      'handleExample is absent',
    );
  });

  test('fails on duplicate declarations and malformed source', () => {
    expect(() =>
      normalizedHandler(
        'const handleExample = () => 1; const handleExample = () => 2;',
        HANDLER_NAME,
      ),
    ).toThrow('duplicate handleExample');
    expect(() => normalizedHandler('const handleExample = () => {', HANDLER_NAME)).toThrow(
      'handler.ts must parse',
    );
  });

  test('lists handler variable declarations in source order', () => {
    expect(
      handlerNames('const handleOne = () => 1; const other = 2; const handleTwo = 3;'),
    ).toEqual(['handleOne', 'handleTwo']);
  });
});
