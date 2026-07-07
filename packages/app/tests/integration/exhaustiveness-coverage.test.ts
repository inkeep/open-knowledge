/**
 * Exhaustiveness coverage meta-test.
 *
 * Static-analysis gate that AST-scans the codebase for every `switch (x.kind)`
 * (or equivalent property-keyed switch) whose case labels match a registered
 * discriminated-union type, and asserts the switch terminates with
 * `default: assertNeverXyz(target)`.
 *
 * The defended failure mode is the consumer-forgets-the-guard one: a developer
 * adds a new switch over `ClassifiedLinkTarget`, doesn't include `default:
 * assertNeverLinkTarget(target)`, and a future variant addition silently
 * drops on the floor at that site. Per-DU `*.exhaustiveness.test.ts` files
 * (now superseded) only proved themselves exhaustive — they couldn't catch
 * a consumer that omitted the helper.
 *
 * The DU registry is opt-in: only types listed here are scanned. Adding a new
 * registered DU is a single-line edit. Switches are matched via case-label
 * containment (every case label must belong to the DU's variant set, AND at
 * least one case label must be unique to this DU — disambiguates from other
 * DUs that share kind names like `'doc'`).
 */
import { describe, expect, test } from 'bun:test';
import { join, relative, resolve } from 'node:path';
import { ProblemTypeSchema } from '@inkeep/open-knowledge-core';
import { Glob } from 'bun';
import {
  type Expression,
  type Node,
  Project,
  type SourceFile,
  type Statement,
  type SwitchStatement,
  SyntaxKind,
} from 'ts-morph';

// All ProblemType URN tokens are unique to ProblemType (every member starts
// with `urn:ok:error:`), so variantLabels and uniqueLabels are the same set.
// Derived from the schema at test-discovery time so the registry never drifts
// from `core/src/schemas/api/_envelope.ts`.
const PROBLEM_TYPE_LABELS: ReadonlySet<string> = new Set(ProblemTypeSchema.options);

interface DuRegistration {
  /** Display name (used in failure messages). */
  readonly name: string;
  /** Helper expected at `default: <helper>(target)`. */
  readonly helper: string;
  /** Every kind/discriminator value the DU defines. */
  readonly variantLabels: ReadonlySet<string>;
  /**
   * Disambiguator labels — case labels that uniquely identify this DU
   * relative to other registered DUs (e.g., `'doc'` is shared between
   * `ClassifiedLinkTarget` and `ResolvedNavigationTarget`, so it cannot
   * disambiguate). At least one case label must be in this set for the
   * heuristic to claim the switch is over this DU.
   */
  readonly uniqueLabels: ReadonlySet<string>;
}

const REGISTRY: readonly DuRegistration[] = [
  {
    name: 'ClassifiedLinkTarget',
    helper: 'assertNeverLinkTarget',
    variantLabels: new Set(['doc', 'external', 'anchor', 'asset']),
    // 'doc' is shared with ResolvedNavigationTarget; 'asset' is generic
    // enough to appear elsewhere. 'anchor' and 'external' are distinctive
    // enough to identify a ClassifiedLinkTarget switch.
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
    // Compound names + 'rename'/'conflict' are unique to DiskEvent in this
    // codebase. Generic 'create'/'update'/'delete' alone do not disambiguate
    // (they appear in RawFileEvent.type).
    uniqueLabels: new Set(['asset-create', 'asset-delete', 'rename', 'conflict']),
  },
  {
    name: 'ProblemType',
    helper: 'assertNeverProblemType',
    // Derived from `ProblemTypeSchema.options` so adding a new URN to the
    // schema automatically extends the meta-test's coverage. Pre-derivation
    // the registry seeded only the upload-side ~11 tokens and silently
    // disengaged for any consumer switch over a token outside that subset
    // (e.g., `upload-errors.ts`'s switch on the upload-side 5 was already
    // covered, but a future switch on `auth-failed` or `sync-not-active`
    // would skip the heuristic without a registry update).
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
    const glob = new Glob('**/*.{ts,tsx}');
    for (const rel of glob.scanSync({ cwd: root })) {
      const abs = join(root, rel);
      if (isExcludedPath(abs)) continue;
      yield abs;
    }
  }
}

/**
 * One ts-morph Project, configured to skip lib loading and import resolution
 * so each `addSourceFileAtPath` call parses only the explicitly-supplied
 * file. Matches the prior `ts.createSourceFile` semantics — pure parse, no
 * dependency walk.
 */
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
    // Skip switches that contain non-literal case expressions (e.g.,
    // computed keys, identifiers) — heuristic doesn't apply.
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
  // Allow `helper(x)`, `return helper(x)`, `throw helper(x)` at any position
  // in the default body — block fall-through cases (e.g., logging then
  // calling the helper) but require the helper to actually be called.
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
    // Bound memory: drop the parsed file once we've extracted what we need.
    project.removeSourceFile(sf);
  }
  return failures;
}

describe('exhaustiveness coverage', () => {
  // AST scan across the repo runs in ~1-2s locally on macOS/FSEvents but
  // can take 5-10s on Linux CI under load (parallel test workers contending
  // for I/O + cache misses on the scanned source tree). Bun's 5s default
  // is too tight on CI; bumping to 30s gives comfortable headroom without
  // changing semantics. The test itself is fast — the bottleneck is the
  // recursive directory walk.
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
    // Sanity check: the registry actually identifies real consumers. If this
    // ever returns 0, the heuristic has drifted and the meta-test became
    // vacuous — fail loud rather than silently green.
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
    // Sibling guard to the ClassifiedLinkTarget scanner check above.
    // `PROBLEM_TYPE_LABELS` is derived from `ProblemTypeSchema.options` —
    // if a Zod upgrade changes the introspection shape (e.g. `.options`
    // becomes a getter that returns `[]` until called differently), the
    // set goes empty and every ProblemType switch in the codebase silently
    // disengages from the meta-test. ProblemType is the largest DU
    // (~40 URN tokens) and the most consumed; pin a floor at 30 so a
    // shrink of a few entries doesn't false-alarm but a structural
    // disengagement does.
    expect(PROBLEM_TYPE_LABELS.size).toBeGreaterThanOrEqual(30);
  });
});
