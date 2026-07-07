import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectLocalSemanticConfig } from './semantic-config.ts';

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-semcfg-'));
  mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
  return dir;
}

describe('readProjectLocalSemanticConfig', () => {
  test('reads enabled + provider from the project-local layer', () => {
    const dir = makeProject();
    try {
      writeFileSync(
        join(dir, '.ok', 'local', 'config.yml'),
        'search:\n  semantic:\n    enabled: true\n    model: text-embedding-3-large\n',
      );
      const cfg = readProjectLocalSemanticConfig(dir);
      expect(cfg.enabled).toBe(true);
      expect(cfg.model).toBe('text-embedding-3-large');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // This is the bug `ok embeddings status` had: it read a user+project merge, so
  // a committed `enabled: true` reported the feature ON even though the server
  // (project-local only) ran it OFF. Both now share THIS resolver.
  test('IGNORES a committed project config — project-local only (egress safety)', () => {
    const dir = makeProject();
    try {
      writeFileSync(join(dir, '.ok', 'config.yml'), 'search:\n  semantic:\n    enabled: true\n');
      expect(readProjectLocalSemanticConfig(dir).enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent config → disabled with provider defaults', () => {
    const dir = makeProject();
    try {
      const cfg = readProjectLocalSemanticConfig(dir);
      expect(cfg.enabled).toBe(false);
      expect(cfg.baseUrl).toContain('openai');
      expect(typeof cfg.model).toBe('string');
      expect(cfg.dimensions).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
