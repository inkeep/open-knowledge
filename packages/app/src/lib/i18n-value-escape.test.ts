import { type Messages, setupI18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

function freshI18n(messages: Messages) {
  const i18n = setupI18n();
  i18n.load('en', messages);
  i18n.activate('en');
  return i18n;
}

describe('lingui escape decoding (patched @lingui/core)', () => {
  it('leaves \\x / \\u sequences inside interpolated values verbatim', () => {
    const i18n = freshI18n({ msg: 'Will be created at: {path}' });
    expect(i18n._('msg', { path: 'C:\\Users\\x64qa' })).toBe(
      'Will be created at: C:\\Users\\x64qa',
    );
    expect(i18n._('msg', { path: 'C:\\Users\\u0041bcd' })).toBe(
      'Will be created at: C:\\Users\\u0041bcd',
    );
  });

  it('still decodes escape sequences that are part of the translation itself', () => {
    const raw = freshI18n({ msg: 'snowman \\u2603 letter \\x41' });
    expect(raw._('msg')).toBe('snowman \u2603 letter A');

    const compiled = freshI18n({ msg: ['snowman \\u2603 ', ['path'], ' tail \\x41'] });
    expect(compiled._('msg', { path: 'D:\\x86-builds' })).toBe(
      'snowman \u2603 D:\\x86-builds tail A',
    );
  });
});
