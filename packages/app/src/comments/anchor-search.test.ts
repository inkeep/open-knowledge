import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'vitest';
import {
  buildTextIndex,
  captureSelectionContext,
  createAnchorResolver,
  findRangeInIndex,
} from './anchor-search';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

function indexOf(text: string): { text: string; positions: number[] } {
  return { text, positions: Array.from({ length: text.length }, (_, i) => i + 1) };
}

const DOC = 'Add the garlic and cook 1 min. Stir the sauce. Add the garlic and serve.';
const FIRST = DOC.indexOf('Add the garlic');
const SECOND = DOC.indexOf('Add the garlic', FIRST + 1);

describe('findRangeInIndex — deleting the selection leaves a seam', () => {
  test('declines the twin even when its neighbourhood matches honestly', () => {
    const sentence = 'The chord stages into the agents panel specifically, naming its target.';
    const afterDelete =
      `Intro first. The chord stages into  specifically, naming its target. ` +
      `Later, restated: ${sentence}`;
    const range = findRangeInIndex(indexOf(afterDelete), 'the agents panel', {
      prefix: 'Intro first. The chord stages into ',
      suffix: ' specifically, naming its target. Later,',
    });
    expect(range).toBeNull();
  });
});

describe('findRangeInIndex — a deleted passage with an identical twin', () => {
  test('declines the surviving twin instead of highlighting it', () => {
    const afterDelete = 'Closing notes mention Add the garlic near the archive vault.';
    const range = findRangeInIndex(indexOf(afterDelete), 'Add the garlic', {
      prefix: 'The northern site reports that you should ',
      suffix: ' and cook until fragrant, one minute.',
    });
    expect(range).toBeNull();
  });

  test('still accepts a lone hit whose surroundings carry a trace of the context', () => {
    const edited = 'Stir the sauce. Add the garlic and serve immediately, garnished.';
    const at = edited.indexOf('Add the garlic');
    const range = findRangeInIndex(indexOf(edited), 'Add the garlic', {
      prefix: 'Stir the sauce. ',
      suffix: ' and serve.',
    });
    expect(range).toEqual({ from: at + 1, to: at + 1 + 'Add the garlic'.length });
  });
});

describe('findRangeInIndex — repeated quote', () => {
  test('the fixture really does repeat (guards the guard)', () => {
    expect(FIRST).toBeGreaterThanOrEqual(0);
    expect(SECOND).toBeGreaterThan(FIRST);
  });

  test('suffix context selects the SECOND occurrence', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Add the garlic', {
      prefix: 'Stir the sauce. ',
      suffix: ' and serve.',
    });
    expect(range).toEqual({ from: SECOND + 1, to: SECOND + 1 + 'Add the garlic'.length });
  });

  test('prefix context selects the FIRST occurrence', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Add the garlic', {
      prefix: '',
      suffix: ' and cook 1 min.',
    });
    expect(range).toEqual({ from: FIRST + 1, to: FIRST + 1 + 'Add the garlic'.length });
  });

  test('without context it falls back to the first match (the old behavior)', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Add the garlic');
    expect(range?.from).toBe(FIRST + 1);
  });

  test('a genuine tie takes the earliest hit, ignoring a stored body offset', () => {
    const doc = 'x TARGET y x TARGET y';
    const first = doc.indexOf('TARGET');
    const second = doc.indexOf('TARGET', first + 1);
    const anchor = { quote: 'TARGET', prefix: 'x ', suffix: ' y', start: second, end: 0 };
    expect(findRangeInIndex(indexOf(doc), 'TARGET', anchor)?.from).toBe(first + 1);
  });

  test('a quote that is gone resolves to null', () => {
    expect(findRangeInIndex(indexOf(DOC), 'text that is not there')).toBeNull();
  });

  test('a unique quote needs no context', () => {
    const range = findRangeInIndex(indexOf(DOC), 'Stir the sauce');
    expect(range?.from).toBe(DOC.indexOf('Stir the sauce') + 1);
  });
});

describe('findRangeInIndex — a markdown quote against rendered text', () => {
  const RENDERED = 'Peanut sauce: 3 tbsp peanut butter, 2 tbsp soy sauce, water to loosen';

  test('locates a quote carrying emphasis markers the editor does not render', () => {
    const range = findRangeInIndex(indexOf(RENDERED), 'Peanut sauce:** 3 tbsp peanut butter');
    const start = RENDERED.indexOf('Peanut sauce: 3 tbsp peanut butter');
    expect(range).toEqual({
      from: start + 1,
      to: start + 1 + 'Peanut sauce: 3 tbsp peanut butter'.length,
    });
  });

  test('locates a quote carrying a list marker', () => {
    const range = findRangeInIndex(indexOf(RENDERED), '- **Peanut sauce:** 3 tbsp');
    expect(range?.from).toBe(1);
  });

  test('still returns null when the words are absent', () => {
    expect(findRangeInIndex(indexOf(RENDERED), '**Chili crisp:** 1 tbsp')).toBeNull();
  });
});

describe('findRangeInIndex — the passage was edited, not removed', () => {
  const DOC = 'Intro line. The layout needs space around the header. Outro line.';

  test('follows an insertion inside the passage', () => {
    const edited = DOC.replace('needs space', 'needs more space');
    const range = findRangeInIndex(indexOf(edited), 'needs space', {
      prefix: 'The layout ',
      suffix: ' around the header.',
    });
    const at = edited.indexOf('needs more space');
    expect(range).toEqual({ from: at + 1, to: at + 1 + 'needs more space'.length });
  });

  test('follows a deletion inside the passage', () => {
    const edited = DOC.replace('needs space around', 'needs space near');
    const range = findRangeInIndex(indexOf(edited), 'needs space around', {
      prefix: 'The layout ',
      suffix: ' the header.',
    });
    const at = edited.indexOf('needs space near');
    expect(range).toEqual({ from: at + 1, to: at + 1 + 'needs space near'.length });
  });

  test('an intact passage never reaches the bracket path', () => {
    const range = findRangeInIndex(indexOf(DOC), 'needs space', {
      prefix: 'The layout ',
      suffix: ' around the header.',
    });
    const at = DOC.indexOf('needs space');
    expect(range).toEqual({ from: at + 1, to: at + 1 + 'needs space'.length });
  });

  test('declines when the brackets are ambiguous', () => {
    const twice = 'A x B and later A y B';
    expect(findRangeInIndex(indexOf(twice), 'gone', { prefix: 'A ', suffix: ' B' })).toBeNull();
  });

  test('declines a wholesale replacement between the brackets', () => {
    const edited = DOC.replace('needs space', 'z'.repeat(400));
    expect(
      findRangeInIndex(indexOf(edited), 'needs space', {
        prefix: 'The layout ',
        suffix: ' around the header.',
      }),
    ).toBeNull();
  });

  test('declines when the passage was deleted outright', () => {
    const edited = DOC.replace('needs space ', '');
    expect(
      findRangeInIndex(indexOf(edited), 'needs space', {
        prefix: 'The layout ',
        suffix: 'around the header.',
      }),
    ).toBeNull();
  });
});

describe('buildTextIndex — text held in attributes', () => {
  function docOf(md: string): PMNode {
    return schema.nodeFromJSON(mdManager.parse(md));
  }

  function spanOf(doc: PMNode, typeName: string): { from: number; to: number } {
    let span: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (span === null && node.type.name === typeName) {
        span = { from: pos, to: pos + node.nodeSize };
      }
      return true;
    });
    if (span === null) throw new Error(`no ${typeName} in fixture`);
    return span;
  }

  test('a wiki link contributes its target', () => {
    expect(buildTextIndex(docOf('A [[page]] word.')).text).toBe('A page word.');
  });

  test('a tag contributes its `#` and name', () => {
    expect(buildTextIndex(docOf('A #tagname word.')).text).toBe('A #tagname word.');
  });

  test('a mermaid fence stays OUT of the prose index', () => {
    expect(buildTextIndex(docOf('```mermaid\ngraph TD;\n```')).text).toBe('');
  });

  test('a mermaid fence is in the component index', () => {
    expect(
      buildTextIndex(docOf('```mermaid\ngraph TD;\n```'), { includeBlockComponents: true }).text,
    ).toBe('graph TD;');
  });

  test('a hit inside an inline atom resolves to the whole atom', () => {
    const doc = docOf('A [[page]] word.');
    const range = findRangeInIndex(buildTextIndex(doc), 'page');
    expect(range).toEqual(spanOf(doc, 'wikiLink'));
  });

  test('a hit inside a promoted fence resolves to the whole node', () => {
    const doc = docOf('```mermaid\ngraph TD;\n```');
    const range = createAnchorResolver(doc)('graph TD;');
    expect(range).toEqual(spanOf(doc, 'jsxComponent'));
  });
});

describe('createAnchorResolver — a diagram never outbids the prose', () => {
  const MD = [
    '```mermaid',
    'sequenceDiagram',
    '  Note right of John: Bob thinks a long long time.',
    '```',
    '',
    'hi',
  ].join('\n');

  function docOf(md: string): PMNode {
    return schema.nodeFromJSON(mdManager.parse(md));
  }

  test('a short quote resolves to the paragraph, not into the diagram', () => {
    const doc = docOf(MD);
    let hiPos = -1;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'hi') hiPos = pos;
      return true;
    });
    expect(hiPos).toBeGreaterThanOrEqual(0);
    expect(createAnchorResolver(doc)('hi')?.from).toBe(hiPos);
  });

  test('the diagram is still reachable by a quote only it can satisfy', () => {
    const doc = docOf(MD);
    let span: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (span === null && node.type.name === 'jsxComponent') {
        span = { from: pos, to: pos + node.nodeSize };
      }
      return true;
    });
    const range = createAnchorResolver(doc)(
      'sequenceDiagram\n  Note right of John: Bob thinks a long long time.',
    );
    expect(range).toEqual(span);
  });
});

describe('a repeated quote under a block that renders no text', () => {
  const MD = ['$$', '1 + 1', '$$', '', 'hi', '', '> hello', '', ...Array(7).fill('- hi')].join(
    '\n',
  );

  test('resolves to the occurrence that was commented on', () => {
    const doc = schema.nodeFromJSON(mdManager.parse(MD));
    const occurrences: number[] = [];
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'hi') occurrences.push(pos);
      return true;
    });
    expect(occurrences.length).toBe(8);
    const target = occurrences[0] as number;

    const context = captureSelectionContext(doc, target, target + 2);
    expect(context.prefix).toContain('1 + 1');

    const anchor = { quote: 'hi', ...context, start: MD.indexOf('\nhi\n') + 1, end: 0 };
    expect(createAnchorResolver(doc)('hi', anchor)?.from).toBe(target);
  });
});

describe('context scoring across a block boundary', () => {
  test('picks the occurrence whose neighbouring block matches', () => {
    const MD = ['- hi', '- hi', '- hi', '', 'the marker paragraph', '', '- hi', '- hi'].join('\n');
    const doc = schema.nodeFromJSON(mdManager.parse(MD));
    const occurrences: number[] = [];
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'hi') occurrences.push(pos);
      return true;
    });
    expect(occurrences.length).toBe(5);

    const target = occurrences[2] as number;
    const context = captureSelectionContext(doc, target, target + 2);
    expect(context.suffix).toContain('the marker paragraph');

    expect(createAnchorResolver(doc)('hi', context)?.from).toBe(target);
  });

  test('and the one after the marker, which only its PREFIX separates', () => {
    const MD = ['- hi', '- hi', '- hi', '', 'the marker paragraph', '', '- hi', '- hi'].join('\n');
    const doc = schema.nodeFromJSON(mdManager.parse(MD));
    const occurrences: number[] = [];
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'hi') occurrences.push(pos);
      return true;
    });
    const target = occurrences[3] as number;
    const context = captureSelectionContext(doc, target, target + 2);
    expect(context.prefix).toContain('the marker paragraph');

    expect(createAnchorResolver(doc)('hi', context)?.from).toBe(target);
  });
});

describe('captureSelectionContext across an inline atom', () => {
  const MD = ['- [[alpha]] done', '- [[beta]] done'].join('\n');

  function occurrencesOfDone(doc: PMNode): number[] {
    const out: number[] = [];
    doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('done')) out.push(pos + node.text.indexOf('done'));
      return true;
    });
    return out;
  }

  test('the prefix carries the wiki link that tells the two apart', () => {
    const doc = schema.nodeFromJSON(mdManager.parse(MD));
    const target = occurrencesOfDone(doc)[1] as number;
    expect(captureSelectionContext(doc, target, target + 4).prefix).toContain('beta');
  });

  test('so the second occurrence resolves to itself, not the first', () => {
    const doc = schema.nodeFromJSON(mdManager.parse(MD));
    const hits = occurrencesOfDone(doc);
    expect(hits.length).toBe(2);
    const target = hits[1] as number;
    const context = captureSelectionContext(doc, target, target + 4);
    expect(createAnchorResolver(doc)('done', context)?.from).toBe(target);
  });
});

describe('findRangeInIndex — a stored quote carrying a boundary-whitespace char-ref', () => {
  const RENDERED = 'Intro line. External apps  [external action icon] follows.';
  const STORED = 'External apps &#x20;***[external action icon]';

  test('resolves the passage the reader can see, on the quote alone', () => {
    const range = findRangeInIndex(indexOf(RENDERED), STORED);
    expect(range).not.toBeNull();
    expect(RENDERED.slice((range?.from ?? 1) - 1, (range?.to ?? 1) - 1)).toBe(
      'External apps  [external action icon]',
    );
  });

  test('resolves it on the quote, not by recovering it from its brackets', () => {
    const range = findRangeInIndex(indexOf(RENDERED), STORED, {
      prefix: 'Intro line. ',
      suffix: ' follows.',
    });
    expect(range).not.toBeNull();
    expect(RENDERED.slice((range?.from ?? 1) - 1, (range?.to ?? 1) - 1)).toBe(
      'External apps  [external action icon]',
    );
  });

  test('does not let the ref drag the match across neighbouring words', () => {
    const rendered = 'alpha omega';
    expect(findRangeInIndex(indexOf(rendered), 'alpha &amp; omega')).toBeNull();
  });
});
