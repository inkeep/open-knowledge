import { join, relative, resolve } from 'node:path';
import { ProblemTypeSchema } from '@inkeep/open-knowledge-core';
import {
  type Expression,
  type Node,
  Project,
  type SourceFile,
  type Statement,
  type SwitchStatement,
  SyntaxKind,
} from 'ts-morph';
import { describe, expect, test } from 'vitest';

const PROBLEM_TYPE_LABELS: ReadonlySet<string> = new Set(ProblemTypeSchema.options);

interface DuRegistration {
  readonly name: string;
  readonly helper: string;
  readonly variantLabels: ReadonlySet<string>;
  readonly uniqueLabels: ReadonlySet<string>;
}

const REGISTRY: readonly DuRegistration[] = [
  {
    name: 'ClassifiedLinkTarget',
    helper: 'assertNeverLinkTarget',
    variantLabels: new Set(['doc', 'external', 'anchor', 'asset']),
    uniqueLabels: new Set(['anchor', 'external']),
  },
  {
    name: 'DiskEvent',
    helper: 'assertNeverDiskEvent',
    variantLabels: new Set([
      'create',
      'update',
      'delete',
      'rename',
      'conflict',
      'asset-create',
      'asset-delete',
    ]),
    uniqueLabels: new Set(['asset-create', 'asset-delete', 'rename', 'conflict']),
  },
  {
    name: 'ProblemType',
    helper: 'assertNeverProblemType',
    variantLabels: PROBLEM_TYPE_LABELS,
    uniqueLabels: PROBLEM_TYPE_LABELS,
  },
];

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages/core/src'),
  join(REPO_ROOT, 'packages/server/src'),
  join(REPO_ROOT, 'packages/app/src'),
];

function isExcludedPath(absPath: string): boolean {
  if (absPath.endsWith('.d.ts')) return true;
  if (/\.test\.tsx?$/.test(absPath)) return true;
  if (/\.type-tests\.tsx?$/.test(absPath)) return true;
  if (absPath.includes('/node_modules/')) return true;
  if (absPath.includes('/dist/')) return true;
  return false;
}

function* enumerateSourceFiles(): Generator<string> {
  for (const root of SCAN_ROOTS) {
    const glob = new Bun.Glob('**/*.{ts,tsx}');
    for (const rel of glob.scanSync({ cwd: root })) {
      const abs = join(root, rel);
      if (isExcludedPath(abs)) continue;
      yield abs;
    }
  }
}

function makeProject(): Project {
  return new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      noLib: true,
      allowJs: false,
    },
  });
}

interface SwitchInfo {
  readonly node: SwitchStatement;
  readonly line: number;
  readonly caseLabels: readonly string[];
  readonly hasDefault: boolean;
  readonly defaultStatements: readonly Statement[];
}

function getStringCaseLabel(expr: Expression): string | null {
  if (expr.isKind(SyntaxKind.StringLiteral)) return expr.getLiteralText();
  if (expr.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) return expr.getLiteralText();
  return null;
}

function collectSwitches(sf: SourceFile): SwitchInfo[] {
  const out: SwitchInfo[] = [];
  for (const sw of sf.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    const caseLabels: string[] = [];
    let hasDefault = false;
    let defaultStatements: readonly Statement[] = [];
    let nonLiteralCase = false;
    for (const clause of sw.getCaseBlock().getClauses()) {
      if (clause.isKind(SyntaxKind.DefaultClause)) {
        hasDefault = true;
        defaultStatements = clause.getStatements();
      } else {
        const label = getStringCaseLabel(clause.getExpression());
        if (label === null) {
          nonLiteralCase = true;
        } else {
          caseLabels.push(label);
        }
      }
    }
    if (!nonLiteralCase && caseLabels.length > 0) {
      out.push({
        node: sw,
        line: sw.getStartLineNumber(),
        caseLabels,
        hasDefault,
        defaultStatements,
      });
    }
  }
  return out;
}

function matchesDu(caseLabels: readonly string[], du: DuRegistration): boolean {
  if (caseLabels.length === 0) return false;
  for (const label of caseLabels) {
    if (!du.variantLabels.has(label)) return false;
  }
  for (const label of caseLabels) {
    if (du.uniqueLabels.has(label)) return true;
  }
  return false;
}

function defaultEndsWithHelper(defaultStatements: readonly Statement[], helper: string): boolean {
  if (defaultStatements.length === 0) return false;
  for (const stmt of defaultStatements) {
    if (statementCallsHelper(stmt, helper)) return true;
  }
  return false;
}

function statementCallsHelper(stmt: Statement | Node, helper: string): boolean {
  if (stmt.isKind(SyntaxKind.ExpressionStatement)) {
    return expressionCallsHelper(stmt.getExpression(), helper);
  }
  if (stmt.isKind(SyntaxKind.ReturnStatement)) {
    const expr = stmt.getExpression();
    return expr !== undefined && expressionCallsHelper(expr, helper);
  }
  if (stmt.isKind(SyntaxKind.ThrowStatement)) {
    return expressionCallsHelper(stmt.getExpression(), helper);
  }
  if (stmt.isKind(SyntaxKind.Block)) {
    for (const inner of stmt.getStatements()) {
      if (statementCallsHelper(inner, helper)) return true;
    }
  }
  return false;
}

function expressionCallsHelper(expr: Expression, helper: string): boolean {
  if (!expr.isKind(SyntaxKind.CallExpression)) return false;
  const callee = expr.getExpression();
  return callee.isKind(SyntaxKind.Identifier) && callee.getText() === helper;
}

interface Failure {
  readonly file: string;
  readonly line: number;
  readonly du: string;
  readonly reason: string;
}

function scanRepo(): Failure[] {
  const failures: Failure[] = [];
  const project = makeProject();
  for (const absPath of enumerateSourceFiles()) {
    const sf = project.addSourceFileAtPath(absPath);
    const switches = collectSwitches(sf);
    for (const sw of switches) {
      for (const du of REGISTRY) {
        if (!matchesDu(sw.caseLabels, du)) continue;
        if (!sw.hasDefault) {
          failures.push({
            file: relative(REPO_ROOT, absPath),
            line: sw.line,
            du: du.name,
            reason: `switch over ${du.name} missing 'default: ${du.helper}(target)'`,
          });
          continue;
        }
        if (!defaultEndsWithHelper(sw.defaultStatements, du.helper)) {
          failures.push({
            file: relative(REPO_ROOT, absPath),
            line: sw.line,
            du: du.name,
            reason: `switch over ${du.name} default does not call ${du.helper}(target)`,
          });
        }
      }
    }
    project.removeSourceFile(sf);
  }
  return failures;
}

describe('exhaustiveness coverage', () => {
  test('every switch over a registered DU ends with default: assertNeverXyz(target)', () => {
    const failures = scanRepo();
    if (failures.length > 0) {
      const lines = failures.map((f) => `  ${f.file}:${f.line} (${f.du}) — ${f.reason}`);
      throw new Error(
        `Exhaustiveness violations (${failures.length}):\n${lines.join('\n')}\n\n` +
          'Fix: add `default: assertNeverXyz(target)` (the per-DU helper) at each ' +
          'site to force compile-time discovery when a new variant is added.',
      );
    }
    expect(failures).toEqual([]);
  }, 30_000);

  test('the AST scanner finds the canonical ClassifiedLinkTarget consumer', () => {
    const project = makeProject();
    let foundClassifiedLinkTargetConsumer = false;
    for (const absPath of enumerateSourceFiles()) {
      const sf = project.addSourceFileAtPath(absPath);
      for (const sw of collectSwitches(sf)) {
        const linkTargetDu = REGISTRY.find((d) => d.name === 'ClassifiedLinkTarget');
        if (!linkTargetDu) continue;
        if (matchesDu(sw.caseLabels, linkTargetDu)) {
          foundClassifiedLinkTargetConsumer = true;
          break;
        }
      }
      project.removeSourceFile(sf);
      if (foundClassifiedLinkTargetConsumer) break;
    }
    expect(foundClassifiedLinkTargetConsumer).toBe(true);
  });

  test('PROBLEM_TYPE_LABELS holds the expected URN baseline (anti-vacuousness)', () => {
    expect(PROBLEM_TYPE_LABELS.size).toBeGreaterThanOrEqual(30);
  });
});
