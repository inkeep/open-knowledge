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

const DOC_COUNT = 100;
const LINE_COUNT = 150;

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
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe('auditProject generation supersession', () => {
  test('abandons the walk when the generation moves mid-walk', async () => {
    let generation = '0 main';
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
