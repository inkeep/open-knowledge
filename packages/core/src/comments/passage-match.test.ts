/**
 * Markdown/rendered passage matching.
 *
 * The cases below are the ones that reached users as a bare 400 "the quoted
 * passage is not in the document": a comment on a bullet whose text starts
 * after a bold run, and a selection spanning a heading and the list under it.
 */

import { describe, expect, test } from 'vitest';
import { isInlineWhitespaceNumericCharRef } from '../markdown/whitespace-char-ref.ts';
import {
  contextEvidenceFloor,
  contextMatchScore,
  findAllPassages,
  findPassage,
  rewriteCeiling,
} from './passage-match.ts';

const BODY = `## Ingredients

- 1½ cups shelled edamame (frozen, thawed)
- **Peanut sauce:** 3 tbsp peanut butter, 2 tbsp soy sauce, water to loosen
- Scallions, chopped peanuts, to serve

## Steps

1. Toss the tofu with the cornstarch and a pinch of salt.
2. Stir-fry the bell pepper 2–3 min, then add the edamame.
`;

/** The body slice a caller would store as the anchor's exact quote. */
function slice(needle: string, syntaxIn: 'haystack' | 'needle' = 'haystack'): string | null {
  const hit = findPassage(BODY, needle, { syntaxIn });
  return hit ? BODY.slice(hit.start, hit.end) : null;
}

describe('rendered text against a markdown body', () => {
  test('finds a passage that starts after a bold run inside a bullet', () => {
    // The reported failure: the source line is
    // `- **Peanut sauce:** 3 tbsp ...`, so neither the rendered text nor a
    // serialized partial selection is a literal substring of the body.
    expect(slice('3 tbsp peanut butter, 2 tbsp soy sauce')).toBe(
      '3 tbsp peanut butter, 2 tbsp soy sauce',
    );
  });

  test('spans the emphasis markers when the passage crosses them', () => {
    expect(slice('Peanut sauce: 3 tbsp peanut butter')).toBe(
      'Peanut sauce:** 3 tbsp peanut butter',
    );
  });

  test('skips the leading `**` rather than opening the range on it', () => {
    const hit = findPassage(BODY, 'Peanut sauce:', { syntaxIn: 'haystack' });
    expect(BODY.slice(hit?.start ?? 0, hit?.end ?? 0)).toBe('Peanut sauce:');
  });

  test('crosses a heading marker and an ordered-list marker', () => {
    expect(slice('Steps Toss the tofu with the cornstarch')).toBe(
      'Steps\n\n1. Toss the tofu with the cornstarch',
    );
  });

  test('crosses bullet markers between list items', () => {
    expect(slice('thawed) Peanut sauce:')).toBe('thawed)\n- **Peanut sauce:');
  });

  test('still refuses a passage that is not there', () => {
    expect(findPassage(BODY, 'gochujang to taste', { syntaxIn: 'haystack' })).toBeNull();
  });

  test('does not let syntax elasticity bridge different words', () => {
    // `peanut butter` and `soy sauce` both occur, but not adjacently — a fuzzy
    // matcher would happily join them.
    expect(findPassage(BODY, 'peanut soy', { syntaxIn: 'haystack' })).toBeNull();
  });

  test('an exact substring resolves to itself', () => {
    expect(slice('Scallions, chopped peanuts, to serve')).toBe(
      'Scallions, chopped peanuts, to serve',
    );
  });

  test('reports every occurrence in document order', () => {
    const hits = findAllPassages('a soy b soy', 'soy', { syntaxIn: 'haystack' });
    expect(hits.map((h) => h.start)).toEqual([2, 8]);
  });

  test('an empty needle matches nothing', () => {
    expect(findAllPassages(BODY, '', { syntaxIn: 'haystack' })).toEqual([]);
  });
});

describe('a markdown quote against rendered text', () => {
  // The mirror direction: a stored anchor is markdown, the editor's text index
  // is rendered, so the syntax now sits in the needle.
  const RENDERED = 'Peanut sauce: 3 tbsp peanut butter, 2 tbsp soy sauce, water to loosen';

  test('finds a bolded quote in rendered text', () => {
    const hit = findPassage(RENDERED, '**Peanut sauce:** 3 tbsp', { syntaxIn: 'needle' });
    expect(RENDERED.slice(hit?.start ?? -1, hit?.end ?? -1)).toBe('Peanut sauce: 3 tbsp');
  });

  test('finds a quote carrying a list marker it no longer renders', () => {
    const hit = findPassage(RENDERED, '- **Peanut sauce:** 3 tbsp', { syntaxIn: 'needle' });
    expect(hit?.start).toBe(0);
  });

  test('rejects a quote whose words are absent', () => {
    expect(findPassage(RENDERED, '**Chili crisp:**', { syntaxIn: 'needle' })).toBeNull();
  });
});

describe('links', () => {
  // A link renders as its label alone, so `](target)` is invisible to anyone
  // selecting rendered text. Missing that made every passage containing a link
  // unmatchable — which, in a linked wiki, is most of the interesting ones.
  const BODY =
    '- **Leftovers:** any half-finished tin goes into [Sardine Toast](../sardine/toast.md) or [[lemon-garlic]] the next day.';

  test('matches across an inline link', () => {
    const hit = findPassage(BODY, 'goes into Sardine Toast or', { syntaxIn: 'haystack' });
    expect(hit).not.toBeNull();
    expect(BODY.slice(hit?.start, hit?.end)).toContain('Sardine Toast');
  });

  test('matches across a wiki link', () => {
    expect(
      findPassage(BODY, 'or lemon-garlic the next day.', { syntaxIn: 'haystack' }),
    ).not.toBeNull();
  });

  test('matches a whole bullet containing two links', () => {
    const hit = findPassage(
      BODY,
      'Leftovers: any half-finished tin goes into Sardine Toast or lemon-garlic the next day.',
      { syntaxIn: 'haystack' },
    );
    expect(hit).not.toBeNull();
    // The resolved range covers the real source text, target and all.
    expect(BODY.slice(hit?.start, hit?.end)).toContain('../sardine/toast.md');
  });

  test('a match never begins on a bracket', () => {
    // Otherwise the reported range opens with syntax the caller never selected.
    const hit = findPassage(BODY, 'Sardine Toast', { syntaxIn: 'haystack' });
    expect(BODY[hit?.start ?? -1]).toBe('S');
  });

  test('the mirror direction: a stored markdown quote against rendered text', () => {
    const rendered = 'any half-finished tin goes into Sardine Toast or lemon-garlic the next day.';
    const stored = 'goes into [Sardine Toast](../sardine/toast.md) or [[lemon-garlic]]';
    expect(findPassage(rendered, stored, { syntaxIn: 'needle' })).not.toBeNull();
  });

  test('still refuses different words inside a link', () => {
    expect(findPassage(BODY, 'goes into Anchovy Toast or', { syntaxIn: 'haystack' })).toBeNull();
  });

  test('a bare bracket in prose is not treated as syntax', () => {
    const prose = 'the array[0] value is fine';
    expect(findPassage(prose, 'array[0] value', { syntaxIn: 'haystack' })).not.toBeNull();
  });
});

describe('lines that render as nothing', () => {
  // The reported failure: dragging a selection across a code block returned a
  // bare 400. The fence's backticks were already elastic, but the info string
  // after them was not, so the match died on the `ts` in ```` ```ts ````.
  const BODY = `Add \`appearance.language\` to \`ConfigSchema\`:

\`\`\`ts
language: z
  .enum(['system', 'en', 'es'])
\`\`\`

Acceptance: the leaf validates.`;

  /** What the editor hands over: rendered text, blocks joined by a newline. */
  const rendered = (...lines: string[]): string => lines.join('\n');

  test('a selection running from prose into a tagged code block', () => {
    const hit = findPassage(
      BODY,
      rendered('Add appearance.language to ConfigSchema:', 'language: z'),
      { syntaxIn: 'haystack' },
    );
    expect(BODY.slice(hit?.start, hit?.end)).toContain('```ts');
  });

  test('a selection running out of a code block back into prose', () => {
    expect(
      findPassage(BODY, rendered("  .enum(['system', 'en', 'es'])", 'Acceptance: the leaf'), {
        syntaxIn: 'haystack',
      }),
    ).not.toBeNull();
  });

  test('a selection swallowing the whole block', () => {
    expect(
      findPassage(
        BODY,
        rendered(
          'to ConfigSchema:',
          'language: z',
          "  .enum(['system', 'en', 'es'])",
          'Acceptance:',
        ),
        { syntaxIn: 'haystack' },
      ),
    ).not.toBeNull();
  });

  test('a code block selected on its own is still an exact substring', () => {
    const hit = findPassage(BODY, "language: z\n  .enum(['system', 'en', 'es'])", {
      syntaxIn: 'haystack',
    });
    expect(BODY.slice(hit?.start, hit?.end)).toBe("language: z\n  .enum(['system', 'en', 'es'])");
  });

  test('a tilde fence carries an info string too', () => {
    expect(
      findPassage('before\n\n~~~ts\ncode here\n~~~\n\nafter', rendered('before', 'code here'), {
        syntaxIn: 'haystack',
      }),
    ).not.toBeNull();
  });

  test('the mirror direction: a stored quote carrying a fence', () => {
    // The server stores the body slice, fence and all; the editor then re-finds
    // it against rendered text, so the same line has to be elastic both ways.
    const editorText = 'to ConfigSchema:language: z';
    expect(
      findPassage(editorText, 'to `ConfigSchema`:\n\n```ts\nlanguage: z', { syntaxIn: 'needle' }),
    ).not.toBeNull();
  });

  test('crosses a thematic break', () => {
    expect(
      findPassage('before\n\n---\n\nafter', rendered('before', 'after'), { syntaxIn: 'haystack' }),
    ).not.toBeNull();
  });

  test('crosses a setext heading underline', () => {
    expect(
      findPassage('Title\n=====\n\nbody text', rendered('Title', 'body text'), {
        syntaxIn: 'haystack',
      }),
    ).not.toBeNull();
  });

  test('crosses a table delimiter row and its cell boundaries', () => {
    expect(
      findPassage('| a | b |\n| --- | --- |\n| 1 | 2 |', rendered('a b', '1 2'), {
        syntaxIn: 'haystack',
      }),
    ).not.toBeNull();
  });

  test('crosses task-list checkboxes', () => {
    expect(
      findPassage('- [ ] todo one\n- [x] todo two', rendered('todo one', 'todo two'), {
        syntaxIn: 'haystack',
      }),
    ).not.toBeNull();
  });

  test('a line carrying content is never swallowed whole', () => {
    // `***bold***` opens like a thematic break, so the needle has to STRADDLE
    // it: fragments either side, nothing naming the line itself. Treating the
    // line as invisible would bridge them. A real break is the control — same
    // shape, same needle, and it must match.
    const straddle = rendered('head', 'tail');
    expect(
      findPassage('head\n\n***bold***\n\ntail', straddle, { syntaxIn: 'haystack' }),
    ).toBeNull();
    expect(findPassage('head\n\n---\n\ntail', straddle, { syntaxIn: 'haystack' })).not.toBeNull();

    // Same pair for the table-rule pattern, which `-- dashes` opens like.
    expect(findPassage('head\n\n-- dashes\n\ntail', straddle, { syntaxIn: 'haystack' })).toBeNull();
    expect(findPassage('head\n\n-- --\n\ntail', straddle, { syntaxIn: 'haystack' })).not.toBeNull();
  });

  test('elasticity across a fence still cannot bridge different words', () => {
    expect(findPassage(BODY, 'ConfigSchema: gochujang', { syntaxIn: 'haystack' })).toBeNull();
  });

  describe('CRLF documents', () => {
    // The line slice runs to the `\n`, so on CRLF it carries a trailing `\r`.
    // The rule patterns' character classes do not admit one, so `$` could not
    // match and every rule line stayed non-elastic on Windows line endings.
    const crlf = (...lines: string[]): string => lines.join('\r\n');
    const straddle = rendered('head', 'tail');

    test('a thematic break', () => {
      expect(
        findPassage(crlf('head', '', '---', '', 'tail'), straddle, {
          syntaxIn: 'haystack',
        }),
      ).not.toBeNull();
    });

    test('a setext heading underline', () => {
      expect(
        findPassage(crlf('Title', '=====', '', 'tail'), rendered('Title', 'tail'), {
          syntaxIn: 'haystack',
        }),
      ).not.toBeNull();
    });

    test('a table delimiter row and its cell boundaries', () => {
      expect(
        findPassage(crlf('| a | b |', '| --- | --- |', '| 1 | 2 |'), rendered('a b', '1 2'), {
          syntaxIn: 'haystack',
        }),
      ).not.toBeNull();
    });

    test('a fenced code block with an info string', () => {
      expect(
        findPassage(
          crlf('before', '', '```ts', 'code here', '```', '', 'after'),
          rendered('before', 'code here', 'after'),
          {
            syntaxIn: 'haystack',
          },
        ),
      ).not.toBeNull();
    });

    test('a content line is still not swallowed', () => {
      expect(
        findPassage(crlf('head', '', '***bold***', '', 'tail'), straddle, {
          syntaxIn: 'haystack',
        }),
      ).toBeNull();
    });
  });
});

/**
 * Constructs whose markup renders as nothing, or as less than it spells.
 *
 * Each of these failed as a bare "the quoted passage is not in the document"
 * for any comment on a paragraph that merely CONTAINED one — which in a
 * wiki-style document is most paragraphs, since wiki links and tags are
 * everywhere. The quote is always what the editor renders; the body is what is
 * on disk.
 */
describe('markup that renders as less than it spells', () => {
  /** The passage the caller quoted, as it sits in the body. */
  function locate(body: string, quote: string): string | null {
    const hit = findPassage(body, quote, { syntaxIn: 'haystack' });
    return hit ? body.slice(hit.start, hit.end) : null;
  }

  test('a highlight, whose `==` delimiters render as nothing', () => {
    expect(locate('A ==marked== word.', 'A marked word.')).toBe('A ==marked== word.');
  });

  test('inline math, whose `$$` delimiters render as nothing', () => {
    expect(locate('A $$x^2$$ word.', 'A x^2 word.')).toBe('A $$x^2$$ word.');
  });

  test('an image, which renders as its alt text alone', () => {
    expect(locate('A ![alt](img.png) word.', 'A alt word.')).toBe('A ![alt](img.png) word.');
  });

  test('a reference-style image, which renders as its alt text alone', () => {
    expect(locate('A ![alt][ref] word.', 'A alt word.')).toBe('A ![alt][ref] word.');
  });

  test('a wiki link, which renders as its target', () => {
    expect(locate('A [[page]] word.', 'A page word.')).toBe('A [[page]] word.');
  });

  test('an aliased wiki link, which renders as the alias and hides the target', () => {
    expect(locate('A [[page|Alias]] word.', 'A Alias word.')).toBe('A [[page|Alias]] word.');
  });

  test('a wiki link with a heading fragment, which renders without it', () => {
    expect(locate('A [[page#sec]] word.', 'A page word.')).toBe('A [[page#sec]] word.');
  });

  test('a footnote reference, whose brackets render as nothing', () => {
    expect(locate('A claim[^1] word.', 'A claim1 word.')).toBe('A claim[^1] word.');
  });

  test('an inline HTML tag, which renders as its content alone', () => {
    expect(locate('A <u>under</u> word.', 'A under word.')).toBe('A <u>under</u> word.');
  });

  test('an autolink, which renders as the bare URL', () => {
    expect(locate('A <http://x.com> word.', 'A http://x.com word.')).toBe('A <http://x.com> word.');
  });

  test('a mermaid fence, whose delimiters render as nothing', () => {
    expect(
      locate('Before.\n\n```mermaid\ngraph TD;\n```\n\nAfter.', 'Before.\ngraph TD;\nAfter.'),
    ).toBe('Before.\n\n```mermaid\ngraph TD;\n```\n\nAfter.');
  });

  /**
   * `<` is elastic so an autolink can be crossed, but inline HTML that SURVIVES
   * into rendered text is quoted with its tags — and a match has to be allowed
   * to open on one. The start guard declines a syntax character only when the
   * caller's own quote does not begin with it.
   */
  test('opens a match on a `<` the caller actually quoted', () => {
    expect(locate('<div>\nbody\n</div>', '<div>\nbody\n</div>')).toBe('<div>\nbody\n</div>');
  });

  test('a bare `#` mid-sentence is still content, not a wiki-link fragment', () => {
    // Tags render WITH their `#`, so it must match literally rather than being
    // skipped — otherwise a quote could drift onto a different tag.
    expect(locate('A #alpha and #beta.', 'A #beta.')).toBeNull();
  });

  test('a line-leading `#` is still a heading marker', () => {
    expect(locate('## Heading here', 'Heading here')).toBe('Heading here');
  });

  test('a bare `!` is still content', () => {
    expect(locate('Wow! Amazing.', 'Wow Amazing.')).toBeNull();
  });

  /**
   * Sisters to the `!` rule above. None of these characters is markdown syntax
   * on its own — a highlight is always `==`, and `<` / `>` are invisible only
   * as the brackets of an autolink. Skipping a lone one would let a match cross
   * an operator the quote never contained.
   */
  test('a lone `=` is still content', () => {
    expect(locate('A = B', 'A B')).toBeNull();
  });

  test('a lone `>` is still content', () => {
    expect(locate('if x > y then', 'if x y then')).toBeNull();
  });

  test('a lone `<` is still content', () => {
    expect(locate('if x < y then', 'if x y then')).toBeNull();
  });

  test('an arrow is still content', () => {
    expect(locate('map a => b here', 'map a b here')).toBeNull();
  });

  test('a `>` that closes no autolink is still content', () => {
    expect(locate('read <docs> now', 'read docs now')).toBeNull();
  });

  test('an email autolink renders as the address', () => {
    expect(locate('Mail <a@b.com> now.', 'Mail a@b.com now.')).toBe('Mail <a@b.com> now.');
  });

  test('a line-leading `>` is still a blockquote marker', () => {
    expect(locate('> Quoted line.', 'Quoted line.')).toBe('Quoted line.');
  });
});

/**
 * The recovery ceiling, shared by both sides.
 *
 * It lived as two copies of two constants under a drift warning — the same
 * arrangement that had already let the context scorer diverge, fixed on one
 * side and silently stale on the other. These pin the policy itself so a change
 * to it is a deliberate edit to one visible contract.
 */
describe('rewriteCeiling', () => {
  test('allows a short passage to grow by the floor, not by the multiple', () => {
    // 4x of 5 is 20, which would refuse an ordinary edit to a short quote.
    expect(rewriteCeiling(5)).toBe(69);
  });

  test('allows a long passage to grow by the multiple', () => {
    expect(rewriteCeiling(100)).toBe(400);
  });

  test('never returns less than the passage itself', () => {
    for (const length of [0, 1, 21, 64, 500]) {
      expect(rewriteCeiling(length)).toBeGreaterThanOrEqual(length);
    }
  });

  test('grows monotonically', () => {
    let previous = -1;
    for (const length of [0, 10, 50, 100, 1000]) {
      const ceiling = rewriteCeiling(length);
      expect(ceiling).toBeGreaterThan(previous);
      previous = ceiling;
    }
  });
});

/**
 * Whitespace is elastic on both sides everywhere else in the matcher, but the
 * scan loop can only skip a needle's whitespace while there is still haystack
 * left to compare against. A needle ending in whitespace therefore failed at the
 * very end of the text.
 *
 * The field case: a comment on a document's LAST passage. Rendered editor text
 * carries no trailing newline, while a stored suffix that ran off the end of the
 * markdown body is exactly "\n" — so the deletion probe in the editor's
 * `findRangeInIndex` saw `prefix + suffix` match and `prefix + quote + suffix`
 * not, concluded the passage had been deleted where it stood, and dropped the
 * highlight. The server, whose haystack is the body and does end in a newline,
 * went on reporting the thread as anchored.
 */
describe('a needle ending in whitespace, at the end of the haystack', () => {
  const rendered = 'Serve withWarm tortillas or a dollop of yogurt/crema';
  const prefix = 'tortillas or a dollop of yogurt/';

  test('completes when the haystack is exhausted', () => {
    expect(findAllPassages(rendered, `${prefix}crema\n`, { syntaxIn: 'needle' })).toEqual([
      { start: rendered.indexOf(prefix), end: rendered.length },
    ]);
  });

  test('agrees with the same needle one character short of the end', () => {
    // Both must match, or the deletion probe reads a document-final passage as
    // deleted purely because of where it sits.
    expect(findAllPassages(rendered, `${prefix}\n`, { syntaxIn: 'needle' }).length).toBe(1);
    expect(findAllPassages(rendered, `${prefix}crema\n`, { syntaxIn: 'needle' }).length).toBe(1);
  });

  test('does not invent a match for trailing content', () => {
    // Only whitespace is forgiven at the edge. A needle asking for real
    // characters the haystack does not have must still fail.
    expect(findAllPassages(rendered, `${prefix}crema and rice`, { syntaxIn: 'needle' })).toEqual(
      [],
    );
    expect(findAllPassages(rendered, `${prefix}crema\n.`, { syntaxIn: 'needle' })).toEqual([]);
  });
});

/**
 * Character references the display pipeline DECODES.
 *
 * The matcher treats markdown's own syntax as elastic, but markdown syntax is
 * not the only place the body and the screen legally disagree. The byte-fidelity
 * serializer mints a bare numeric char-ref to hold a phrasing-boundary space or
 * tab across re-parse (CommonMark §6.4) — a space just inside `**…**` would
 * otherwise dissolve the emphasis — and the display decode turns it back into
 * the one character the reader sees. Six bytes on disk, one on screen.
 *
 * Nothing taught the matcher that, so a quote crossing one cannot find its passage
 * in the body and the anchor is refused. It reaches ordinary documents because
 * nobody types the entity: typing a space just inside bold, or indenting a
 * paragraph, is enough to mint one.
 *
 * The decode set is deliberately narrow — `whitespace-char-ref.ts` owns it, and
 * only SPACE, TAB, and NBSP are in it. Everything else (`&nbsp;`, `&amp;`,
 * `&#x2014;`) survives to the screen as its own literal bytes and already
 * matches; making those elastic would let a passage cross an ampersand or an em
 * dash the quote never contained.
 */
describe('numeric character references the display pipeline decodes', () => {
  /** The slice of `body` a caller's rendered quote resolves to. */
  function locate(body: string, quote: string): string | null {
    const hit = findPassage(body, quote, { syntaxIn: 'haystack' });
    return hit ? body.slice(hit.start, hit.end) : null;
  }

  /**
   * The fixtures below name refs on both sides of the decode boundary. This
   * pins them to the predicate that actually draws it, so widening the decode
   * set fails here rather than silently leaving the matcher a construct behind
   * — the exact class of drift a decode-set widening would silently introduce.
   */
  /** U+00A0, spelled out — a literal one in a string is invisible to a reader. */
  const NBSP = '\u00A0';

  const DECODED = ['&#x20;', '&#32;', '&#X20;', '&#x0020;', '&#x9;', '&#xA0;', '&#160;'];
  const LITERAL = ['&nbsp;', '&amp;', '&hellip;', '&lt;', '&emsp;', '&#x41;', '&#38;', '&#x2014;'];

  test('the fixtures agree with the decode contract they stand for', () => {
    for (const ref of DECODED) expect(isInlineWhitespaceNumericCharRef(ref)).toBe(true);
    for (const ref of LITERAL) expect(isInlineWhitespaceNumericCharRef(ref)).toBe(false);
  });

  test('every decoded ref is crossable, in either spelling', () => {
    // Decimal and hex, upper and lower `X`, zero-padded — all the same character
    // to a reader, so all the same to a quote.
    for (const ref of ['&#x20;', '&#32;', '&#X20;', '&#x0020;']) {
      expect(locate(`A ${ref} B`, 'A   B')).toBe(`A ${ref} B`);
    }
  });

  test('a tab ref is crossable', () => {
    expect(locate('A &#x9; B', 'A \t B')).toBe('A &#x9; B');
  });

  test('an NBSP ref is crossable, and its character still has to be there', () => {
    // NBSP is the case that rules out skipping the run as invisible syntax:
    // U+00A0 is not whitespace to this matcher, so the quote carries it as
    // content and the body's six bytes have to answer for it.
    expect(locate('A &#xA0; B', `A ${NBSP} B`)).toBe('A &#xA0; B');
    expect(locate('A &#160; B', `A ${NBSP} B`)).toBe('A &#160; B');
    // ...and a quote holding an ordinary space where the reader sees an NBSP
    // is quoting a character the body does not have.
    expect(locate('A &#xA0; B', 'A   B')).toBeNull();
  });

  test('crosses a ref with no spaces around it', () => {
    expect(locate('foo&#x20;bar', 'foo bar')).toBe('foo&#x20;bar');
  });

  test('crosses a run of back-to-back refs', () => {
    expect(locate('A &#x20;&#x9;&#x20; B', 'A  \t  B')).toBe('A &#x20;&#x9;&#x20; B');
  });

  test('the reported passage: a boundary space inside emphasis', () => {
    // The line from the reporter's document, verbatim. The serializer minted the
    // `&#x20;` to hold the space the author typed before the closing `***`.
    expect(
      locate(
        '~~***External apps &#x20;***[external action icon]~~',
        'External apps  [external action icon]',
      ),
    ).toBe('External apps &#x20;***[external action icon]');
  });

  test('a ref that renders as itself stays content', () => {
    // `&nbsp;` and friends are never decoded, so they are on screen and a quote
    // that omits them is quoting something else.
    for (const ref of LITERAL) {
      expect(locate(`A ${ref} B`, 'A B')).toBeNull();
    }
  });

  test('a decoded ref does not make the surrounding text elastic', () => {
    expect(locate('A &#x20; B', 'A   C')).toBeNull();
    expect(locate('A &#x20; B', 'X   B')).toBeNull();
  });

  /**
   * The stored side of the same disagreement.
   *
   * An anchor's `exact` is sliced out of the body, so it arrives carrying the
   * entity; the editor searches the text a reader can see. A comment that
   * anchored server-side would otherwise lose its highlight here, and the
   * context scorer would read the neighbourhood as changed.
   */
  test('the ref is crossable from the stored side too', () => {
    expect(findPassage('A   B', 'A &#x20; B', { syntaxIn: 'needle' })).not.toBeNull();
    expect(findPassage(`A ${NBSP} B`, 'A &#xA0; B', { syntaxIn: 'needle' })).not.toBeNull();
    expect(findPassage('foo bar', 'foo&#x20;bar', { syntaxIn: 'needle' })).not.toBeNull();
  });

  test('a literal ref is still content from the stored side', () => {
    expect(findPassage('A B', 'A &nbsp; B', { syntaxIn: 'needle' })).toBeNull();
  });

  test('a match does not open on a ref the caller did not select', () => {
    // The span is stored and re-asserted against the body, so a range that
    // opens on six bytes the reader never saw is a range that reads wrong.
    expect(locate('&#x20;foo', 'foo')).toBe('foo');
  });

  test('a run stops at the first byte that is not a ref', () => {
    // Guards the sticky flag on the token regex. Sticky anchors `exec` at
    // `lastIndex`; a global one would happily return a ref from further down
    // the text, so the scan would swallow whatever sat in between and report a
    // run that never existed. Here that would make `abc` invisible and let the
    // quote match across it.
    expect(locate('x&#x20;abc&#x20;def', 'x def')).toBeNull();
    expect(locate('x&#x20;abc&#x20;def', 'x abc def')).toBe('x&#x20;abc&#x20;def');
  });

  test('malformed refs are ordinary content', () => {
    // Only a complete, well-formed numeric ref decodes. A bare ampersand, an
    // unterminated ref, and a ref with a bad body are all just characters.
    for (const body of ['A & B', 'A &#x20 B', 'A &#; B', 'A &#xZZ; B', 'A &# B']) {
      expect(locate(body, 'A B')).toBeNull();
    }
  });

  /**
   * Context scoring reads the same two substrates and has to make the same
   * allowance. Without it every candidate near a ref scores near zero, the
   * evidence floor can no longer be met, and a passage orphans because text
   * NEAR it — inside the stored context window, outside the quote — was edited.
   */
  test('context scoring sees through a ref the same way', () => {
    const body = 'Intro. External apps &#x20;***[icon]*** trails off here.';
    const span = { start: body.indexOf('External'), end: body.indexOf(' trails') };
    // Context as a client captures it: rendered text, no markdown syntax in it.
    const score = contextMatchScore(body, span, { prefix: 'Intro. ' }, { syntaxIn: 'haystack' });
    expect(score).toBeGreaterThanOrEqual(contextEvidenceFloor({ prefix: 'Intro. ' }));
  });

  test('a stored context carrying a ref still scores against the rendered side', () => {
    // The ref sits at the seam, where the context meets the passage — the
    // position that decides the score, since agreement is counted inward from
    // there. Six undecoded bytes at the seam take the common run to zero on
    // their own, however well the rest of the window agrees.
    const rendered = 'Intro. External apps today  trails off here.';
    const span = { start: rendered.indexOf('trails'), end: rendered.length };
    const score = contextMatchScore(
      rendered,
      span,
      { prefix: 'External apps ***today***&#x20;' },
      { syntaxIn: 'none', syntaxInContext: true },
    );
    expect(score).toBeGreaterThanOrEqual('Externalappstoday'.length);
  });

  test('context scoring keeps a decoded NBSP as content, not whitespace', () => {
    // NBSP must survive condense on the body side so both sides of the comparison
    // carry it. If NBSP were dropped like a space the condensations would disagree
    // and the score would fall below the floor.
    const body = 'Intro&#xA0;. External apps trails off here.';
    const span = { start: body.indexOf('External'), end: body.length };
    const score = contextMatchScore(
      body,
      span,
      { prefix: `Intro${NBSP}. ` },
      { syntaxIn: 'haystack' },
    );
    expect(score).toBeGreaterThanOrEqual(contextEvidenceFloor({ prefix: `Intro${NBSP}. ` }));
  });
});
