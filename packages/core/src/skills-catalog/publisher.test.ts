import { describe, expect, test } from 'vitest';
import { parseSkillsShPublisherPage } from './publisher.ts';

const OURS = 'inkeep/open-knowledge-skills';

/** Two listing rows in the page's real shape: anchor href, heading, count span. */
function row(owner: string, skill: string, installs: string): string {
  return (
    `<a class="group grid" href="/${owner}/${skill}">` +
    `<div class="min-w-0"><h3 class="font-semibold truncate">${skill.split('/').pop()}</h3></div>` +
    `<div class="text-right"><span class="font-mono text-sm text-foreground">${installs}</span></div>` +
    `</a>`
  );
}

describe('parseSkillsShPublisherPage', () => {
  test('ranks a publisher’s skills by installs, most first', () => {
    const html =
      row(OURS, 'knowledge-base', '21') +
      row(OURS, 'open-knowledge-discovery', '478') +
      row(OURS, 'note-taking', '3');

    const ranked = parseSkillsShPublisherPage(html, OURS);
    expect(ranked.map((r) => r.name)).toEqual([
      'open-knowledge-discovery',
      'knowledge-base',
      'note-taking',
    ]);
    expect(ranked[0]).toMatchObject({
      id: `${OURS}/open-knowledge-discovery`,
      source: OURS,
      installs: 478,
      publisher: 'inkeep',
      description: '',
    });
  });

  test('ignores rows belonging to another publisher', () => {
    // A "related skills" module or footer link must not smuggle a foreign skill
    // into a list the caller presents as one publisher's.
    const html = row(OURS, 'knowledge-base', '21') + row('acme/repo', 'their-skill', '999');
    expect(parseSkillsShPublisherPage(html, OURS).map((r) => r.name)).toEqual(['knowledge-base']);
  });

  test('drops our retired pack-prefixed listings', () => {
    const html =
      row(OURS, 'open-knowledge-pack-knowledge-base', '18') + row(OURS, 'knowledge-base', '21');
    expect(parseSkillsShPublisherPage(html, OURS).map((r) => r.name)).toEqual(['knowledge-base']);
  });

  test('reads a thousands-separated count', () => {
    expect(parseSkillsShPublisherPage(row(OURS, 'popular', '2,481'), OURS)[0]?.installs).toBe(2481);
  });

  test('a row with no count is skipped rather than borrowing the next row’s', () => {
    // The failure this guards: a permissive gap match let a countless row take
    // the following row's number, so every later skill reported its neighbor's
    // installs — plausible-looking and undetectable downstream.
    const html =
      `<a class="group grid" href="/${OURS}/countless"><h3>countless</h3></a>` +
      row(OURS, 'real', '42');
    expect(parseSkillsShPublisherPage(html, OURS)).toEqual([
      {
        id: `${OURS}/real`,
        name: 'real',
        source: OURS,
        description: '',
        installs: 42,
        publisher: 'inkeep',
      },
    ]);
  });

  test('returns [] on an unparseable page (caller degrades to an unranked list)', () => {
    expect(parseSkillsShPublisherPage('<html>no listing here</html>', OURS)).toEqual([]);
  });
});
