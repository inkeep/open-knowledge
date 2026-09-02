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

function slice(needle: string, syntaxIn: 'haystack' | 'needle' = 'haystack'): string | null {
  const hit = findPassage(BODY, needle, { syntaxIn });
  return hit ? BODY.slice(hit.start, hit.end) : null;
}

describe('rendered text against a markdown body', () => {
  test('finds a passage that starts after a bold run inside a bullet', () => {
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
    expect(BODY.slice(hit?.start, hit?.end)).toContain('../sardine/toast.md');
  });

  test('a match never begins on a bracket', () => {
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
  const BODY = `Add \`appearance.language\` to \`ConfigSchema\`:

\`\`\`ts
language: z
  .enum(['system', 'en', 'es'])
\`\`\`

Acceptance: the leaf validates.`;

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
    const straddle = rendered('head', 'tail');
    expect(
      findPassage('head\n\n***bold***\n\ntail', straddle, { syntaxIn: 'haystack' }),
    ).toBeNull();
    expect(findPassage('head\n\n---\n\ntail', straddle, { syntaxIn: 'haystack' })).not.toBeNull();

    expect(findPassage('head\n\n-- dashes\n\ntail', straddle, { syntaxIn: 'haystack' })).toBeNull();
    expect(findPassage('head\n\n-- --\n\ntail', straddle, { syntaxIn: 'haystack' })).not.toBeNull();
  });

  test('elasticity across a fence still cannot bridge different words', () => {
    expect(findPassage(BODY, 'ConfigSchema: gochujang', { syntaxIn: 'haystack' })).toBeNull();
  });

  describe('CRLF documents', () => {
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

describe('markup that renders as less than it spells', () => {
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

  test('opens a match on a `<` the caller actually quoted', () => {
    expect(locate('<div>\nbody\n</div>', '<div>\nbody\n</div>')).toBe('<div>\nbody\n</div>');
  });

  test('a bare `#` mid-sentence is still content, not a wiki-link fragment', () => {
    expect(locate('A #alpha and #beta.', 'A #beta.')).toBeNull();
  });

  test('a line-leading `#` is still a heading marker', () => {
    expect(locate('## Heading here', 'Heading here')).toBe('Heading here');
  });

  test('a bare `!` is still content', () => {
    expect(locate('Wow! Amazing.', 'Wow Amazing.')).toBeNull();
  });

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

describe('rewriteCeiling', () => {
  test('allows a short passage to grow by the floor, not by the multiple', () => {
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

describe('a needle ending in whitespace, at the end of the haystack', () => {
  const rendered = 'Serve withWarm tortillas or a dollop of yogurt/crema';
  const prefix = 'tortillas or a dollop of yogurt/';

  test('completes when the haystack is exhausted', () => {
    expect(findAllPassages(rendered, `${prefix}crema\n`, { syntaxIn: 'needle' })).toEqual([
      { start: rendered.indexOf(prefix), end: rendered.length },
    ]);
  });

  test('agrees with the same needle one character short of the end', () => {
    expect(findAllPassages(rendered, `${prefix}\n`, { syntaxIn: 'needle' }).length).toBe(1);
    expect(findAllPassages(rendered, `${prefix}crema\n`, { syntaxIn: 'needle' }).length).toBe(1);
  });

  test('does not invent a match for trailing content', () => {
    expect(findAllPassages(rendered, `${prefix}crema and rice`, { syntaxIn: 'needle' })).toEqual(
      [],
    );
    expect(findAllPassages(rendered, `${prefix}crema\n.`, { syntaxIn: 'needle' })).toEqual([]);
  });
});

describe('numeric character references the display pipeline decodes', () => {
  function locate(body: string, quote: string): string | null {
    const hit = findPassage(body, quote, { syntaxIn: 'haystack' });
    return hit ? body.slice(hit.start, hit.end) : null;
  }

  const NBSP = '\u00A0';

  const DECODED = ['&#x20;', '&#32;', '&#X20;', '&#x0020;', '&#x9;', '&#xA0;', '&#160;'];
  const LITERAL = ['&nbsp;', '&amp;', '&hellip;', '&lt;', '&emsp;', '&#x41;', '&#38;', '&#x2014;'];

  test('the fixtures agree with the decode contract they stand for', () => {
    for (const ref of DECODED) expect(isInlineWhitespaceNumericCharRef(ref)).toBe(true);
    for (const ref of LITERAL) expect(isInlineWhitespaceNumericCharRef(ref)).toBe(false);
  });

  test('every decoded ref is crossable, in either spelling', () => {
    for (const ref of ['&#x20;', '&#32;', '&#X20;', '&#x0020;']) {
      expect(locate(`A ${ref} B`, 'A   B')).toBe(`A ${ref} B`);
    }
  });

  test('a tab ref is crossable', () => {
    expect(locate('A &#x9; B', 'A \t B')).toBe('A &#x9; B');
  });

  test('an NBSP ref is crossable, and its character still has to be there', () => {
    expect(locate('A &#xA0; B', `A ${NBSP} B`)).toBe('A &#xA0; B');
    expect(locate('A &#160; B', `A ${NBSP} B`)).toBe('A &#160; B');
    expect(locate('A &#xA0; B', 'A   B')).toBeNull();
  });

  test('crosses a ref with no spaces around it', () => {
    expect(locate('foo&#x20;bar', 'foo bar')).toBe('foo&#x20;bar');
  });

  test('crosses a run of back-to-back refs', () => {
    expect(locate('A &#x20;&#x9;&#x20; B', 'A  \t  B')).toBe('A &#x20;&#x9;&#x20; B');
  });

  test('the reported passage: a boundary space inside emphasis', () => {
    expect(
      locate(
        '~~***External apps &#x20;***[external action icon]~~',
        'External apps  [external action icon]',
      ),
    ).toBe('External apps &#x20;***[external action icon]');
  });

  test('a ref that renders as itself stays content', () => {
    for (const ref of LITERAL) {
      expect(locate(`A ${ref} B`, 'A B')).toBeNull();
    }
  });

  test('a decoded ref does not make the surrounding text elastic', () => {
    expect(locate('A &#x20; B', 'A   C')).toBeNull();
    expect(locate('A &#x20; B', 'X   B')).toBeNull();
  });

  test('the ref is crossable from the stored side too', () => {
    expect(findPassage('A   B', 'A &#x20; B', { syntaxIn: 'needle' })).not.toBeNull();
    expect(findPassage(`A ${NBSP} B`, 'A &#xA0; B', { syntaxIn: 'needle' })).not.toBeNull();
    expect(findPassage('foo bar', 'foo&#x20;bar', { syntaxIn: 'needle' })).not.toBeNull();
  });

  test('a literal ref is still content from the stored side', () => {
    expect(findPassage('A B', 'A &nbsp; B', { syntaxIn: 'needle' })).toBeNull();
  });

  test('a match does not open on a ref the caller did not select', () => {
    expect(locate('&#x20;foo', 'foo')).toBe('foo');
  });

  test('a run stops at the first byte that is not a ref', () => {
    expect(locate('x&#x20;abc&#x20;def', 'x def')).toBeNull();
    expect(locate('x&#x20;abc&#x20;def', 'x abc def')).toBe('x&#x20;abc&#x20;def');
  });

  test('malformed refs are ordinary content', () => {
    for (const body of ['A & B', 'A &#x20 B', 'A &#; B', 'A &#xZZ; B', 'A &# B']) {
      expect(locate(body, 'A B')).toBeNull();
    }
  });

  test('context scoring sees through a ref the same way', () => {
    const body = 'Intro. External apps &#x20;***[icon]*** trails off here.';
    const span = { start: body.indexOf('External'), end: body.indexOf(' trails') };
    const score = contextMatchScore(body, span, { prefix: 'Intro. ' }, { syntaxIn: 'haystack' });
    expect(score).toBeGreaterThanOrEqual(contextEvidenceFloor({ prefix: 'Intro. ' }));
  });

  test('a stored context carrying a ref still scores against the rendered side', () => {
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
