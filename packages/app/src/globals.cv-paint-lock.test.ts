/**
 * Source-level guards for the content-visibility paint-lock deferral contract.
 *
 * Blink hard-CHECKs — killing the whole renderer process — when a mouse
 * press's hit-tested node gains a paint-locked ancestor within one input
 * dispatch (`hit_test_result.cc`, `LockedAncestorPreventingPaint`; present at
 * Chromium HEAD). React discrete updates flush inside event dispatch, so any
 * class that applies `content-visibility: hidden` to hit-testable editor
 * content can land that lock mid-dispatch. The structural defense lives at
 * the class definition in `globals.css`: every `content-visibility: hidden`
 * declaration must be paired with
 *   (a) a `transition` on content-visibility with `allow-discrete` and a
 *       positive delay/duration — deferring lock formation to a rendering
 *       update (the document timeline is frozen within a script execution
 *       block, so a forced mid-dispatch recalc always computes the
 *       before-change `visible` value; scope: the deferral applies to
 *       class changes on EXISTING elements — an element inserted already
 *       carrying the class locks at first style recalc, which is
 *       click-safe only because a fresh node cannot be an ancestor of an
 *       earlier hit-tested one), and
 *   (b) `visibility: hidden` — making the subtree non-hit-testable before
 *       the lock can form (`pointer-events: none` is NOT sufficient: it does
 *       not invalidate a hit test captured earlier in the same dispatch).
 * Additionally, no `content-visibility: hidden` may appear under a
 * `.ProseMirror` scope at all — PM blocks are always live hit-test targets,
 * and the chunk-wrapper rule relies on cv:auto's native rendering-update
 * lock scheduling for its click-safety.
 *
 * These are source-level regex guards by necessity: the runtime behavior is
 * only exercisable below-the-DOM in a real Chromium layout/paint engine —
 * jsdom has no display-lock machinery (no style/layout engine, no rendering
 * updates, no hit-testing), so no Vitest-tier runtime test can observe lock
 * formation or its timing. The runtime rung that IS reachable is covered by
 * `tests/stress/cv-paint-lock-click.e2e.ts` at Playwright fidelity (real
 * Chromium, real mouse input); this file pins the CSS declarations that make
 * that test pass so they cannot be silently dropped or new unpaired locks
 * silently added.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const RAW_CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

/** Comments stripped so prose mentioning declarations can't affect matching. */
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

interface RuleBlock {
  selector: string;
  declarations: string;
}

/**
 * Leaf rule blocks (selector + declaration body without nested braces).
 * Declaration blocks are always leaves; at-rule wrappers (@media etc.) are
 * skipped as containers but their inner declaration blocks still match.
 */
function leafRuleBlocks(css: string): RuleBlock[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    declarations: m[2],
  }));
}

/** Split a transition shorthand value on top-level commas (parens-aware). */
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

/** `content-visibility: hidden` specifically (not `visible` / `auto`). */
const CV_HIDDEN = /content-visibility\s*:\s*hidden/;
/** Bare `visibility: hidden` — must not match inside `content-visibility`. */
const BARE_VISIBILITY_HIDDEN = /(?<![-\w])visibility\s*:\s*hidden/;
/** A positive CSS time token (rejects bare `0s` / `0ms` / `0.0s`). */
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
    // Scope both assertions to the single top-level-comma segment that
    // names content-visibility — matching the whole shorthand list lets a
    // DIFFERENT property's segment satisfy them (e.g. `opacity 200ms ease,
    // content-visibility 0s allow-discrete` has a positive time, but
    // content-visibility's combined duration is 0s: no transition is
    // created and the lock lands synchronously). Commas inside parens
    // (cubic-bezier args) are not segment boundaries.
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
    // The pairing tests above parse globals.css only, so a paint lock
    // minted anywhere else — a plain declaration in another bundled
    // stylesheet (cmd-f.css, color-themes.generated.css, ...), a
    // `[content-visibility:hidden]` Tailwind class, a
    // `contentVisibility: 'hidden'` style prop, an
    // `.contentVisibility = 'hidden'` assignment, or a
    // `setProperty('content-visibility', 'hidden')` call — would carry
    // none of the paired declarations. The lock must only ever be minted
    // through a globals.css rule the pairing tests see. TS/TSX patterns
    // are syntax-targeted (not bare `content-visibility: hidden`) so
    // prose comments mentioning the declaration don't false-fail.
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
        ? CV_HIDDEN.test(content.replace(/\/\*[\s\S]*?\*\//g, ''))
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
