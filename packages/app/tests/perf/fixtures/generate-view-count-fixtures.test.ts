import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MarkdownManager, OK_DIR, sharedExtensions } from '@inkeep/open-knowledge-core';
import { generateFixture } from './generate-view-count-fixtures';

interface PmJson {
  type?: string;
  marks?: { type: string }[];
  content?: PmJson[];
}

function countViewsInPmJson(node: PmJson): number {
  let count = 0;
  if (node.type === 'wikiLink') count += 1;
  if (node.marks?.some((m) => m.type === 'link')) count += 1;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      count += countViewsInPmJson(child as PmJson);
    }
  }
  return count;
}

function countMarkType(node: PmJson, markType: string): number {
  let count = 0;
  if (node.marks?.some((m) => m.type === markType)) count += 1;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      count += countMarkType(child as PmJson, markType);
    }
  }
  return count;
}

function countNodeType(node: PmJson, type: string): number {
  let count = 0;
  if (node.type === type) count += 1;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      count += countNodeType(child as PmJson, type);
    }
  }
  return count;
}

describe('generateFixture — convergence', () => {
  test('produces fixture with measured count within ±5% of target across the canonical buckets', () => {
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    const tmp = mkdtempSync(resolve(tmpdir(), 'gen-fixtures-'));
    try {
      for (const target of [25, 50, 100, 200, 400]) {
        const outDir = resolve(tmp, `views-${target}`);
        const result = generateFixture(target, outDir);
        const md = readFileSync(resolve(outDir, 'FIXTURE.md'), 'utf8');
        const pm = mgr.parse(md) as unknown as PmJson;
        const measured = countViewsInPmJson(pm);
        const minOk = Math.floor(target * 0.95);
        const maxOk = Math.ceil(target * 1.05);
        expect(measured).toBeGreaterThanOrEqual(minOk);
        expect(measured).toBeLessThanOrEqual(maxOk);
        expect(result.iterations).toBeGreaterThan(0);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('writes both FIXTURE.md and .ok/config.yml', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'gen-fixtures-shape-'));
    try {
      const outDir = resolve(tmp, 'shape-bucket');
      generateFixture(50, outDir);
      expect(existsSync(resolve(outDir, 'FIXTURE.md'))).toBe(true);
      expect(existsSync(resolve(outDir, OK_DIR, 'config.yml'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('mark mix is ~75% link / ~25% wikiLink (D11 ratio)', () => {
    const mgr = new MarkdownManager({ extensions: sharedExtensions });
    const tmp = mkdtempSync(resolve(tmpdir(), 'gen-fixtures-mix-'));
    try {
      const outDir = resolve(tmp, 'mix-100');
      generateFixture(100, outDir);
      const md = readFileSync(resolve(outDir, 'FIXTURE.md'), 'utf8');
      const pm = mgr.parse(md) as unknown as PmJson;
      const linkCount = countMarkType(pm, 'link');
      const wikiCount = countNodeType(pm, 'wikiLink');
      const total = linkCount + wikiCount;
      const linkRatio = linkCount / total;
      expect(linkRatio).toBeGreaterThanOrEqual(0.65);
      expect(linkRatio).toBeLessThanOrEqual(0.85);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
