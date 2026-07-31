import { describe, expect, test } from 'vitest';
import { extractSkillRefs, rewriteSkillRefs } from './skills.ts';

describe('rewriteSkillRefs', () => {
  test('rewrites both forms the extractor reads', () => {
    const body = 'Load /grill-me first.\nInline: `/grill-me`.\n(/grill-me) and [/grill-me]\n';
    expect(rewriteSkillRefs(body, 'grill-me', 'grilling')).toBe(
      'Load /grilling first.\nInline: `/grilling`.\n(/grilling) and [/grilling]\n',
    );
  });

  // The contract: rewrite exactly what draws an edge. Anything `extractSkillRefs`
  // ignores must survive a rename untouched, or a rename starts corrupting prose
  // and file paths that merely look like refs.
  test('leaves alone every occurrence that draws no edge', () => {
    const inert = [
      'A path /grill-me/steps.md keeps going.',
      'No boundary before x/grill-me.',
      'Hyphen run /grill-me-2 is a different slug.',
    ];
    for (const body of inert) {
      expect(extractSkillRefs(body)).not.toContain('grill-me');
      expect(rewriteSkillRefs(body, 'grill-me', 'grilling')).toBe(body);
    }
  });

  test('rewrites only the named skill, not its neighbours', () => {
    const body = 'Use /alpha then /beta then /alphabet.\n';
    expect(rewriteSkillRefs(body, 'alpha', 'omega')).toBe(
      'Use /omega then /beta then /alphabet.\n',
    );
  });

  test('handles adjacent refs and repeats', () => {
    expect(rewriteSkillRefs('/ab /ab (/ab) `/ab`', 'ab', 'cd')).toBe('/cd /cd (/cd) `/cd`');
    // A single character is below the grammar's minimum, so it is not a ref.
    expect(rewriteSkillRefs('/a /a', 'a', 'b')).toBe('/a /a');
  });

  test('no-ops when the name is unchanged, stop-listed, or absent', () => {
    expect(rewriteSkillRefs('Load /grill-me.', 'grill-me', 'grill-me')).toBe('Load /grill-me.');
    expect(rewriteSkillRefs('Files under /tmp.', 'tmp', 'temp')).toBe('Files under /tmp.');
    expect(rewriteSkillRefs('Nothing here.', 'grill-me', 'grilling')).toBe('Nothing here.');
  });

  test('a rewritten body extracts the new name and no longer the old', () => {
    const out = rewriteSkillRefs('See /grill-me and `/grill-me`.', 'grill-me', 'grilling');
    expect(extractSkillRefs(out)).toEqual(['grilling']);
  });
});
