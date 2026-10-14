import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from '../../../../test-support/test-only-source-file.mjs';
import { E2E_CI_EXCLUSIONS } from '../stress/e2e-ci-ledger';
import {
  LINK_AUDIT_COMPOSITION_ROOTS,
  LINK_AUDIT_SEAMS,
  type LinkAuditCompositionRoot,
  type LinkAuditSeam,
} from './link-audit-seams.manifest.ts';

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const BLOCKING_E2E_DIR = 'packages/app/tests/stress/';
const CI_EXCLUDED_E2E = new Set(
  E2E_CI_EXCLUSIONS.map((entry) => `${BLOCKING_E2E_DIR}${entry.file}`),
);

interface ValidationDeps {
  exists(path: string): boolean;
  read(path: string): string;
}

function validateLinkAuditSubstrate(
  seams: readonly LinkAuditSeam[],
  roots: readonly LinkAuditCompositionRoot[],
  deps: ValidationDeps,
  ciExcluded: ReadonlySet<string> = CI_EXCLUDED_E2E,
): string[] {
  const violations: string[] = [];
  const ids = new Set<string>();

  for (const seam of seams) {
    if (ids.has(seam.id)) violations.push(`duplicate seam id: ${seam.id}`);
    ids.add(seam.id);
    for (const path of [...seam.modules, ...seam.tests.map((entry) => entry.path)]) {
      if (!deps.exists(path)) violations.push(`${seam.id}: missing path ${path}`);
    }
    const presentTiers = new Set(seam.tests.map((entry) => entry.tier));
    for (const tier of seam.requiredTiers) {
      if (!presentTiers.has(tier)) violations.push(`${seam.id}: missing ${tier} coverage`);
    }
  }

  for (const testPath of new Set(
    seams.flatMap((seam) =>
      seam.tests.filter((entry) => entry.tier === 'browser-e2e').map((entry) => entry.path),
    ),
  )) {
    const collected =
      testPath.startsWith(BLOCKING_E2E_DIR) && isTestOnlySourceFile(testPath, 'playwright');
    if (!collected || ciExcluded.has(testPath)) {
      violations.push(`browser E2E is not in the blocking app test:e2e run: ${testPath}`);
    }
  }

  for (const root of roots) {
    if (!deps.exists(root.path)) {
      violations.push(`missing composition root: ${root.path}`);
      continue;
    }
    const source = deps.read(root.path);
    if (!source.includes(root.requiredText)) {
      violations.push(`composition root lost real wiring: ${root.path}`);
    }
    if (root.maskingText !== undefined && source.includes(root.maskingText)) {
      violations.push(`composition root contains masking path: ${root.path}`);
    }
  }
  return violations;
}

const realDeps: ValidationDeps = {
  exists: (path) => existsSync(fileURLToPath(new URL(path, `file://${workspaceRoot}/`))),
  read: (path) => readFileSync(fileURLToPath(new URL(path, `file://${workspaceRoot}/`)), 'utf-8'),
};

describe('local-target link-audit seam substrate', () => {
  test('every declared seam carries its required rung and every composition root stays real', () => {
    expect(
      validateLinkAuditSubstrate(LINK_AUDIT_SEAMS, LINK_AUDIT_COMPOSITION_ROOTS, realDeps),
    ).toEqual([]);
  });

  test('the checker fires on one planted missing test without flagging adjacent valid paths', () => {
    const planted = LINK_AUDIT_SEAMS[0]?.tests[0]?.path;
    expect(planted).toBeDefined();
    const violations = validateLinkAuditSubstrate(LINK_AUDIT_SEAMS, [], {
      ...realDeps,
      exists: (path) => path !== planted && realDeps.exists(path),
    });
    expect(violations).toEqual([
      `canonical-occurrence-classification: missing path ${planted as string}`,
    ]);
  });

  test('the checker flags a browser E2E that the blocking run does not collect', () => {
    const ledgered = `${BLOCKING_E2E_DIR}ledgered.e2e.ts`;
    const seamWith = (path: string): LinkAuditSeam => ({
      id: 'planted',
      priority: 'P1',
      owner: 'test',
      failureClass: 'test',
      modules: [],
      tests: [{ path, tier: 'browser-e2e' }],
      requiredTiers: ['browser-e2e'],
    });
    const deps = { exists: () => true, read: () => '' };
    const violationsFor = (path: string) =>
      validateLinkAuditSubstrate([seamWith(path)], [], deps, new Set([ledgered]));
    expect(violationsFor(`${BLOCKING_E2E_DIR}local-target-audit.e2e.ts`)).toEqual([]);
    for (const path of [
      `${BLOCKING_E2E_DIR}_helpers/fixtures.ts`,
      ledgered,
      'packages/app/tests/a11y/x.e2e.ts',
    ]) {
      expect(violationsFor(path)).toEqual([
        `browser E2E is not in the blocking app test:e2e run: ${path}`,
      ]);
    }
  });

  test('the checker distinguishes missing real wiring from an adjacent masking path', () => {
    const [root] = LINK_AUDIT_COMPOSITION_ROOTS.filter((entry) => entry.maskingText !== undefined);
    expect(root).toBeDefined();
    const missingReal = validateLinkAuditSubstrate([], [root as LinkAuditCompositionRoot], {
      exists: () => true,
      read: () => 'const localTargets = toForwardLinkLocalTargets([]);',
    });
    expect(missingReal).toEqual([
      `composition root contains masking path: ${(root as LinkAuditCompositionRoot).path}`,
    ]);

    const adjacentValid = validateLinkAuditSubstrate([], [root as LinkAuditCompositionRoot], {
      exists: () => true,
      read: () => 'const localTargets = toForwardLinkLocalTargets(realAssessments);',
    });
    expect(adjacentValid).toEqual([]);
  });
});
