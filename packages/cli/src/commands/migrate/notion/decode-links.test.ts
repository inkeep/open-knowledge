import { describe, expect, test } from 'bun:test';
import { decodeLinks } from './decode-links.ts';

const ID = '30545f35b5ad80a38049d283dae66763';

describe('decodeLinks', () => {
  test('decodes an encoded internal .md link and angle-wraps the spaced target', () => {
    const input = `See [Create a Role](Zendesk%20Integration%20${ID}.md) now.`;
    expect(decodeLinks(input)).toBe(`See [Create a Role](<Zendesk Integration ${ID}.md>) now.`);
  });

  test('decodes a link target that contains literal parentheses (paren-depth aware)', () => {
    const input = `[Voice](Teamspace Home/Voice of Customer Analysis EDB (EnterpriseDB)%202f04.md)`;
    expect(decodeLinks(input)).toBe(
      `[Voice](<Teamspace Home/Voice of Customer Analysis EDB (EnterpriseDB) 2f04.md>)`,
    );
  });

  test('decodes a target that both starts with and contains parentheses', () => {
    const input = `[GtM]((Primer x Inkeep)%20GtM/GtM%20Newsletter%202e34.md)`;
    expect(decodeLinks(input)).toBe(`[GtM](<(Primer x Inkeep) GtM/GtM Newsletter 2e34.md>)`);
  });

  test('angle-wraps an already-decoded target that has literal spaces (so it renders)', () => {
    const input = '[Customer Snapshot](Netcraft x Inkeep/Customer Snapshot 29945_all.csv)';
    expect(decodeLinks(input)).toBe(
      '[Customer Snapshot](<Netcraft x Inkeep/Customer Snapshot 29945_all.csv>)',
    );
  });

  test('leaves a space-free target unwrapped', () => {
    expect(decodeLinks('[x](simple.md)')).toBe('[x](simple.md)');
  });

  test('decodes and wraps image targets too', () => {
    expect(decodeLinks('![shot](Some%20Page/Screenshot%202026.png)')).toBe(
      '![shot](<Some Page/Screenshot 2026.png>)',
    );
  });

  test('leaves external URLs untouched', () => {
    const input = '[api](https://api.example.com/run%20now)';
    expect(decodeLinks(input)).toBe(input);
  });

  test('leaves bare anchors untouched', () => {
    expect(decodeLinks('[top](#some%20heading)')).toBe('[top](#some%20heading)');
  });

  test('does not touch links inside inline code', () => {
    const input = 'Use `[x](Foo%20Bar.md)` literally.';
    expect(decodeLinks(input)).toBe(input);
  });

  test('does not touch links inside fenced code blocks', () => {
    const input = ['```md', '[x](Foo%20Bar.md)', '```', '[y](Baz%20Qux.md)'].join('\n');
    const expected = ['```md', '[x](Foo%20Bar.md)', '```', '[y](<Baz Qux.md>)'].join('\n');
    expect(decodeLinks(input)).toBe(expected);
  });

  test('is idempotent — a second pass produces identical bytes', () => {
    const input = `[a](Foo%20Bar%20${ID}.md) and [b](With (Parens)%20x.md)`;
    const once = decodeLinks(input);
    expect(decodeLinks(once)).toBe(once);
  });

  test('does not mis-toggle fence state on a mismatched fence character', () => {
    // A backtick block containing a `~~~` line must stay a code block; the link
    // after the real closing ``` must still be rewritten.
    const input = [
      '```',
      '[x](Foo%20Bar.md)',
      '~~~',
      '[y](Baz%20Qux.md)',
      '```',
      '[z](Q%20R.md)',
    ].join('\n');
    const out = decodeLinks(input);
    expect(out).toContain('[x](Foo%20Bar.md)'); // inside the block, untouched
    expect(out).toContain('[y](Baz%20Qux.md)'); // still inside the block, untouched
    expect(out).toContain('[z](<Q R.md>)'); // after the block, rewritten
  });

  test('redirects internal _all.csv link targets to the .md table page when enabled', () => {
    const input = '[Customers](<DB/Customers 29945_all.csv>)';
    expect(decodeLinks(input, { redirectCsv: true })).toBe('[Customers](<DB/Customers 29945.md>)');
  });

  test('leaves _all.csv targets alone when redirect is disabled', () => {
    const input = '[Customers](<DB/Customers 29945_all.csv>)';
    expect(decodeLinks(input, { redirectCsv: false })).toBe(input);
  });
});
