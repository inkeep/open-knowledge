import { describe, expect, test, vi } from 'vitest';
import { thoughtPreview } from './thought-preview.ts';

describe('thoughtPreview', () => {
  test('a settled thought previews its first line as plain text', () => {
    expect(thoughtPreview('**Planning the change**\n\nThen the tests.', false)).toBe(
      'Planning the change',
    );
  });

  test('a streaming thought previews its last line as plain text', () => {
    expect(thoughtPreview('**Planning the change**\n\nNow **checking the te', true)).toBe(
      'Now checking the te',
    );
  });

  test('a streaming thought converts only its last paragraph', () => {
    const toPlainText = vi.fn((markdown: string) => markdown);
    const earlier = 'An earlier paragraph. '.repeat(500);

    expect(thoughtPreview(`${earlier}\n\nThe latest words`, true, toPlainText)).toBe(
      'The latest words',
    );
    expect(toPlainText).toHaveBeenCalledTimes(1);
    expect(toPlainText).toHaveBeenCalledWith('The latest words');
  });

  test('a paragraph break that holds spaces still ends the earlier paragraph', () => {
    const toPlainText = vi.fn((markdown: string) => markdown);

    thoughtPreview('Earlier\n  \nLatest', true, toPlainText);

    expect(toPlainText).toHaveBeenCalledWith('Latest');
  });

  test.each([
    ['Plan\n\n```py\nx = 1\n\n# retry the call', '# retry the call'],
    ['Plan\n\n```js\nconst a = 1\n\nconst b = a**2', 'const b = a**2'],
    ['Plan\n\n~~~\nfirst\n\n- not a list', '- not a list'],
  ])('a blank line inside a code fence still streaming in keeps %j literal', (text, preview) => {
    expect(thoughtPreview(text, true)).toBe(preview);
  });

  test('a code line still streaming in is shown as written, without converting anything', () => {
    const toPlainText = vi.fn((markdown: string) => markdown);

    expect(thoughtPreview('Plan\n\n```py\nx  =  1', true, toPlainText)).toBe('x = 1');
    expect(toPlainText).not.toHaveBeenCalled();
  });

  test('a closed code fence with a blank line inside stays one block', () => {
    expect(thoughtPreview('Plan\n\n```\nx = 1\n\n# not a heading\n```', true)).toBe(
      '# not a heading',
    );
  });

  test('a paragraph after a closed code fence starts a new block', () => {
    const toPlainText = vi.fn((markdown: string) => markdown);

    thoughtPreview('```\ncode\n```\n\nAfter the fence', true, toPlainText);

    expect(toPlainText).toHaveBeenCalledWith('After the fence');
  });

  test('a streaming thought whose last paragraph has no text yet previews the line before it', () => {
    expect(thoughtPreview('Planning the edit\n\n```ts', true)).toBe('Planning the edit');
  });
});
