import {
  getWikiLinkText,
  resolveSkillBundleWikiTarget,
  resolveWikiLinkTargetDocName,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { applyRenameMap } from './apply-managed-rename.ts';
import { matchWikiLinks } from './link-syntax.ts';
import { createWikiRenameContext, rewriteWikiLinksForRenameMap } from './managed-rename-rewrite.ts';

function rewrite(content: string, pages: string[], renames: [string, string][], source = 'source') {
  const context = createWikiRenameContext(pages, new Map(renames));
  const result = applyRenameMap(content, source, context);
  const beforeLinks = content.split('\n').flatMap(matchWikiLinks);
  const afterLinks = result.markdown.split('\n').flatMap(matchWikiLinks);
  expect(afterLinks).toHaveLength(beforeLinks.length);
  for (const [i, before] of beforeLinks.entries()) {
    const original = resolveWikiLinkTargetDocName(
      resolveSkillBundleWikiTarget(before.target, source) ?? before.target,
      context.before,
    );
    const after = afterLinks[i];
    expect(getWikiLinkText(after)).toBe(getWikiLinkText(before));
    expect(after.anchor).toBe(before.anchor);
    if (original !== undefined) {
      expect(
        resolveWikiLinkTargetDocName(
          resolveSkillBundleWikiTarget(after.target, context.renames.get(source) ?? source) ??
            after.target,
          context.after,
        ),
      ).toBe(context.renames.get(original) ?? original);
    }
  }
  return result;
}

describe('managed rename preserves resolved wiki identity', () => {
  test('preserves the same slug-collision winner for reversed inventories', () => {
    for (const pages of [
      ['source', 'a/b', 'a-b'],
      ['a-b', 'a/b', 'source'],
    ]) {
      expect(rewrite('[[A B]]', pages, [['a-b', 'archive/winner']])).toEqual({
        markdown: '[[archive/winner|A B]]',
        rewrites: 1,
      });
    }
  });

  test('qualifies a moved target when its old basename would resolve to another document', () => {
    expect(
      rewrite(
        '[[beta]]',
        ['source', 'notes/beta', 'zzz/beta'],
        [['notes/beta', 'archive/beta-old']],
      ),
    ).toEqual({ markdown: '[[archive/beta-old|beta]]', rewrites: 1 });
  });

  test('qualifies an unmoved target when a new path would steal its basename winner', () => {
    expect(
      rewrite('[[beta]]', ['source', 'm/beta', 'notes/beta'], [['notes/beta', 'archive/beta']]),
    ).toEqual({ markdown: '[[m/beta|beta]]', rewrites: 1 });
  });

  test('keeps bytes for basename-preserving moves and unaffected documents', () => {
    const body = '  [[ beta # intro | Alias ]]\r\n[[BETA.mdx]]\r\n[[unresolved]]';
    expect(rewrite(body, ['source', 'notes/beta'], [['notes/beta', 'archive/beta']])).toEqual({
      markdown: body,
      rewrites: 0,
    });
    expect(
      rewrite('No links\n', ['source', 'notes/beta'], [['notes/beta', 'archive/beta']]),
    ).toEqual({ markdown: 'No links\n', rewrites: 0 });
  });

  test('preserves alias and heading bytes and adds a display alias only when absent', () => {
    expect(
      rewrite(
        '[[BETA# Intro | Display ]] [[beta#install]]',
        ['source', 'notes/beta'],
        [['notes/beta', 'archive/new']],
      ),
    ).toEqual({
      markdown: '[[archive/new# Intro | Display ]] [[archive/new#install|beta#install]]',
      rewrites: 2,
    });
  });

  test('keeps a Markdown suffix only when the emitted spelling resolves to the intended identity', () => {
    expect(
      rewrite(
        '[[notes/beta.md]]',
        ['source', 'notes/beta', 'archive/beta.md'],
        [['notes/beta', 'archive/beta']],
      ),
    ).toEqual({ markdown: '[[archive/beta|notes/beta.md]]', rewrites: 1 });
    expect(
      rewrite('[[notes/beta.mdx|Beta]]', ['source', 'notes/beta'], [['notes/beta', 'archive/new']]),
    ).toEqual({ markdown: '[[archive/new.mdx|Beta]]', rewrites: 1 });
  });

  test('uses complete pre/post batch snapshots through swaps and moved sources', () => {
    expect(
      rewrite(
        '[[a]] [[b]] [a](/notes/a.md) [b](/notes/b.md)',
        ['source', 'notes/a', 'notes/b'],
        [
          ['notes/a', 'notes/b'],
          ['notes/b', 'notes/a'],
        ],
      ),
    ).toEqual({
      markdown: '[[notes/b|a]] [[notes/a|b]] [a](/notes/b.md) [b](/notes/a.md)',
      rewrites: 4,
    });
    expect(
      rewrite(
        '[[beta]] [Beta](./beta.md)',
        ['notes/source', 'notes/beta'],
        [
          ['notes/source', 'archive/source'],
          ['notes/beta', 'archive/beta'],
        ],
        'notes/source',
      ),
    ).toEqual({ markdown: '[[beta]] [Beta](beta.md)', rewrites: 2 });
  });

  test('ordinary fuzzy links ignore global skills while explicit and project skill targets stay supported', () => {
    const global = skillLiveDocName('global', 'demo');
    const reference = `${global}/references/beta`;
    expect(
      rewrite('[[beta]]', ['source', reference, 'notes/beta'], [['notes/beta', 'archive/new']])
        .markdown,
    ).toBe('[[archive/new|beta]]');
    expect(
      rewrite(`[[${global}]]`, ['source', global, 'notes/beta'], [['notes/beta', 'archive/new']])
        .rewrites,
    ).toBe(0);
    const skill = '.agents/skills/demo/references/beta';
    expect(
      rewrite('[[beta]]', ['source', skill], [[skill, '.agents/skills/renamed/references/new']])
        .markdown,
    ).toBe('[[.agents/skills/renamed/references/new|beta]]');
  });

  test.each(['SKILL', 'references/nested/guide'])(
    'rewrites a bundle-relative internal target from %s',
    (sourcePath) => {
      const bundle = '.agents/skills/demo';
      const source = `${bundle}/${sourcePath}`;
      const target = `${bundle}/references/beta`;
      expect(
        rewrite(
          '[[references/beta.md#intro| Beta ]]',
          [source, target, '.agents/skills/other/references/beta'],
          [[target, `${bundle}/references/renamed`]],
          source,
        ),
      ).toEqual({
        markdown: '[[.agents/skills/demo/references/renamed.md#intro| Beta ]]',
        rewrites: 1,
      });
    },
  );

  test('moving an entire bundle preserves relative wiki bytes from the skill and nested references', () => {
    const bundle = '.agents/skills/demo';
    const pages = [
      `${bundle}/SKILL`,
      `${bundle}/references/nested/guide`,
      `${bundle}/references/beta`,
    ];
    const renames: [string, string][] = pages.map((page) => [
      page,
      page.replace('/demo/', '/renamed/'),
    ]);
    const body = '  [[ references/beta.md# intro | Beta ]]\r\n[[references/beta]]\r\n';
    for (const source of pages.slice(0, 2)) {
      expect(rewrite(body, pages, renames, source)).toEqual({ markdown: body, rewrites: 0 });
    }
  });

  test('fenced code, inline code and escaped links stay byte identical', () => {
    const content = '```md\n[[beta]]\n```\n`[[beta]]` \\[[beta]]';
    const context = createWikiRenameContext(
      ['source', 'notes/beta'],
      new Map([['notes/beta', 'archive/new']]),
    );
    expect(rewriteWikiLinksForRenameMap(content, 'source', context)).toEqual({
      markdown: content,
      rewrites: 0,
    });
  });
});
