/**
 * IPC literal-union-member exhaustiveness meta-test.
 *
 * Mirrors `exhaustiveness-coverage.test.ts` (which gates HTTP `ProblemType`
 * + structural-domain DUs) but scoped to IPC-side discriminated unions.
 * Pins the same architectural property: when a developer adds a new
 * variant to an IPC discriminated union, every consumer's `switch` over
 * the discriminator must be updated, OR the consumer must be marked with
 * a deliberate opt-out comment.
 *
 * Scoped to IPC-side DUs that are load-bearing across the renderer:
 *   - `UrnIpcLookup.kind` ('mapped' | 'http-only' | 'unknown') — the
 *     discriminated result of `lookupUrnInRegistry` from
 *     `packages/core/src/handoff/urn-ipc-registry.ts`. Every consumer of
 *     the registry's lookup function must exhaustively branch on `kind`,
 *     so adding a fourth case (e.g., `'deprecated'`) fails the build at
 *     each unhandled consumer. **This is the load-bearing IPC DU because
 *     the registry is the cross-transport authority** — drift here
 *     silently produces wrong reason translations.
 *   - Cursor `SpawnOutcome.reason` ('invalid-path' | 'not-installed' |
 *     'timeout' | 'spawn-error') — the canonical IPC reason union with
 *     active consumers (`mapSpawnFailure` in `cursor-two-step.ts`,
 *     handoff dispatch UI). Adding a fifth value (e.g., 'rate-limited')
 *     must update every site that branches on this reason.
 *
 * Why these two and not all 42 channels: most IPC channels have one
 * consumer (the dispatch UI in their dropdown) whose switch is colocated
 * with the channel's invocation. Registering every channel's reason union
 * here would expand the test's REGISTRY linearly with no architectural
 * gain — consumers and producers move together. The two registered
 * unions above are the ones that fan out to multiple consumers across
 * the renderer; that's where the meta-test earns its weight.
 *
 * Helper expectation: each registered DU expects a corresponding
 * `assertNeverXyz` helper to be called in the `default:` branch. This
 * matches the existing exhaustiveness-coverage pattern — the helper is
 * the structural evidence that the switch was deliberately exhaustive.
 *
 * Architectural mirror: the test deliberately uses the same registry +
 * matchesDu + statementCallsHelper machinery as `exhaustiveness-coverage.test.ts`.
 * Future IPC DU additions extend the REGISTRY here.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SCAN_ROOTS = [join(REPO_ROOT, 'packages/core/src'), join(REPO_ROOT, 'packages/app/src')];

interface DuRegistration {
  readonly name: string;
  readonly helper: string;
  readonly variantLabels: ReadonlySet<string>;
  readonly uniqueLabels: ReadonlySet<string>;
}

const REGISTRY: readonly DuRegistration[] = [
  {
    name: 'UrnIpcLookup',
    helper: 'assertNeverUrnIpcLookup',
    variantLabels: new Set(['mapped', 'http-only', 'unknown']),
    // 'mapped' + 'http-only' together uniquely identify the registry's
    // lookup result in this codebase — the trio is distinctive enough that
    // any matching switch is over `UrnIpcLookup.kind`.
    uniqueLabels: new Set(['mapped', 'http-only']),
  },
  {
    name: 'SpawnFailureReason',
    helper: 'assertNeverSpawnFailureReason',
    variantLabels: new Set(['invalid-path', 'not-installed', 'timeout', 'spawn-error']),
    // 'spawn-error' + 'not-installed' together uniquely identify the cursor
    // SpawnOutcome reason in this codebase (other DUs may have 'invalid-path'
    // or 'timeout' but not the full quartet).
    uniqueLabels: new Set(['spawn-error', 'not-installed']),
  },
];

/**
 * Maximum number of `// ipc-exhaustiveness-check: opt-out — <reason>` comment
 * markers allowed across the renderer codebase. Each marker bypasses
 * exhaustiveness for one switch site (intended for dynamic-dispatch sites
 * where the heuristic doesn't apply). Starts at 2, which leaves headroom for
 * legitimate dynamic-dispatch sites without losing the ratchet's value.
 *
 * Raising this constant weakens the IPC drift detection — treat any bump
 * as a deliberate loosening of the ratchet.
 */
export const IPC_EXHAUSTIVENESS_OPT_OUT_LIMIT = 2;

const OPT_OUT_MARKER = /\/\/\s*ipc-exhaustiveness-check:\s*opt-out\s*—/;

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
  readonly hasOptOutComment: boolean;
}

function getStringCaseLabel(expr: Expression): string | null {
  if (expr.isKind(SyntaxKind.StringLiteral)) return expr.getLiteralText();
  if (expr.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) return expr.getLiteralText();
  return null;
}

function collectSwitches(sf: SourceFile, content: string): SwitchInfo[] {
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
      // Look at the line preceding the switch for an opt-out comment.
      const start = sw.getStart();
      const lineStart = content.lastIndexOf('\n', start - 1) + 1;
      const previousLineEnd = lineStart - 1;
      const previousLineStart = content.lastIndexOf('\n', previousLineEnd - 1) + 1;
      const previousLine = content.slice(previousLineStart, previousLineEnd);
      const hasOptOutComment = OPT_OUT_MARKER.test(previousLine);
      out.push({
        node: sw,
        line: sw.getStartLineNumber(),
        caseLabels,
        hasDefault,
        defaultStatements,
        hasOptOutComment,
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

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly du: string;
  readonly missing: string;
}

function collectViolations(): {
  violations: Violation[];
  optOutCount: number;
} {
  const violations: Violation[] = [];
  let optOutCount = 0;
  const project = makeProject();
  for (const file of enumerateSourceFiles()) {
    const content = readFileSync(file, 'utf8');
    if (!/switch\s*\(/.test(content)) continue;
    const sf = project.addSourceFileAtPath(file);
    for (const sw of collectSwitches(sf, content)) {
      for (const du of REGISTRY) {
        if (!matchesDu(sw.caseLabels, du)) continue;
        if (sw.hasOptOutComment) {
          optOutCount++;
          continue;
        }
        if (!sw.hasDefault || !defaultEndsWithHelper(sw.defaultStatements, du.helper)) {
          violations.push({
            file: relative(REPO_ROOT, file),
            line: sw.line,
            du: du.name,
            missing: du.helper,
          });
        }
      }
    }
    project.removeSourceFile(sf);
  }
  return { violations, optOutCount };
}

// Anti-vacuousness floor for the scan. The combined `packages/core/src` +
// `packages/app/src` tree contains hundreds of .ts/.tsx files. A count
// below this threshold means one of `SCAN_ROOTS` is wrong (path typo,
// directory rename) or the glob/exclusion regressed — without this floor,
// `enumerateSourceFiles` over an invalid root silently yields zero files
// and the violations array stays empty regardless of switch shape.
const MIN_SCANNED_FILES = 50;

describe('IPC exhaustiveness coverage', () => {
  test('scan covers ≥ MIN_SCANNED_FILES source files (anti-vacuousness)', () => {
    let count = 0;
    for (const _ of enumerateSourceFiles()) count++;
    expect(count).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
  });

  test('every switch over a registered IPC DU terminates in `default: <helper>(target)`', () => {
    const { violations } = collectViolations();
    if (violations.length > 0) {
      const list = violations
        .map(
          (v) =>
            `  ${v.file}:${v.line} — switch over ${v.du}; missing default ${v.missing}(target)`,
        )
        .join('\n');
      throw new Error(
        `IPC discriminated-union switch is not exhaustive.\n` +
          `Each switch over a registered IPC DU must terminate in \`default: <helper>(target)\`\n` +
          `where <helper> is an \`assertNeverXyz\` function whose param is typed \`never\`.\n` +
          `Violations:\n${list}`,
      );
    }
    expect(violations).toEqual([]);
  });

  test(`opt-out comment marker count is gated by IPC_EXHAUSTIVENESS_OPT_OUT_LIMIT (= ${IPC_EXHAUSTIVENESS_OPT_OUT_LIMIT})`, () => {
    const { optOutCount } = collectViolations();
    if (optOutCount > IPC_EXHAUSTIVENESS_OPT_OUT_LIMIT) {
      throw new Error(
        `Too many \`// ipc-exhaustiveness-check: opt-out — ...\` markers (${optOutCount} > ${IPC_EXHAUSTIVENESS_OPT_OUT_LIMIT}).\n` +
          `Either remove unnecessary opt-outs OR raise IPC_EXHAUSTIVENESS_OPT_OUT_LIMIT (each opt-out should map to a documented dynamic-dispatch site).`,
      );
    }
    expect(optOutCount).toBeLessThanOrEqual(IPC_EXHAUSTIVENESS_OPT_OUT_LIMIT);
  });
});
