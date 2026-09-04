import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { blankComments, readGlobalsCssWithoutComments } from './globals-css.test-helper';

const CSS = readGlobalsCssWithoutComments();

interface RuleBlock {
  selector: string;
  declarations: string;
}

function leafRuleBlocks(css: string): RuleBlock[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    declarations: m[2],
  }));
}

function splitTopLevelCommas(value: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

const CV_HIDDEN = /content-visibility\s*:\s*hidden/;
const BARE_VISIBILITY_HIDDEN = /(?<![-\w])visibility\s*:\s*hidden/;
const POSITIVE_TIME = /(?:0*[1-9]\d*(?:\.\d+)?|0*\.0*[1-9]\d*)(?:ms|s)\b/;

const blocks = leafRuleBlocks(CSS);
const cvHiddenBlocks = blocks.filter((b) => CV_HIDDEN.test(b.declarations));

describe('globals.css content-visibility paint-lock deferral contract', () => {
  test('at least one content-visibility: hidden rule exists (guard is not vacuous)', () => {
    expect(cvHiddenBlocks.length).toBeGreaterThanOrEqual(1);
  });

  test('.ok-mode-hidden keeps content-visibility: hidden (steady-state perf lock is intentional)', () => {
    const modeHidden = blocks.find((b) => b.selector === '.ok-mode-hidden');
    expect(modeHidden, '.ok-mode-hidden rule block must exist').toBeDefined();
    expect(modeHidden?.declarations).toMatch(CV_HIDDEN);
  });

  test.each(
    cvHiddenBlocks.map((b) => [b.selector, b] as const),
  )('rule %j defers its paint lock via an allow-discrete transition with a positive delay/duration', (_selector, block) => {
    const transitions = [...block.declarations.matchAll(/transition[^:;]*:\s*([^;]*)/g)].map(
      (m) => m[1],
    );
    const cvSegment = transitions
      .flatMap((value) => splitTopLevelCommas(value))
      .find((segment) => /content-visibility/.test(segment));
    expect(
      cvSegment,
      'a content-visibility: hidden rule must declare a transition segment on content-visibility (defers lock formation to a rendering update)',
    ).toBeDefined();
    expect(
      cvSegment,
      'the content-visibility transition segment must use allow-discrete (discrete properties do not transition otherwise)',
    ).toMatch(/allow-discrete/);
    expect(
      cvSegment,
      'the content-visibility transition segment needs a positive delay or duration — with a combined duration of 0s no transition is created at all (CSS Transitions: starting requires combined duration > 0s), so the lock would form synchronously in the same style recalc',
    ).toMatch(POSITIVE_TIME);
  });

  test.each(
    cvHiddenBlocks.map((b) => [b.selector, b] as const),
  )('rule %j pairs the paint lock with visibility: hidden (non-hit-testable during the deferral window)', (_selector, block) => {
    expect(block.declarations).toMatch(BARE_VISIBILITY_HIDDEN);
  });

  test('no content-visibility: hidden under a .ProseMirror scope (PM blocks are live hit-test targets)', () => {
    const offenders = cvHiddenBlocks.filter((b) => b.selector.includes('.ProseMirror'));
    expect(offenders.map((b) => b.selector)).toEqual([]);
  });

  test('no cv:hidden outside globals.css (other stylesheets, Tailwind arbitrary properties, or JS style writes would bypass the paired-declaration guard)', () => {
    const TAILWIND_CV_HIDDEN = /\[\s*content-visibility\s*:\s*hidden\s*\]/;
    const STYLE_PROP_CV_HIDDEN = /contentVisibility\s*[:=]\s*['"`]\s*hidden\s*['"`]/;
    const SET_PROPERTY_CV_HIDDEN =
      /setProperty\(\s*['"`]content-visibility['"`]\s*,\s*['"`]\s*hidden\s*['"`]/;
    const srcRoot = __dirname;
    const offenders: string[] = [];
    for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|tsx|css)$/.test(entry.name)) continue;
      const filePath = join(entry.parentPath, entry.name);
      const relPath = filePath.slice(srcRoot.length + 1);
      if (relPath === 'globals.css' || relPath === 'globals.cv-paint-lock.test.ts') continue;
      const content = readFileSync(filePath, 'utf8');
      const isCss = entry.name.endsWith('.css');
      const hit = isCss
        ? CV_HIDDEN.test(blankComments(content))
        : TAILWIND_CV_HIDDEN.test(content) ||
          STYLE_PROP_CV_HIDDEN.test(content) ||
          SET_PROPERTY_CV_HIDDEN.test(content);
      if (hit) {
        offenders.push(relPath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
