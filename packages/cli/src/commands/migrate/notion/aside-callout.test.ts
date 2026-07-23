import { describe, expect, test } from 'vitest';
import { asideToCallout } from './aside-callout.ts';

describe('asideToCallout', () => {
  test('converts a simple aside to a note callout, dropping the leading emoji', () => {
    const input = '<aside>\n👋 Welcome to the team!\n</aside>';
    expect(asideToCallout(input)).toBe('> [!note]\n> Welcome to the team!');
  });

  test('blockquote-prefixes multi-line content including blank lines and lists', () => {
    const input = [
      '<aside>',
      'Questions? Reach us:',
      '',
      '- Slack channel',
      '- Email',
      '</aside>',
    ].join('\n');
    const expected = [
      '> [!note]',
      '> Questions? Reach us:',
      '>',
      '> - Slack channel',
      '> - Email',
    ].join('\n');
    expect(asideToCallout(input)).toBe(expected);
  });

  test('does not emit blank > lines when the first line is only an emoji', () => {
    const input = '<aside>\n💡\n\nThis deck is based on an article.\n</aside>';
    expect(asideToCallout(input)).toBe('> [!note]\n> This deck is based on an article.');
  });

  test('converts multiple asides in one document', () => {
    const input = '<aside>\nOne\n</aside>\n\ntext\n\n<aside>\nTwo\n</aside>';
    expect(asideToCallout(input)).toBe('> [!note]\n> One\n\ntext\n\n> [!note]\n> Two');
  });

  test('is idempotent — no aside tags remain after conversion', () => {
    const input = '<aside>\n💡 Tip here\n</aside>';
    const once = asideToCallout(input);
    expect(asideToCallout(once)).toBe(once);
    expect(once).not.toContain('<aside>');
  });
});
