import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { assertProjectContentSubtree } from './project-content-scope.ts';

test('recursive operations refuse a descendant project without relying on a file index', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-scope-subtree-'));
  try {
    mkdirSync(join(root, 'public', 'knowledge', '.ok'), { recursive: true });
    writeFileSync(join(root, 'public', 'knowledge', '.ok', 'config.yml'), '');
    expect(() => assertProjectContentSubtree(join(root, 'public'), root)).toThrow(
      /nested project/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recursive operations allow folder metadata and do not follow directory links', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-scope-subtree-'));
  try {
    mkdirSync(join(root, 'notes', '.ok'), { recursive: true });
    writeFileSync(join(root, 'notes', '.ok', 'frontmatter.yml'), 'icon: note\n');
    mkdirSync(join(root, 'child', '.ok'), { recursive: true });
    writeFileSync(join(root, 'child', '.ok', 'config.yml'), '');
    symlinkSync(join(root, 'child'), join(root, 'notes', 'alias'), 'junction');
    expect(() => assertProjectContentSubtree(join(root, 'notes'), root)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
