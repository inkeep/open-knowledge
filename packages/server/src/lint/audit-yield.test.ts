/**
 * The audit walk must not hold the event loop, and a walk whose world (lint
 * configuration, or the branch whose content is on disk) changed underneath it
 * must not return a half-old-half-new plane.
 *
 * Both properties are observed through real event-loop behavior rather than
 * instrumentation: a `setInterval` that only ticks if the loop is serviced,
 * and a `setTimeout` that only fires if the walk yields before it finishes.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LINTER_CONFIG, type LinterConfig } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuditSupersededError, auditProject } from './audit.ts';

let root: string;

const base: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  plugins: {
    ...DEFAULT_LINTER_CONFIG.plugins,
    markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
  },
};

/**
 * Big enough that an unyielding walk visibly stalls the loop (measured at
 * ~300ms, ~30 missed ticks of a 10ms interval), small enough to stay a unit
 * test. Every line carries a hard tab so markdownlint has real work per doc.
 */
const DOC_COUNT = 100;
const LINE_COUNT = 150;

/** Fires early enough to land mid-walk, late enough that the walk has started. */
const MID_WALK_MS = 20;

function seedCorpus(): void {
  const lines = ['# Title', ''];
  for (let i = 0; i < LINE_COUNT; i += 1) {
    lines.push(`Paragraph ${i} with\ta hard tab and some filler text.`, '');
  }
  const text = lines.join('\n');
  for (let i = 0; i < DOC_COUNT; i += 1) {
    const dir = join(root, `folder-${i % 10}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `doc-${i}.md`), text, 'utf-8');
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-yield-')));
  seedCorpus();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('auditProject event-loop liveness', () => {
  test('a timer keeps ticking while the walk runs', async () => {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const result = await auditProject({ projectDir: root, contentDir: root, baseConfig: base });
      expect(result.fileCount).toBe(DOC_COUNT);
    } finally {
      clearInterval(interval);
    }
    // A synchronous walk services zero ticks over its whole duration. The
    // floor is far below the ~30 a 10ms interval would get across this
    // corpus, so a loaded machine cannot push it under.
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe('auditProject generation supersession', () => {
  // The walk compares the injected token for equality and nothing else, so
  // which half of it moved — lint config or branch — is invisible here. The
  // branch half is pinned end-to-end through the HTTP surface instead, in
  // `audit-branch-generation.test.ts`.
  test('abandons the walk when the generation moves mid-walk', async () => {
    let generation = '0 main';
    // A real timer, not a counting stub: it can only fire before the walk
    // finishes if the walk actually yields to the loop.
    const bump = setTimeout(() => {
      generation = '1 main';
    }, MID_WALK_MS);
    try {
      await expect(
        auditProject({
          projectDir: root,
          contentDir: root,
          baseConfig: base,
          auditGeneration: () => generation,
        }),
      ).rejects.toBeInstanceOf(AuditSupersededError);
    } finally {
      clearTimeout(bump);
    }
    expect(generation).toBe('1 main');
  });

  test('abandons a one-file walk when generation changes without a time-slice yield', async () => {
    let reads = 0;
    await expect(
      auditProject({
        projectDir: root,
        contentDir: root,
        baseConfig: base,
        targetPath: 'folder-0/doc-0.md',
        auditGeneration: () => (reads++ === 0 ? '0 main 1' : '0 main 2'),
      }),
    ).rejects.toBeInstanceOf(AuditSupersededError);
    expect(reads).toBe(2);
  });

  test('completes normally when the generation holds', async () => {
    const result = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      auditGeneration: () => '7 main',
    });
    expect(result.fileCount).toBe(DOC_COUNT);
    expect(result.warningCount).toBeGreaterThan(0);
  });
});
