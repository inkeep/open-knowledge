import { describe, expect, test } from 'vitest';
import {
  filesPerDir,
  judgeDemotion,
  namesRetiredMechanism,
  pluginDirNames,
  readmeLine,
  scan,
} from './ok-rules-vocabulary.test-helper.mjs';

const CORPUS_DIRS = ['lint-plugins/ok-rules', 'packages/app/tests/lint-plugins'];

describe('ok-rules corpus vocabulary', () => {
  test('every corpus directory contributes at least one scanned file', () => {
    const missing = [...filesPerDir(CORPUS_DIRS)].filter(([, n]) => n === 0).map(([dir]) => dir);
    expect(missing).toEqual([]);
  });

  test('demotion detection survives an engine name and a spanning phrase', () => {
    const demotions = [
      'The no-hand-rolled-spinner plugin registers exactly 5 diagnostics.',
      'The GritQL era is over; the no-hand-rolled-spinner plugin registers exactly 5 diagnostics.',
      'The GritQL plugins were slow; the no-hand-rolled-spinner plugin fires on its fixture.',
      'The sibling plugin fires twice on that fixture.',
      'what the plugin test counts',
      "the oxlint path-conditional-origin plugin's enforcement target",
      'the ok/no-hand-rolled-spinner oxlint plugin fires on its fixture.',
      'the path-conditional-origin oxlint plugin fires on its fixture.',
    ];
    for (const line of demotions) expect(judgeDemotion(line), line).toBe(true);

    const legitimate = [
      readmeLine('One plugin holding every rule is deliberate'),
      'This rule ships as its own `.private.` plugin rather than inside the `ok` plugin.',
      "describe('no-comments oxlint plugin', () => {",
      ...pluginDirNames().map((name) => `the ${name} plugin fires on that fixture`),
      'the rehype clipboard cleanup plugins (eight strip-* plugins plus a skipper)',
    ];
    for (const line of legitimate) expect(judgeDemotion(line), line).toBe(false);
  });

  test('the stage order is load-bearing, not incidental', () => {
    for (const orderSensitive of [
      'the `ok` plugin test',
      'the ok/no-hand-rolled-spinner oxlint plugin fires on its fixture.',
    ]) {
      expect(judgeDemotion(orderSensitive), orderSensitive).toBe(true);
      expect(judgeDemotion(orderSensitive, { demotedFirst: false }), orderSensitive).toBe(false);
    }
  });

  test('no file names the retired GritQL or Bun mechanism as if it were current', () => {
    expect(scan(CORPUS_DIRS, namesRetiredMechanism)).toEqual([]);
  });

  test('no file calls an ok rule a plugin', () => {
    expect(scan(CORPUS_DIRS, (line) => judgeDemotion(line))).toEqual([]);
  });
});
