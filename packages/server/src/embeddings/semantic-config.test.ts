import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
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
        'search:\n  semantic:\n    enabled: true\n    model: text-embedding-3-large\n    maxBatchSize: 2\n    maxBatchChars: 16000\n    docTimeoutMs: 120000\n',
      );
      const cfg = readProjectLocalSemanticConfig(dir);
      expect(cfg.enabled).toBe(true);
      expect(cfg.model).toBe('text-embedding-3-large');
      expect(cfg.maxBatchSize).toBe(2);
      expect(cfg.maxBatchChars).toBe(16_000);
      expect(cfg.docTimeoutMs).toBe(120_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('IGNORES a committed project config — project-local only (egress safety)', () => {
    const dir = makeProject();
    try {
      writeFileSync(
        join(dir, '.ok', 'config.yml'),
        'search:\n  semantic:\n    enabled: true\n    maxBatchSize: 2\n    maxBatchChars: 16000\n    docTimeoutMs: 120000\n',
      );
      expect(readProjectLocalSemanticConfig(dir)).toMatchObject({
        enabled: false,
        maxBatchSize: 96,
        maxBatchChars: 96_000,
        docTimeoutMs: 30_000,
      });
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
      expect(cfg.maxBatchSize).toBe(96);
      expect(cfg.maxBatchChars).toBe(96_000);
      expect(cfg.docTimeoutMs).toBe(30_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
