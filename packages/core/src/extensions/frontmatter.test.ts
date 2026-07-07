import { describe, expect, test } from 'bun:test';
import { prependFrontmatter, stripFrontmatter, unwrapFrontmatterFences } from './frontmatter';

describe('stripFrontmatter', () => {
  test('extracts frontmatter from standard YAML block', () => {
    const input = '---\ntitle: Hello\ntags: [a, b]\n---\n# Body';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\ntitle: Hello\ntags: [a, b]\n---\n');
    expect(body).toBe('# Body');
  });

  test('returns empty frontmatter when none present', () => {
    const input = '# Just a heading\nSome content';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('');
    expect(body).toBe(input);
  });

  test('does not match --- in the middle of content', () => {
    const input = '# Heading\n---\nstuff\n---\n';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('');
    expect(body).toBe(input);
  });

  test('handles empty body after frontmatter', () => {
    const input = '---\ntitle: Empty\n---\n';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\ntitle: Empty\n---\n');
    expect(body).toBe('');
  });

  test('handles empty string', () => {
    const { frontmatter, body } = stripFrontmatter('');
    expect(frontmatter).toBe('');
    expect(body).toBe('');
  });

  test('handles frontmatter without trailing newline', () => {
    const input = '---\ntitle: No Trailing\n---';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\ntitle: No Trailing\n---');
    expect(body).toBe('');
  });

  test('handles CRLF line endings', () => {
    const input = '---\r\ntitle: CRLF\r\n---\r\n# Body';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\r\ntitle: CRLF\r\n---\r\n');
    expect(body).toBe('# Body');
  });

  test('handles mixed CRLF/LF line endings', () => {
    const input = '---\r\ntitle: Mixed\n---\r\n# Body';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\r\ntitle: Mixed\n---\r\n');
    expect(body).toBe('# Body');
  });

  test('handles empty frontmatter block ---\\n---\\n', () => {
    const input = '---\n---\n# Body';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\n---\n');
    expect(body).toBe('# Body');
  });

  test('handles empty frontmatter block without trailing newline', () => {
    const input = '---\n---';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\n---');
    expect(body).toBe('');
  });

  test('handles empty CRLF frontmatter block', () => {
    const input = '---\r\n---\r\n# Body';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\r\n---\r\n');
    expect(body).toBe('# Body');
  });
});

describe('prependFrontmatter', () => {
  test('prepends frontmatter to body', () => {
    const result = prependFrontmatter('---\ntitle: X\n---\n', '# Body');
    expect(result).toBe('---\ntitle: X\n---\n# Body');
  });

  test('returns body unchanged when frontmatter is empty', () => {
    expect(prependFrontmatter('', '# Body')).toBe('# Body');
  });
});

describe('unwrapFrontmatterFences', () => {
  test('strips leading and trailing --- fences with trailing newline', () => {
    expect(unwrapFrontmatterFences('---\ntitle: Hello\n---\n')).toBe('title: Hello');
  });

  test('strips fences without trailing newline', () => {
    expect(unwrapFrontmatterFences('---\ntitle: Hello\n---')).toBe('title: Hello');
  });

  test('handles CRLF line endings', () => {
    expect(unwrapFrontmatterFences('---\r\ntitle: CRLF\r\n---\r\n')).toBe('title: CRLF');
  });

  test('returns empty string on empty input', () => {
    expect(unwrapFrontmatterFences('')).toBe('');
  });

  test('handles empty FM block ---\\n---\\n', () => {
    expect(unwrapFrontmatterFences('---\n---\n')).toBe('');
  });

  test('round-trip with stripFrontmatter — fenced FM produces parseable YAML body', () => {
    const original = '---\ntitle: X\ntags: [a, b]\n---\n# Body';
    const { frontmatter } = stripFrontmatter(original);
    const body = unwrapFrontmatterFences(frontmatter);
    expect(body).toBe('title: X\ntags: [a, b]');
  });
});

describe('fence trailing whitespace — recognition contract', () => {
  // micromark-extension-frontmatter (the engine behind the repo's own
  // markdownToHtml path) consumes optional spaces/tabs AFTER both fence
  // sequences. Recognition must agree, or an in-tolerance source edit
  // (`---` → `--- `) changes FM partitioning mid-session and the bridge
  // compose fabricates an FM deletion.
  const recognized: Array<{ label: string; input: string; fm: string }> = [
    {
      label: 'space after the opening fence',
      input: '--- \ntitle: X\n---\n# Body',
      fm: '--- \ntitle: X\n---\n',
    },
    {
      label: 'tab after the opening fence',
      input: '---\t\ntitle: X\n---\n# Body',
      fm: '---\t\ntitle: X\n---\n',
    },
    {
      label: 'space after the closing fence',
      input: '---\ntitle: X\n--- \n# Body',
      fm: '---\ntitle: X\n--- \n',
    },
    {
      label: 'tab after the closing fence',
      input: '---\ntitle: X\n---\t\n# Body',
      fm: '---\ntitle: X\n---\t\n',
    },
  ];

  for (const { label, input, fm } of recognized) {
    test(`stripFrontmatter recognizes ${label} and preserves the raw bytes`, () => {
      const { frontmatter, body } = stripFrontmatter(input);
      // Raw bytes verbatim (Y.Text-is-truth): the trailing whitespace the
      // user typed stays inside `.frontmatter`, never normalized away here.
      expect(frontmatter).toBe(fm);
      expect(body).toBe('# Body');
    });
  }

  test('leading whitespace before the opening fence stays unrecognized', () => {
    const input = ' ---\ntitle: X\n---\n# Body';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('');
    expect(body).toBe(input);
  });

  test('unwrapFrontmatterFences unwraps fences carrying trailing whitespace', () => {
    expect(unwrapFrontmatterFences('--- \ntitle: X\n---\n')).toBe('title: X');
    expect(unwrapFrontmatterFences('---\ntitle: X\n--- \n')).toBe('title: X');
    expect(unwrapFrontmatterFences('---\t\ntitle: X\n---\t')).toBe('title: X');
  });

  test('strip then prepend stays identity with trailing-whitespace fences', () => {
    const original = '--- \ntitle: Keep\n--- \n# Content\n';
    const { frontmatter, body } = stripFrontmatter(original);
    expect(prependFrontmatter(frontmatter, body)).toBe(original);
    expect(frontmatter).not.toBe('');
  });

  test('closing-fence detection stops at the first ---[ \\t]* line inside the region', () => {
    // A `--- ` line inside the YAML region is a YAML document separator, never
    // legitimate FM content — micromark closes the frontmatter block there too,
    // so recognition stops at the FIRST fence-shaped line, trailing whitespace
    // included. Pins the boundary choice of the widened close-fence matcher.
    const input = '---\ntitle: X\n--- \nrest: y\n---\n# Body';
    const { frontmatter, body } = stripFrontmatter(input);
    expect(frontmatter).toBe('---\ntitle: X\n--- \n');
    expect(body).toBe('rest: y\n---\n# Body');
  });
});

describe('round-trip', () => {
  test('strip then prepend is identity', () => {
    const original = '---\ntitle: Test\ndate: 2026-01-01\n---\n# Content\n\nParagraph here.\n';
    const { frontmatter, body } = stripFrontmatter(original);
    const reassembled = prependFrontmatter(frontmatter, body);
    expect(reassembled).toBe(original);
  });

  test('CRLF round-trip is identity', () => {
    const original = '---\r\ntitle: CRLF Test\r\n---\r\n# Content\r\n';
    const { frontmatter, body } = stripFrontmatter(original);
    const reassembled = prependFrontmatter(frontmatter, body);
    expect(reassembled).toBe(original);
  });

  test('empty block round-trip is identity', () => {
    const original = '---\n---\n# Content\n';
    const { frontmatter, body } = stripFrontmatter(original);
    const reassembled = prependFrontmatter(frontmatter, body);
    expect(reassembled).toBe(original);
  });
});
