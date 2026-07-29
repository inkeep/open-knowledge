/**
 * Fail-closed sweep for the paired-intake content-loss classification.
 *
 * Every paired-write origin declared in production source must carry a
 * `detect`/`suppress` classification, and every live classification must
 * correspond to a real origin. A new paired write surface therefore cannot ship
 * without a deliberate loss-detection decision.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PAIRED_INTAKE_DETECTION,
  pairedIntakeDetectionMode,
  RESERVED_PAIRED_INTAKE_DETECTION,
  shouldRunPairedIntakeDetection,
} from './bridge-loss-suppression.ts';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Files whose `paired: true` literals are fixtures, not production origins. */
function isProductionSource(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.test-helper.ts') &&
    !name.endsWith('.d.ts')
  );
}

/** Drop comment lines so JSDoc prose like "No `paired: true` flag" never matches. */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

/**
 * RECURSIVE — `packages/server/src` has 14+ subdirectories (`acp/`, `http/`,
 * `mcp/`, `config/`, `content/`, `fs/`, ...) and a paired origin declared in any
 * of them must not escape the sweep. A top-level-only `readdirSync` was blind to
 * exactly the surface this gate exists to close; the sibling gate
 * `paired-write-enforcement.test.ts` walks the tree for the same reason.
 */
function declaredPairedOrigins(root: string = SRC_DIR): Set<string> {
  const origins = new Set<string>();
  // Brace-flat object literals only: the `PairedWriteOrigin` type declaration
  // (`origin: string`, unquoted + `readonly paired: true`) and the non-paired
  // `observer-sync` origin (no `paired: true` in its object) are excluded.
  const objLiteral = /\{[^{}]*\}/g;
  for (const rel of readdirSync(root, { recursive: true, encoding: 'utf-8' })) {
    const base = rel.split(sep).pop() ?? rel;
    if (!isProductionSource(base)) continue;
    let text: string;
    try {
      text = stripCommentLines(readFileSync(join(root, rel), 'utf-8'));
    } catch {
      continue; // a directory whose name ends in `.ts`, or a dangling link
    }
    for (const m of text.matchAll(objLiteral)) {
      const obj = m[0];
      if (!obj.includes('paired: true')) continue;
      const originMatch = obj.match(/origin:\s*'([^']+)'/);
      if (originMatch?.[1]) origins.add(originMatch[1]);
    }
  }
  return origins;
}

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A synthetic `src`-shaped tree: one top-level and one nested paired origin. */
function plantSyntheticTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-paired-scan-'));
  scratchDirs.push(root);
  writeFileSync(
    join(root, 'top-level-surface.ts'),
    "export const TOP = Object.freeze({ source: 'local', context: { origin: 'planted-top-level', paired: true } });\n",
    'utf-8',
  );
  mkdirSync(join(root, 'http', 'deeper'), { recursive: true });
  writeFileSync(
    join(root, 'http', 'nested-surface.ts'),
    "export const NESTED = Object.freeze({ source: 'local', context: { origin: 'planted-subdirectory', paired: true } });\n",
    'utf-8',
  );
  writeFileSync(
    join(root, 'http', 'deeper', 'deepest-surface.ts'),
    "export const DEEP = Object.freeze({ source: 'local', context: { origin: 'planted-two-deep', paired: true } });\n",
    'utf-8',
  );
  // Test code at both depths must stay excluded.
  writeFileSync(
    join(root, 'http', 'nested-surface.test.ts'),
    "const FIXTURE = { origin: 'planted-fixture-not-production', paired: true };\n",
    'utf-8',
  );
  return root;
}

describe('paired-intake detection classification (fail-closed sweep)', () => {
  /**
   * Scanner-level planted positive. The other cases test the CLASSIFICATION MAP;
   * this one tests the SCANNER that feeds it — a paired origin declared one and
   * two directories deep must be found, or the fail-closed set equality above is
   * computed over a partial view of the tree and cannot bite.
   */
  it('the scanner finds paired origins declared in subdirectories, not just top-level files', () => {
    const root = plantSyntheticTree();
    const found = declaredPairedOrigins(root);

    expect(found.has('planted-top-level')).toBe(true);
    expect(found.has('planted-subdirectory')).toBe(true);
    expect(found.has('planted-two-deep')).toBe(true);
    // Test-file literals are fixtures, never production origins.
    expect(found.has('planted-fixture-not-production')).toBe(false);
    expect([...found].sort()).toEqual([
      'planted-subdirectory',
      'planted-top-level',
      'planted-two-deep',
    ]);
  });

  it('classifies every paired-write origin declared in production source', () => {
    const declared = declaredPairedOrigins();
    // Guard-the-guard: the scan must actually find the known origins.
    expect(declared.size).toBeGreaterThanOrEqual(5);
    const unclassified = [...declared].filter((o) => pairedIntakeDetectionMode(o) === undefined);
    expect(unclassified).toEqual([]);
  });

  it('has no phantom classification without a source origin', () => {
    const declared = declaredPairedOrigins();
    const phantom = Object.keys(PAIRED_INTAKE_DETECTION).filter((o) => !declared.has(o));
    expect(phantom).toEqual([]);
  });

  it('keeps reserved classifications out of the live map until their constant lands', () => {
    const declared = declaredPairedOrigins();
    for (const reserved of Object.keys(RESERVED_PAIRED_INTAKE_DETECTION)) {
      expect(PAIRED_INTAKE_DETECTION[reserved]).toBeUndefined();
      expect(declared.has(reserved)).toBe(false);
    }
  });

  it('flags a synthetic unclassified origin', () => {
    expect(pairedIntakeDetectionMode('brand-new-write-surface')).toBeUndefined();
    expect(shouldRunPairedIntakeDetection('brand-new-write-surface')).toBe(false);
  });

  it('runs the detector for content-preserving origins and suppresses replacements', () => {
    expect(shouldRunPairedIntakeDetection('agent-write')).toBe(true);
    expect(shouldRunPairedIntakeDetection('agent-undo')).toBe(true);
    expect(shouldRunPairedIntakeDetection('file-watcher')).toBe(true);
    expect(shouldRunPairedIntakeDetection('rollback-apply')).toBe(false);
    expect(shouldRunPairedIntakeDetection('managed-rename')).toBe(false);
    expect(shouldRunPairedIntakeDetection('park-snapshot')).toBe(false);
  });
});
