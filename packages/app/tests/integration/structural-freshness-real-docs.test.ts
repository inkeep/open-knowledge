import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createStructuralFreshnessChecker, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { mdManager } from './test-harness';

type PmNodeJson = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PmNodeJson[];
};

const CONTENT_DIR = resolve(import.meta.dir, '../../../../docs/content');

function corpusFiles(): string[] {
  return readdirSync(CONTENT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.md') || rel.endsWith('.mdx'))
    .map((rel) => join(CONTENT_DIR, rel));
}

function parseDocBody(path: string): PmNodeJson {
  const raw = readFileSync(path, 'utf8');
  const body = stripFrontmatter(raw).body;
  return mdManager.parseWithFallback(body) as PmNodeJson;
}

const checker = createStructuralFreshnessChecker({
  parse: (sourceRaw) => mdManager.parseWithFallback(sourceRaw) as PmNodeJson,
});

function allComponents(root: PmNodeJson): PmNodeJson[] {
  const out: PmNodeJson[] = [];
  const walk = (node: PmNodeJson): void => {
    if (node.type === 'jsxComponent') out.push(node);
    if (node.content) for (const c of node.content) walk(c);
  };
  walk(root);
  return out;
}

describe('structural-freshness derivation — real docs corpus', () => {
  test('zero false-dirty: no pristine component in docs/content diverges', () => {
    const files = corpusFiles();
    expect(files.length).toBeGreaterThan(0);

    let totalComponents = 0;
    const offenders: Array<{ file: string; component: unknown }> = [];
    for (const file of files) {
      const tree = parseDocBody(file);
      const comps = allComponents(tree);
      totalComponents += comps.length;
      for (const comp of comps) {
        if (checker.isDiverged(comp))
          offenders.push({ file, component: comp.attrs?.componentName });
      }
    }

    expect(totalComponents).toBeGreaterThanOrEqual(20);
    expect(offenders).toEqual([]);
  });

  test('must-fire: a planted structural mutation in a real doc is caught', () => {
    let target: PmNodeJson | undefined;
    for (const file of corpusFiles()) {
      const tree = parseDocBody(file);
      const comp = allComponents(tree)[0];
      if (!comp) continue;
      const mutate = (node: PmNodeJson): boolean => {
        if (node.text !== undefined && node.text.trim().length > 0) {
          node.text = `${node.text} [planted divergence]`;
          return true;
        }
        for (const c of node.content ?? []) if (mutate(c)) return true;
        return false;
      };
      if (mutate(comp)) {
        target = comp;
        break;
      }
    }
    expect(target).toBeDefined();
    if (!target) return;

    expect(checker.isDiverged(target)).toBe(true);
  });
});
