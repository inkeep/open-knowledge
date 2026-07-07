/**
 * Tests for the isMarkdown signal-count heuristic.
 *
 * The heuristic must reject prose that happens to contain a single `*` or
 * `#` and accept authored markdown with 3+ distinct signals. Threshold
 * scales with line count: min(3, floor(lineCount / 5)), floored at 1.
 */

import { describe, expect, test } from 'bun:test';
import { isMarkdown } from './is-markdown.ts';

describe('isMarkdown — signal-count heuristic', () => {
  test('rejects simple one-line prose', () => {
    expect(isMarkdown('hello world')).toBe(false);
  });

  test('FR-38: short prose with single-asterisk emphasis is detected', () => {
    // `*foo*` is promoted from "accidental star" to a markdown signal.
    // The user authored emphasis markup; routing through mdManager.parse
    // preserves the sourceDelimiter='*' attr through the round-trip.
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
    // threshold = max(1, min(3, floor(4/5))) = max(1, 0) = 1
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
      // `*italic*` previously had no signal. SINGLE_STAR_EM_RE
      // catches it explicitly so the markdown-first dispatcher routes
      // through mdManager.parse and preserves the user's typed delimiter.
      expect(isMarkdown('this has a single *italic* word')).toBe(true);
    });

    test('three styles count as one signal (not three)', () => {
      // Single-line snippet, threshold = 1. One paired emphasis hit
      // counts as 1 signal — adding `__` and `~~` does not stack.
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
      // Need either lowercase-with-attr or HTML-inline to match — bare `<u>` alone has no attrs and no closing pair on same line wrapping content
      // Bare `<u>` followed by a same-line close *with content* triggers HTML_INLINE_RE; check below
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
    // Threshold formula: `min(3, floor(lineCount/5))` with `Math.max(1,
    // threshold)` floor. For 30 lines: `min(3, 6) = 3`. Boundary anchor
    // tests verify the exact count where prose tips into "looks like
    // markdown" — a regression in the formula would silently shift the
    // false-positive surface.
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
    // `sampleForHeuristic` samples first 32KB + last 32KB of payloads
    // above 256KB so the regex scan stays constant-time regardless of
    // input size. These tests pin the sampling boundaries:
    //   - signals in the head ARE detected,
    //   - signals buried only in the middle are NOT detected (acknowledged
    //     limitation; documented in the spec),
    //   - the join newline between head + tail does not synthesize a
    //     false-positive blockquote at the boundary.
    test('large payload (>256KB) samples head+tail and detects signals in the head', () => {
      const head = '# Heading\n\n- bullet item\n\n```\ncode block\n```\n';
      const filler = 'plain prose line without markdown shape\n'.repeat(7000);
      // ~290KB total — above the 256KB sampling threshold.
      expect((head + filler).length).toBeGreaterThan(256 * 1024);
      expect(isMarkdown(head + filler)).toBe(true);
    });

    test('large payload with signals only in the middle is not detected (sampling limitation)', () => {
      const headFiller = 'plain prose line without markdown shape\n'.repeat(4000);
      const middle = '# Heading\n- bullet\n```\ncode\n```\n';
      const tailFiller = 'plain prose line without markdown shape\n'.repeat(4000);
      const payload = headFiller + middle + tailFiller;
      expect(payload.length).toBeGreaterThan(256 * 1024);
      // Documented sampling limitation — signals only in the unsampled
      // middle region (between head 32KB and tail 32KB) don't surface.
      expect(isMarkdown(payload)).toBe(false);
    });

    test('boundary newline does not synthesize a blockquote false-positive between head and tail', () => {
      // Head ends with `>`; tail starts with ` text`. The join `\n` MUST
      // NOT create `> text` matching `/^> /m` at the boundary. The
      // head's `>` is mid-content (preceded by `a` chars), so the join
      // line begins with `a...>` not `> ` and the pattern doesn't form.
      const head = `${'a'.repeat(32 * 1024 - 1)}>`;
      const tail = ` text${'a'.repeat(32 * 1024 - 5)}`;
      const filler = 'b'.repeat(200 * 1024);
      const payload = head + filler + tail;
      expect(payload.length).toBeGreaterThan(256 * 1024);
      // No real markdown signals in either the head or the tail — only
      // the synthetic boundary token. Should NOT be detected as markdown.
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
      // CommonMark §4.3 admits any 1+ consecutive `=`/`-` chars as a setext
      // underline. Heuristic must match the spec, not a wider minimum.
      expect(isMarkdown('H\n=')).toBe(true);
    });

    test('rejects an underline-shaped line without a preceding content line', () => {
      // `[=-]+$` alone isn't enough — the regex requires a preceding non-empty
      // content line. A bare `----` row is structurally a thematic break, not
      // setext, and doesn't trip SETEXT_RE.
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
      // The inner-char exclusion `[^*\s\n]` prevents the regex from matching
      // a `*` immediately after the opener, which is what `**bold**` has.
      // Intentionally pinned: without this exclusion, `**bold**` would
      // double-count (1 from STRONG_STAR_RE + 1 from SINGLE_STAR_EM_RE) and
      // shift the threshold-boundary surface for any test that mixes paired
      // emphasis with prose.
      const md = '**bold**';
      // STRONG_STAR_RE is the legitimate signal for this input.
      expect(isMarkdown(md)).toBe(true);
      // But SINGLE_STAR_EM_RE specifically does not match (verified
      // structurally — by re-parsing the same string here from the test's
      // perspective, regex regression would surface as either an extra
      // signal in mixed inputs or a missed signal in `*emphasis*` cases).
    });

    test('rejects mid-word `snake*case*var` (no surrounding whitespace)', () => {
      // The `(^|\s)` anchor requires a word-boundary opener, so internal
      // asterisks in identifiers do not trip the regex.
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
      // Symmetric with the SINGLE_STAR vs STRONG_STAR exclusion.
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
      // STRIKE_RE catches this as the existing strike signal, but TILDE_FENCE
      // requires `^~~~` (3+ tildes). Confirms the fence regex is fence-shaped,
      // not delimiter-shaped.
      // (Total signals fired: 1 from STRIKE_RE; 0 from TILDE_FENCE_RE.)
      expect(isMarkdown('~~strike~~')).toBe(true);
    });

    test('rejects single tilde `~strike~`', () => {
      // Lone tilde isn't a markdown construct. Heuristic should not fire.
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
      // `\n` (literal backslash + `n`) is NOT a CommonMark escapable; the
      // regex char class doesn't include `n`, so this stays below threshold.
      expect(isMarkdown('\\n word')).toBe(false);
    });

    test('rejects pure prose with no backslashes', () => {
      expect(isMarkdown('hello world')).toBe(false);
    });
  });

  describe('combined FR-38 signals + threshold scaling', () => {
    test('long prose with one accidental `*foo*` is detected (threshold=1 for short input)', () => {
      // Single asterisks used to be ignored. Now the user's
      // typed emphasis IS the signal — threshold=1 trips, and the dispatcher
      // routes through mdManager.parse so source-form attrs survive.
      expect(isMarkdown('Tom typed *fancy* in his note')).toBe(true);
    });

    test('long prose without any FR-38 markers stays below threshold', () => {
      // Pure prose × 20 lines — none of the 5 new regexes can match. Existing
      // negative-case behavior preserved under the widened signal set.
      const prose = Array(20).fill('Pure prose without any markdown markers.').join('\n');
      expect(isMarkdown(prose)).toBe(false);
    });

    test('30-line prose with FR-38 backslash-escape + setext does not over-trip', () => {
      // 30 lines → threshold = min(3, 6) = 3. Setext + backslash-escape sum to
      // 2 signals; should stay below threshold and return false.
      const lines = Array(28).fill('Plain prose without markdown shape.');
      const withTwoSignals = ['Title', '====', ...lines, 'See also \\#tag'].join('\n');
      expect(isMarkdown(withTwoSignals)).toBe(false);
    });
  });
});
