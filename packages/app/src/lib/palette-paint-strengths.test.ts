import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALLOUT_WASH_TINT,
  DIFF_DELETION_OPACITY,
  DIFF_DELETION_TINT,
  EDITOR_FIND_ACTIVE_TINT,
  EDITOR_FIND_TINT,
  VIEWER_FIND_ACTIVE_TINT,
  VIEWER_FIND_TINT,
} from '@inkeep/open-knowledge-core/theme/base16';
import { assert, describe, expect, test } from 'vitest';
import { findBlockBodies } from '../../../core/scripts/chrome-resolver.ts';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../globals.css'),
  'utf8',
);

function ruleBody(selector: string): string {
  const bodies = findBlockBodies(css, selector);
  expect(bodies, `${selector} rules in globals.css`).toHaveLength(1);
  return bodies[0];
}

function declared(body: string, pattern: RegExp): number {
  const match = pattern.exec(body);
  assert(match, `Expected ${pattern} in the rule`);
  return Number(match[1]);
}

describe('paint strengths the palette derivation assumes', () => {
  test.each([
    ['.ProseMirror .ok-find-match', 'ok-find-match', EDITOR_FIND_TINT],
    ['.ProseMirror .ok-find-match-active', 'ok-find-match-active', EDITOR_FIND_ACTIVE_TINT],
    ['::highlight(ok-find)', 'ok-viewer-find-match', VIEWER_FIND_TINT],
    ['::highlight(ok-find-active)', 'ok-viewer-find-match', VIEWER_FIND_ACTIVE_TINT],
    ['.ProseMirror .ok-diff-del', 'ok-diff-del', DIFF_DELETION_TINT],
    ['.callout', 'callout-type-color', CALLOUT_WASH_TINT],
  ] as const)('%s mixes --%s at the derived strength', (selector, token, strength) => {
    const percent = declared(
      ruleBody(selector),
      new RegExp(`var\\(--${token}\\) (\\d+(?:\\.\\d+)?)%`),
    );
    expect(percent / 100).toBe(strength);
  });

  test('.ProseMirror .ok-diff-del fades at the derived opacity', () => {
    expect(declared(ruleBody('.ProseMirror .ok-diff-del'), /opacity: ([\d.]+);/)).toBe(
      DIFF_DELETION_OPACITY,
    );
  });
});
