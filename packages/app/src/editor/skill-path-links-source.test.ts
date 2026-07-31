import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { GFM } from '@lezer/markdown';
import { describe, expect, test } from 'vitest';
import { buildSkillPathDecorations } from './skill-path-links-source';

function collect(doc: string): Array<{ text: string; path: string | undefined }> {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
  const set = buildSkillPathDecorations(state, [{ from: 0, to: state.doc.length }]);
  const out: Array<{ text: string; path: string | undefined }> = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      text: state.doc.sliceString(cursor.from, cursor.to),
      path: (cursor.value.spec as { attributes?: Record<string, string> }).attributes?.[
        'data-skill-path'
      ],
    });
    cursor.next();
  }
  return out;
}

describe('buildSkillPathDecorations', () => {
  test('decorates the inner text of a whole-span bundle path, backticks excluded', () => {
    expect(collect('Load `references/epistemics.md` first.')).toEqual([
      { text: 'references/epistemics.md', path: 'references/epistemics.md' },
    ]);
  });

  test('normalizes ./ and handles scripts + nesting', () => {
    expect(collect('Run `./scripts/deep/run.py`.')).toEqual([
      { text: './scripts/deep/run.py', path: 'scripts/deep/run.py' },
    ]);
  });

  test('a WHOLE-SPAN code ref like `/research` decorates as a skill reference', () => {
    const state = EditorState.create({
      doc: 'use `/research` instead.',
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
    });
    const set = buildSkillPathDecorations(
      state,
      [{ from: 0, to: state.doc.length }],
      new Set(['research']),
    );
    const out: string[] = [];
    const cursor = set.iter();
    while (cursor.value) {
      out.push(
        (cursor.value.spec as { attributes?: Record<string, string> }).attributes?.[
          'data-skill-ref'
        ] ?? '',
      );
      cursor.next();
    }
    expect(out).toEqual(['research']);
  });

  test('stays inert for prose mentions, non-bundle paths, and plain code', () => {
    expect(collect('see `use references/x.md maybe`')).toEqual([]);
    expect(collect('`assets/logo.png` and `--check-deps` and `npm run x`')).toEqual([]);
    expect(collect('references/loose.md outside code')).toEqual([]);
  });
});
