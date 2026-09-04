import { describe, expect, test } from 'vitest';
import {
  ALWAYS_ON_TOKEN_BUDGET,
  estimateSkillCost,
  ON_TRIGGER_TOKEN_BUDGET,
  READABLE_SKILL_EXTENSIONS,
  type SkillCostInput,
} from './skill-cost.ts';

function skillMd(bodyLen: number): string {
  return `---\nname: x\n---\n${'b'.repeat(bodyLen)}`;
}

const emptyInput: SkillCostInput = { name: '', description: '', skillMd: '', files: [] };

describe('estimateSkillCost', () => {
  test('reports each tier as chars/4 and never a summed total', () => {
    const cost = estimateSkillCost({
      name: 'x'.repeat(8),
      description: 'y'.repeat(8),
      skillMd: skillMd(20),
      files: [{ relPath: 'references/a.md', content: 'c'.repeat(12) }],
    });
    expect(cost).toEqual({ alwaysOn: 4, onTrigger: 5, onDemand: 3 });
    expect(Object.keys(cost).sort()).toEqual(['alwaysOn', 'onDemand', 'onTrigger']);
  });

  test('always-on counts name plus description, rounded to nearest token', () => {
    expect(estimateSkillCost({ ...emptyInput, name: 'a'.repeat(9) }).alwaysOn).toBe(2);
    expect(estimateSkillCost({ ...emptyInput, name: 'a'.repeat(11) }).alwaysOn).toBe(3);
    expect(estimateSkillCost({ ...emptyInput, name: 'ab', description: 'cd' }).alwaysOn).toBe(1);
  });

  test('on-trigger counts only the body after frontmatter, not the frontmatter', () => {
    const md = `---\nname: n\ndescription: ${'d'.repeat(400)}\n---\nshort body`;
    expect(estimateSkillCost({ ...emptyInput, skillMd: md }).onTrigger).toBe(
      Math.round('short body'.length / 4),
    );
  });

  test('on-demand counts .md/.mdx/.txt anywhere in the bundle', () => {
    const cost = estimateSkillCost({
      ...emptyInput,
      files: [
        { relPath: 'references/a.md', content: 'a'.repeat(4) },
        { relPath: 'deep/nested/b.mdx', content: 'b'.repeat(4) },
        { relPath: 'notes.txt', content: 'c'.repeat(4) },
      ],
    });
    expect(cost.onDemand).toBe(3);
  });

  test('excludes scripts, overlay.yaml and evals JSON from on-demand', () => {
    const cost = estimateSkillCost({
      ...emptyInput,
      files: [
        { relPath: 'references/keep.md', content: 'k'.repeat(8) },
        { relPath: 'assets/keep.template.md', content: 'k'.repeat(8) },
        { relPath: 'scripts/run.sh', content: 'x'.repeat(1000) },
        { relPath: 'overlay.yaml', content: 'x'.repeat(1000) },
        { relPath: 'evals/evals.json', content: 'x'.repeat(1000) },
        { relPath: 'assets/data.template.json', content: 'x'.repeat(1000) },
      ],
    });
    expect(cost.onDemand).toBe(4);
  });

  test('excludes SKILL.md itself from on-demand even when passed among the files', () => {
    const cost = estimateSkillCost({
      ...emptyInput,
      files: [
        { relPath: 'SKILL.md', content: 'x'.repeat(1000) },
        { relPath: 'references/a.md', content: 'a'.repeat(8) },
      ],
    });
    expect(cost.onDemand).toBe(2);
  });

  test('skips a binary/unreadable file and still counts the readable remainder', () => {
    const cost = estimateSkillCost({
      ...emptyInput,
      files: [
        { relPath: 'references/binary.md', content: null },
        { relPath: 'references/text.md', content: 'a'.repeat(12) },
      ],
    });
    expect(cost.onDemand).toBe(3);
  });

  test('degrades missing frontmatter/description/body/files to zeroes, never NaN', () => {
    const cost = estimateSkillCost(emptyInput);
    expect(cost).toEqual({ alwaysOn: 0, onTrigger: 0, onDemand: 0 });

    const nullish = estimateSkillCost({ name: null, description: null, skillMd: '', files: [] });
    expect(nullish).toEqual({ alwaysOn: 0, onTrigger: 0, onDemand: 0 });

    expect(estimateSkillCost({ ...emptyInput, name: 'abcd' }).alwaysOn).toBe(1);
  });

  test('an overlay-vendored upstream/ mirror is excluded from on-demand', () => {
    const files = [
      { relPath: 'references/a.md', content: 'a'.repeat(400) },
      { relPath: 'upstream/SKILL.md', content: 'b'.repeat(400) },
      { relPath: 'upstream/references/a.md', content: 'c'.repeat(400) },
    ];
    const vendored = estimateSkillCost({
      ...emptyInput,
      files: [...files, { relPath: 'overlay.yaml', content: 'x: 1' }],
    });
    expect(vendored.onDemand).toBe(100);
    const plain = estimateSkillCost({ ...emptyInput, files });
    expect(plain.onDemand).toBe(300);
  });

  test('exports the readable-extension set and the published budget constants', () => {
    expect(READABLE_SKILL_EXTENSIONS).toEqual(['.md', '.mdx', '.txt']);
    expect(ALWAYS_ON_TOKEN_BUDGET).toBe(100);
    expect(ON_TRIGGER_TOKEN_BUDGET).toBe(5000);
  });
});
