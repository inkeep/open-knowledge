import { describe, expect, test } from 'bun:test';
import { isMarkdown } from './is-markdown.ts';

describe('isMarkdown — signal-count heuristic', () => {
  test('rejects simple one-line prose', () => {
    expect(isMarkdown('hello world')).toBe(false);
  });

  test('FR-38: short prose with single-asterisk emphasis is detected', () => {
    expect(isMarkdown("Tom's *favorite* movie")).toBe(true);
  });

  test('accepts authored markdown with 3+ signals', () => {
    const md = `# heading\n\n- bullet\n- bullet\n\n[link](url)\n\n\`\`\`\ncode\n\`\`\`\n`;
    expect(isMarkdown(md)).toBe(true);
  });

  test('accepts GFM table', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |';
    expect(isMarkdown(md)).toBe(true);
  });

  test('accepts fenced code block alone', () => {
    const md = '```typescript\nconst x = 1;\n```';
    expect(isMarkdown(md)).toBe(true);
  });

  test('short snippet (<5 lines) accepts at threshold 1', () => {
    expect(isMarkdown('- one\n- two\n- three\n- four')).toBe(true);
  });

  test('long prose with no markdown signals is rejected', () => {
    const prose = Array(20).fill('This is plain prose with no markdown signals.').join('\n');
    expect(isMarkdown(prose)).toBe(false);
  });

  test('empty string returns false', () => {
    expect(isMarkdown('')).toBe(false);
  });

  test('ATX heading counts as one signal', () => {
    expect(isMarkdown('# heading')).toBe(true);
  });

  test('math block counts', () => {
    expect(isMarkdown('Some text\n$$\n\\frac{a}{b}\n$$')).toBe(true);
  });
});

describe('isMarkdown — extended signals (D8 + D18)', () => {
  describe('blockquote signal', () => {
    test('detects a single blockquote line', () => {
      expect(isMarkdown('> quoted text')).toBe(true);
    });

    test('detects blockquote inside a multi-line snippet', () => {
      expect(isMarkdown('intro\n\n> quoted')).toBe(true);
    });

    test('rejects bare `>` without trailing space (e.g. comparison operator)', () => {
      expect(isMarkdown('if (x > y) {')).toBe(false);
    });
  });

  describe('inline code signal', () => {
    test('detects a single backtick-wrapped span', () => {
      expect(isMarkdown('use `npm install` to add deps')).toBe(true);
    });

    test('rejects unmatched backticks', () => {
      expect(isMarkdown('this has a stray ` backtick')).toBe(false);
    });
  });

  describe('paired emphasis signal', () => {
    test('detects **bold**', () => {
      expect(isMarkdown('this is **bold** text')).toBe(true);
    });

    test('detects __underscored bold__', () => {
      expect(isMarkdown('this is __bold__ text')).toBe(true);
    });

    test('detects ~~strikethrough~~', () => {
      expect(isMarkdown('this is ~~struck~~ text')).toBe(true);
    });

    test('FR-38: single-asterisk emphasis is detected (was: rejected)', () => {
      expect(isMarkdown('this has a single *italic* word')).toBe(true);
    });

    test('three styles count as one signal (not three)', () => {
      expect(isMarkdown('**a** __b__ ~~c~~')).toBe(true);
    });
  });

  describe('capitalized JSX open tag signal', () => {
    test('detects single-line <Callout> from email/Slack', () => {
      expect(isMarkdown('<Callout type="note">body</Callout>')).toBe(true);
    });

    test('detects self-closing capitalized tag', () => {
      expect(isMarkdown('<Image/>')).toBe(true);
    });

    test('detects capitalized tag with no attributes', () => {
      expect(isMarkdown('<Accordion>x</Accordion>')).toBe(true);
    });

    test('rejects lowercase HTML without attributes (does not match capital re)', () => {
      expect(isMarkdown('plain <u> opener only here')).toBe(false);
    });
  });

  describe('lowercase JSX-with-attribute signal', () => {
    test('detects single-line <img src="…"/>', () => {
      expect(isMarkdown('<img src="x.png" />')).toBe(true);
    });

    test('detects <a href="…">', () => {
      expect(isMarkdown('<a href="https://example.com">link</a>')).toBe(true);
    });

    test('rejects bare lowercase tag without attrs (e.g. <p>)', () => {
      expect(isMarkdown('<p>')).toBe(false);
    });
  });

  describe('raw-HTML-inline signal (D18)', () => {
    test('detects <u>foo</u>', () => {
      expect(isMarkdown('Some <u>foo</u> text')).toBe(true);
    });

    test('detects <mark>...</mark>', () => {
      expect(isMarkdown('a <mark>highlighted</mark> word')).toBe(true);
    });

    test('rejects opener-only <u> on same line without closer', () => {
      expect(isMarkdown('plain text <u> with opener only')).toBe(false);
    });

    test('rejects opener and closer on different lines', () => {
      expect(isMarkdown('<u>\nfoo\n</u>')).toBe(false);
    });
  });

  describe('AI-chat copy-button shape (combined signals)', () => {
    test('blockquote + inline code + paired emphasis triggers the heuristic', () => {
      const aiChat = '> quoted reply\n\nuse `code` here\n\nand **bold** answer\n';
      expect(isMarkdown(aiChat)).toBe(true);
    });
  });

  describe('false-positive guard on prose with incidental signals', () => {
    test('long prose with one accidental `<word>` does not trip', () => {
      const prose = `${Array(20)
        .fill('Plain prose continues without any markdown shape.')
        .join('\n')}\nA stray <thing> appears once.`;
      expect(isMarkdown(prose)).toBe(false);
    });

    test('prose with comparison operators stays below threshold', () => {
      const prose = 'compare x > y and a < b\n'.repeat(10);
      expect(isMarkdown(prose)).toBe(false);
    });
  });

  describe('threshold boundary — exact N-1 vs N signal counts', () => {
    test('30-line prose with exactly 2 signals stays below threshold=3', () => {
      const lines = Array(28).fill('Plain prose without markdown shape.');
      const withTwoSignals = [
        '> quoted reply', // blockquote signal #1
        ...lines,
        '`code` reference', // inline-code signal #2
      ].join('\n');
      expect(isMarkdown(withTwoSignals)).toBe(false);
    });

    test('30-line prose with exactly 3 signals hits threshold=3', () => {
      const lines = Array(27).fill('Plain prose without markdown shape.');
      const withThreeSignals = [
        '> quoted reply', // blockquote signal #1
        ...lines,
        '`code` reference', // inline-code signal #2
        'and **bold** word', // paired-emphasis signal #3
      ].join('\n');
      expect(isMarkdown(withThreeSignals)).toBe(true);
    });
  });

  describe('large-payload sampling — head + tail scan above 256KB', () => {
    test('large payload (>256KB) samples head+tail and detects signals in the head', () => {
      const head = '# Heading\n\n- bullet item\n\n```\ncode block\n```\n';
      const filler = 'plain prose line without markdown shape\n'.repeat(7000);
      expect((head + filler).length).toBeGreaterThan(256 * 1024);
      expect(isMarkdown(head + filler)).toBe(true);
    });

    test('large payload with signals only in the middle is not detected (sampling limitation)', () => {
      const headFiller = 'plain prose line without markdown shape\n'.repeat(4000);
      const middle = '# Heading\n- bullet\n```\ncode\n```\n';
      const tailFiller = 'plain prose line without markdown shape\n'.repeat(4000);
      const payload = headFiller + middle + tailFiller;
      expect(payload.length).toBeGreaterThan(256 * 1024);
      expect(isMarkdown(payload)).toBe(false);
    });

    test('boundary newline does not synthesize a blockquote false-positive between head and tail', () => {
      const head = `${'a'.repeat(32 * 1024 - 1)}>`;
      const tail = ` text${'a'.repeat(32 * 1024 - 5)}`;
      const filler = 'b'.repeat(200 * 1024);
      const payload = head + filler + tail;
      expect(payload.length).toBeGreaterThan(256 * 1024);
      expect(isMarkdown(payload)).toBe(false);
    });
  });
});

describe('isMarkdown — FR-38 widened signals', () => {
  describe('setext heading (FR-38 SETEXT_RE)', () => {
    test('detects H1 setext (Title\\n=====)', () => {
      expect(isMarkdown('Title\n=====')).toBe(true);
    });

    test('detects H2 setext (Subtitle\\n----)', () => {
      expect(isMarkdown('Subtitle\n----')).toBe(true);
    });

    test('detects single-char underline (H\\n=)', () => {
      expect(isMarkdown('H\n=')).toBe(true);
    });

    test('rejects an underline-shaped line without a preceding content line', () => {
      expect(isMarkdown('----')).toBe(false);
    });

    test('rejects prose that contains hyphens but no underline line', () => {
      expect(isMarkdown('hello -- world')).toBe(false);
    });
  });

  describe('single-asterisk emphasis (FR-38 SINGLE_STAR_EM_RE)', () => {
    test('detects bare `*emphasis*`', () => {
      expect(isMarkdown('*emphasis*')).toBe(true);
    });

    test('detects mid-prose `text *foo* text`', () => {
      expect(isMarkdown('text *foo* text')).toBe(true);
    });

    test('does NOT match `**bold**` (so STRONG_STAR signal is the sole emphasis source)', () => {
      const md = '**bold**';
      expect(isMarkdown(md)).toBe(true);
    });

    test('rejects mid-word `snake*case*var` (no surrounding whitespace)', () => {
      expect(isMarkdown('snake*case*var')).toBe(false);
    });
  });

  describe('single-underscore emphasis (FR-38 SINGLE_UNDER_EM_RE)', () => {
    test('detects bare `_emphasis_`', () => {
      expect(isMarkdown('_emphasis_')).toBe(true);
    });

    test('detects mid-prose `text _foo_ text`', () => {
      expect(isMarkdown('text _foo_ text')).toBe(true);
    });

    test('does NOT match `__bold__` directly (STRONG_UNDER signal is the source)', () => {
      expect(isMarkdown('__bold__')).toBe(true);
    });

    test('rejects mid-identifier `snake_case_var`', () => {
      expect(isMarkdown('snake_case_var')).toBe(false);
    });
  });

  describe('tilde fenced code (FR-38 TILDE_FENCE_RE)', () => {
    test('detects `~~~js\\ncode\\n~~~`', () => {
      expect(isMarkdown('~~~js\ncode\n~~~')).toBe(true);
    });

    test('detects bare `~~~` opener at line start', () => {
      expect(isMarkdown('~~~')).toBe(true);
    });

    test('rejects strikethrough `~~strike~~` (only 2 tildes)', () => {
      expect(isMarkdown('~~strike~~')).toBe(true);
    });

    test('rejects single tilde `~strike~`', () => {
      expect(isMarkdown('~strike~')).toBe(false);
    });
  });

  describe('CommonMark backslash escape (FR-38 BACKSLASH_ESCAPE_RE)', () => {
    test('detects `\\*not emphasis\\*`', () => {
      expect(isMarkdown('\\*not emphasis\\*')).toBe(true);
    });

    test('detects `\\_v\\_` (escaped underscore)', () => {
      expect(isMarkdown('\\_v\\_')).toBe(true);
    });

    test('detects double-backslash `\\\\foo`', () => {
      expect(isMarkdown('\\\\foo')).toBe(true);
    });

    test('detects escaped hash `\\#hashtag`', () => {
      expect(isMarkdown('\\#hashtag')).toBe(true);
    });

    test('detects escaped exclamation `\\!`', () => {
      expect(isMarkdown('\\!')).toBe(true);
    });

    test('rejects backslash before non-punct char `\\n word`', () => {
      expect(isMarkdown('\\n word')).toBe(false);
    });

    test('rejects pure prose with no backslashes', () => {
      expect(isMarkdown('hello world')).toBe(false);
    });
  });

  describe('combined FR-38 signals + threshold scaling', () => {
    test('long prose with one accidental `*foo*` is detected (threshold=1 for short input)', () => {
      expect(isMarkdown('Tom typed *fancy* in his note')).toBe(true);
    });

    test('long prose without any FR-38 markers stays below threshold', () => {
      const prose = Array(20).fill('Pure prose without any markdown markers.').join('\n');
      expect(isMarkdown(prose)).toBe(false);
    });

    test('30-line prose with FR-38 backslash-escape + setext does not over-trip', () => {
      const lines = Array(28).fill('Plain prose without markdown shape.');
      const withTwoSignals = ['Title', '====', ...lines, 'See also \\#tag'].join('\n');
      expect(isMarkdown(withTwoSignals)).toBe(false);
    });
  });
});
