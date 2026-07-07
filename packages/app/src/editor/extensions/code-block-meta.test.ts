import { describe, expect, test } from 'bun:test';
import {
  addMetaToken,
  getMetaKeyValue,
  getMetaTitle,
  joinMetaTokens,
  metaHasToken,
  parsePreviewHeight,
  parsePreviewWidth,
  removeMetaToken,
  setMetaKeyValue,
  setMetaTitle,
  shouldShowPreview,
  splitMetaTokens,
} from './code-block-meta';

describe('splitMetaTokens', () => {
  test('null / undefined / empty → []', () => {
    expect(splitMetaTokens(null)).toEqual([]);
    expect(splitMetaTokens(undefined)).toEqual([]);
    expect(splitMetaTokens('')).toEqual([]);
  });
  test('single token', () => {
    expect(splitMetaTokens('preview')).toEqual(['preview']);
  });
  test('multiple whitespace-delimited tokens', () => {
    expect(splitMetaTokens('preview title="demo"')).toEqual(['preview', 'title="demo"']);
  });
  test('collapses extra whitespace', () => {
    expect(splitMetaTokens('  preview\t\ttitle ')).toEqual(['preview', 'title']);
  });
});

describe('joinMetaTokens', () => {
  test('empty → null', () => {
    expect(joinMetaTokens([])).toBeNull();
    expect(joinMetaTokens([''])).toBeNull();
  });
  test('single token', () => {
    expect(joinMetaTokens(['preview'])).toBe('preview');
  });
  test('multiple tokens — single-space delimited', () => {
    expect(joinMetaTokens(['preview', 'title="demo"'])).toBe('preview title="demo"');
  });
});

describe('metaHasToken', () => {
  test('present as standalone token', () => {
    expect(metaHasToken('preview', 'preview')).toBe(true);
    expect(metaHasToken('foo preview bar', 'preview')).toBe(true);
  });
  test('absent', () => {
    expect(metaHasToken(null, 'preview')).toBe(false);
    expect(metaHasToken('foo bar', 'preview')).toBe(false);
  });
  test('case-sensitive — substring match does NOT count', () => {
    expect(metaHasToken('previewer', 'preview')).toBe(false);
    expect(metaHasToken('Preview', 'preview')).toBe(false);
  });
});

describe('addMetaToken', () => {
  test('idempotent — already present', () => {
    expect(addMetaToken('preview', 'preview')).toBe('preview');
    expect(addMetaToken('foo preview', 'preview')).toBe('foo preview');
  });
  test('appends to empty', () => {
    expect(addMetaToken(null, 'preview')).toBe('preview');
    expect(addMetaToken('', 'preview')).toBe('preview');
  });
  test('appends preserving other tokens', () => {
    expect(addMetaToken('title="demo"', 'preview')).toBe('title="demo" preview');
  });
});

describe('removeMetaToken', () => {
  test('removes when present', () => {
    expect(removeMetaToken('preview', 'preview')).toBeNull();
    expect(removeMetaToken('foo preview bar', 'preview')).toBe('foo bar');
  });
  test('no-op when absent', () => {
    expect(removeMetaToken(null, 'preview')).toBeNull();
    expect(removeMetaToken('foo bar', 'preview')).toBe('foo bar');
  });
  test('case-sensitive — does NOT remove a different-case token', () => {
    expect(removeMetaToken('Preview', 'preview')).toBe('Preview');
  });
});

describe('shouldShowPreview', () => {
  test('html + preview meta → true', () => {
    expect(shouldShowPreview('html', 'preview')).toBe(true);
    expect(shouldShowPreview('HTML', 'preview')).toBe(true);
  });
  test('xml (normalized form of html) + preview meta → true', () => {
    // `normalizeCodeLanguage('html')` resolves to `xml` (highlight.js canonical),
    // and the NodeView passes the normalized form into shouldShowPreview.
    expect(shouldShowPreview('xml', 'preview')).toBe(true);
  });
  test('html without preview meta → false', () => {
    expect(shouldShowPreview('html', null)).toBe(false);
    expect(shouldShowPreview('html', 'title="demo"')).toBe(false);
  });
  test('non-previewable language → false even with preview meta', () => {
    expect(shouldShowPreview('javascript', 'preview')).toBe(false);
    expect(shouldShowPreview('css', 'preview')).toBe(false);
  });
  test('no language → false', () => {
    expect(shouldShowPreview(null, 'preview')).toBe(false);
  });
});

describe('getMetaKeyValue', () => {
  test('present', () => {
    expect(getMetaKeyValue('h=40', 'h')).toBe('40');
    expect(getMetaKeyValue('preview h=40', 'h')).toBe('40');
    expect(getMetaKeyValue('preview h=40 title="demo"', 'h')).toBe('40');
  });
  test('absent', () => {
    expect(getMetaKeyValue(null, 'h')).toBeNull();
    expect(getMetaKeyValue('preview', 'h')).toBeNull();
  });
  test('case-sensitive key match', () => {
    expect(getMetaKeyValue('H=40', 'h')).toBeNull();
  });
  test('first occurrence wins', () => {
    expect(getMetaKeyValue('h=20 h=40', 'h')).toBe('20');
  });
});

describe('setMetaKeyValue', () => {
  test('adds when absent', () => {
    expect(setMetaKeyValue(null, 'h', '500px')).toBe('h=500px');
    expect(setMetaKeyValue('preview', 'h', '500px')).toBe('preview h=500px');
  });
  test('replaces when present, preserving position + other tokens', () => {
    expect(setMetaKeyValue('preview h=40', 'h', '500px')).toBe('preview h=500px');
    expect(setMetaKeyValue('h=40 preview', 'h', '500px')).toBe('h=500px preview');
    expect(setMetaKeyValue('preview h=40 title="demo"', 'h', '500px')).toBe(
      'preview h=500px title="demo"',
    );
  });
  test('value=null removes the token', () => {
    expect(setMetaKeyValue('preview h=40', 'h', null)).toBe('preview');
    expect(setMetaKeyValue('h=40', 'h', null)).toBeNull();
  });
  test('dedupes duplicate keys to the first-wins value', () => {
    expect(setMetaKeyValue('h=20 h=40', 'h', '500px')).toBe('h=500px');
  });
});

describe('parsePreviewHeight', () => {
  test('unitless number → px', () => {
    expect(parsePreviewHeight('preview h=40')).toBe('40px');
    expect(parsePreviewHeight('h=12')).toBe('12px');
  });
  test('explicit unit preserved', () => {
    expect(parsePreviewHeight('preview h=400px')).toBe('400px');
    expect(parsePreviewHeight('h=80vh')).toBe('80vh');
    expect(parsePreviewHeight('h=50%')).toBe('50%');
    expect(parsePreviewHeight('h=24em')).toBe('24em');
  });
  test('decimal numbers', () => {
    expect(parsePreviewHeight('h=12.5')).toBe('12.5px');
    expect(parsePreviewHeight('h=0.5vh')).toBe('0.5vh');
  });
  test('missing or malformed → null', () => {
    expect(parsePreviewHeight(null)).toBeNull();
    expect(parsePreviewHeight('preview')).toBeNull();
    expect(parsePreviewHeight('h=tall')).toBeNull();
    expect(parsePreviewHeight('h=40foo')).toBeNull();
    expect(parsePreviewHeight('h=')).toBeNull();
  });
  test('zero and zero-shaped values → null', () => {
    // `h=0` parses cleanly but the CSS min-height floor (8rem) would clamp
    // the rendered height anyway, leaving the meta lying. Drop to null and
    // let the CSS default win.
    expect(parsePreviewHeight('h=0')).toBeNull();
    expect(parsePreviewHeight('h=0px')).toBeNull();
    expect(parsePreviewHeight('h=0.0')).toBeNull();
    expect(parsePreviewHeight('h=0.0vh')).toBeNull();
  });
});

describe('parsePreviewWidth', () => {
  test('unitless number → px', () => {
    expect(parsePreviewWidth('preview w=24')).toBe('24px');
    expect(parsePreviewWidth('w=12')).toBe('12px');
  });
  test('explicit unit preserved', () => {
    expect(parsePreviewWidth('preview w=400px')).toBe('400px');
    expect(parsePreviewWidth('w=80vw')).toBe('80vw');
    expect(parsePreviewWidth('w=100%')).toBe('100%');
  });
  test('decimal numbers', () => {
    expect(parsePreviewWidth('w=12.5')).toBe('12.5px');
  });
  test('coexists with h= — same meta', () => {
    expect(parsePreviewWidth('preview h=20 w=40')).toBe('40px');
    expect(parsePreviewHeight('preview h=20 w=40')).toBe('20px');
  });
  test('missing or malformed → null', () => {
    expect(parsePreviewWidth(null)).toBeNull();
    expect(parsePreviewWidth('preview')).toBeNull();
    expect(parsePreviewWidth('w=tall')).toBeNull();
    expect(parsePreviewWidth('w=')).toBeNull();
  });
  test('zero / negative → null', () => {
    expect(parsePreviewWidth('w=0')).toBeNull();
    expect(parsePreviewWidth('w=0px')).toBeNull();
  });
});

describe('getMetaTitle', () => {
  test('null / undefined / empty → null', () => {
    expect(getMetaTitle(null)).toBeNull();
    expect(getMetaTitle(undefined)).toBeNull();
    expect(getMetaTitle('')).toBeNull();
  });
  test('absent → null', () => {
    expect(getMetaTitle('preview')).toBeNull();
    expect(getMetaTitle('h=300px w=400px')).toBeNull();
  });
  test('double-quoted with spaces (PRD-6819 reproducer)', () => {
    expect(getMetaTitle('title="my Title"')).toBe('my Title');
    expect(getMetaTitle('title="hello world"')).toBe('hello world');
  });
  test('single-quoted with spaces', () => {
    expect(getMetaTitle("title='my Title'")).toBe('my Title');
  });
  test('unquoted single word', () => {
    expect(getMetaTitle('title=foo')).toBe('foo');
    expect(getMetaTitle('title=foo.json')).toBe('foo.json');
  });
  test('empty quoted string', () => {
    expect(getMetaTitle('title=""')).toBe('');
  });
  test('mixed with other tokens at any position', () => {
    expect(getMetaTitle('preview title="my Title"')).toBe('my Title');
    expect(getMetaTitle('title="my Title" preview')).toBe('my Title');
    expect(getMetaTitle('preview h=300px title="my Title" w=400px')).toBe('my Title');
  });
  test('first occurrence wins', () => {
    expect(getMetaTitle('title="first" title="second"')).toBe('first');
  });
  test('substring of other tokens does NOT match (word-boundary)', () => {
    expect(getMetaTitle('subtitle="not this"')).toBeNull();
    expect(getMetaTitle('xtitle="not this"')).toBeNull();
  });
});

describe('setMetaTitle', () => {
  test('adds when absent — always emits double-quoted form', () => {
    expect(setMetaTitle(null, 'my Title')).toBe('title="my Title"');
    expect(setMetaTitle('preview', 'my Title')).toBe('title="my Title" preview');
  });
  test('replaces existing title, preserving other tokens', () => {
    expect(setMetaTitle('title="old"', 'new')).toBe('title="new"');
    expect(setMetaTitle('preview title="old" h=300px', 'new')).toBe('title="new" preview h=300px');
  });
  test('replaces single-quoted + unquoted forms with double-quoted', () => {
    expect(setMetaTitle("title='old'", 'new')).toBe('title="new"');
    expect(setMetaTitle('title=old', 'new')).toBe('title="new"');
  });
  test('value === null removes the title token', () => {
    expect(setMetaTitle('title="my Title"', null)).toBeNull();
    expect(setMetaTitle('preview title="my Title" h=300px', null)).toBe('preview h=300px');
  });
  test('value === "" writes title="" (distinct from removal)', () => {
    expect(setMetaTitle('preview', '')).toBe('title="" preview');
    expect(setMetaTitle('title="old"', '')).toBe('title=""');
  });
  test('strips embedded double quotes from the value (no escape syntax)', () => {
    expect(setMetaTitle(null, 'a "b" c')).toBe('title="a b c"');
  });
  test('strips newlines from the value (info-strings are single-line)', () => {
    expect(setMetaTitle(null, 'line one\nline two')).toBe('title="line oneline two"');
  });
  test('dedupes duplicate title tokens to a single first-wins replacement', () => {
    expect(setMetaTitle('title="a" title="b"', 'new')).toBe('title="new"');
  });
  test('round-trips through getMetaTitle', () => {
    const after = setMetaTitle('preview h=300px', 'my Title');
    expect(getMetaTitle(after)).toBe('my Title');
  });

  // The bare-`title=` gap: the
  // strip regex's old `\S+` alternative didn't match a value-less `title=`,
  // so the stray token survived the dedup pass and accumulated alongside
  // the new `title="…"` on every edit.
  test('strips a bare `title=` (no value) so successive edits do not accumulate stray tokens', () => {
    expect(setMetaTitle('title= preview', 'new')).toBe('title="new" preview');
    // Pure bare-title removal should also leave no stray.
    expect(setMetaTitle('title=', null)).toBeNull();
    // Mixed bare + valued — both go, replaced by one canonical front-emit.
    expect(setMetaTitle('title= title="old" preview', 'new')).toBe('title="new" preview');
  });
});

// The bystander-op class:
// before `splitMetaTokens` was quote-aware, any sibling meta op (add /
// remove / setKeyValue) on a fence carrying `title="hello  world"` would
// whitespace-split the interior of the quoted value, then re-join with
// collapsed single spaces. These tests pin the invariant: interior
// whitespace inside `title="…"` survives every sibling op end-to-end.
describe('title-preserving round-trips through bystander meta ops', () => {
  test('add → remove preview token preserves multi-space title (pullfrog reproducer)', () => {
    const meta = 'title="hello  world"';
    const after = removeMetaToken(addMetaToken(meta, 'preview'), 'preview');
    expect(after).toBe('title="hello  world"');
  });

  test('preview toggle on a fence with title containing leading/trailing space', () => {
    expect(removeMetaToken(addMetaToken('title=" foo "', 'preview'), 'preview')).toBe(
      'title=" foo "',
    );
  });

  test('setMetaKeyValue (h= / w=) preserves multi-space title alongside', () => {
    const meta = 'title="hello  world" h=300px';
    expect(setMetaKeyValue(meta, 'h', '500px')).toBe('title="hello  world" h=500px');
    expect(setMetaKeyValue(meta, 'w', '400px')).toBe('title="hello  world" h=300px w=400px');
  });

  test('addMetaToken on title-only meta does not damage the title', () => {
    expect(addMetaToken('title="a  b"', 'preview')).toBe('title="a  b" preview');
  });

  test('single-quoted title with interior whitespace also survives', () => {
    expect(removeMetaToken(addMetaToken("title='a  b'", 'preview'), 'preview')).toBe(
      "title='a  b'",
    );
  });
});
