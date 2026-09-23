import type { Editor } from '@tiptap/core';
import { describe, expect, test, vi } from 'vitest';

const LONG =
  'Use when triaging an Open Knowledge ticket in Linear, whatever its shape or origin. ' +
  'Owns every kind of ticket: defect, feature request, question, sentiment.';

const SHORT_FIRST =
  'Answer questions about the AI SDK. ' +
  'Then help build AI-powered features across the whole application surface and beyond.';

const ABBREVIATED =
  'Use the CLI (e.g. ok start) before anything else. Then open the editor and begin.';

const STRADDLING =
  'Use when triaging a ticket in Linear that arrives as a linear.app/inkeep/issue/PRD-8017 URL. ' +
  'More follows.';

const TRAILING_COMMA =
  'Produce an ambitious, verification-grounded, deeply-considered plan for reviewers, ' +
  'then stop. More follows.';

const HUGE_TOKEN = `Read ${'x'.repeat(140)} then stop. More follows.`;

const SINGLE_LETTER =
  'First do A. Then do the rest of the work described further down in this paragraph.';

const UNBROKEN =
  'Read when the user asks what OpenKnowledge is and wants to install it on a repository ' +
  'they already have checked out somewhere on disk';

const skills = new Map<string, { scope: 'project'; path: string; description?: string }>([
  ['bug-triage', { scope: 'project', path: 'a/SKILL.md', description: 'Triage a ticket.' }],
  ['no-blurb', { scope: 'project', path: 'b/SKILL.md' }],
  ['wordy', { scope: 'project', path: 'c/SKILL.md', description: LONG }],
  ['short-first', { scope: 'project', path: 'd/SKILL.md', description: SHORT_FIRST }],
  ['abbreviated', { scope: 'project', path: 'e/SKILL.md', description: ABBREVIATED }],
  ['unbroken', { scope: 'project', path: 'f/SKILL.md', description: UNBROKEN }],
  ['straddling', { scope: 'project', path: 'g/SKILL.md', description: STRADDLING }],
  ['trailing-comma', { scope: 'project', path: 'j/SKILL.md', description: TRAILING_COMMA }],
  ['huge-token', { scope: 'project', path: 'h/SKILL.md', description: HUGE_TOKEN }],
  ['single-letter', { scope: 'project', path: 'i/SKILL.md', description: SINGLE_LETTER }],
]);

vi.mock('@/lib/skill-name-set', () => ({ getSkillNamesForScope: () => skills }));

const { getSkillReferenceItems } = await import('./skill-reference-items');

const editor = {
  extensionManager: {
    extensions: [
      { name: 'skillPathLinks', options: { docName: '.agents/skills/bug-triage/SKILL' } },
    ],
  },
} as unknown as Editor;

describe('getSkillReferenceItems', () => {
  const blurbOf = (label: string) =>
    getSkillReferenceItems({ editor }).find((i) => i.label === label)?.description;

  test("carries each skill's own description, and leaves it off when there is none", () => {
    const items = getSkillReferenceItems({ editor });

    expect(items.map((i) => i.label)).toEqual([
      'abbreviated',
      'bug-triage',
      'huge-token',
      'no-blurb',
      'short-first',
      'single-letter',
      'straddling',
      'trailing-comma',
      'unbroken',
      'wordy',
    ]);
    expect(blurbOf('bug-triage')).toBe('Triage a ticket.');
    expect(blurbOf('no-blurb')).toBeUndefined();
  });

  test('a short opening sentence is kept whole, not capped at the raw character count', () => {
    expect(blurbOf('short-first')).toBe('Answer questions about the AI SDK…');
  });

  test('an abbreviation period does not end the sentence', () => {
    expect(blurbOf('abbreviated')).toBe('Use the CLI (e.g. ok start) before anything else…');
  });

  test('a sentence with no terminator is cut on a word boundary', () => {
    const cut = blurbOf('unbroken');

    const core = cut?.slice(0, -1) ?? '';

    expect(cut?.endsWith('…')).toBe(true);
    expect(UNBROKEN.startsWith(core)).toBe(true);
    expect(UNBROKEN.charAt(core.length)).toBe(' ');
  });

  test('a token straddling the cap is kept whole rather than dropped', () => {
    expect(blurbOf('straddling')).toBe(
      'Use when triaging a ticket in Linear that arrives as a linear.app/inkeep/issue/PRD-8017…',
    );
  });

  test('a cut landing on punctuation does not keep the dangling mark', () => {
    expect(blurbOf('trailing-comma')).toBe(
      'Produce an ambitious, verification-grounded, deeply-considered plan for reviewers…',
    );
  });

  test('a token too long to keep whole is cut at the cap rather than discarded', () => {
    expect(blurbOf('huge-token')).toBe(`Read ${'x'.repeat(75)}…`);
  });

  test('a standalone capital does not read as an abbreviation', () => {
    expect(blurbOf('single-letter')).toBe('First do A…');
  });

  test('a routing paragraph is cut to its first sentence and capped', () => {
    const wordy = getSkillReferenceItems({ editor }).find((i) => i.label === 'wordy');

    expect(wordy?.description?.length).toBeLessThanOrEqual(105);
    expect(wordy?.description).not.toContain('Owns every kind of ticket');
    expect(wordy?.description?.startsWith('Use when triaging an Open Knowledge ticket')).toBe(true);
  });

  test('a doc that is not a skill bundle offers no skill references', () => {
    const plain = {
      extensionManager: {
        extensions: [{ name: 'skillPathLinks', options: { docName: 'notes/today' } }],
      },
    } as unknown as Editor;

    expect(getSkillReferenceItems({ editor: plain })).toEqual([]);
  });
});
