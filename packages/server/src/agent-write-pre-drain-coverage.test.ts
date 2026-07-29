/**
 * Fail-closed coverage: every agent-write spine handler whose position can be
 * pre-drained actually calls the pre-drain.
 *
 * `applyAgentMarkdownWrite` is the shared spine for the agent content-write HTTP
 * handlers (write / write-md / write-batch / patch / lint-fix). A pending WYSIWYG
 * keystroke in front of one of those writes either gets flushed to safety by
 * `agentWritePreDrain` or has to be rescued from the checkpoint floor after the
 * fact — so a handler that forgets the pre-drain is a silent downgrade, not a
 * visible failure. The sibling `agent-write-loss-detect-coverage` gate enforces
 * the detector at exactly these sites; this one enforces the flush.
 *
 * The exemption is STRUCTURAL, not discretionary. `composeAgentWrite` sets
 * `newBody = payloadBody` for both `replace` and `patch`, so those writes
 * overwrite the whole body and a flushed keystroke cannot survive them —
 * `planPreDrain` declines them outright (`checkpoint-full-overwrite`). A site
 * that only ever writes at those positions therefore has nothing to call. This
 * gate pins that reasoning: it exempts a call site ONLY when every position it
 * passes is a full-body overwrite, so re-pointing such a handler at `append`
 * without wiring the pre-drain fails the build.
 */

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// Every source file that hosts an `applyAgentMarkdownWrite` spine call: the HTTP
// handlers in `api-extension.ts`, the ACP fs-write handler in
// `acp/thread-manager.ts`. Both must be scanned — a pre-drainable spine site in
// an unscanned file is a silent downgrade the gate can't see. The ACP site only
// ever writes `replace` (a full-body overwrite), so it is exempt today; scanning
// it makes a future re-point at `append` without a pre-drain fail the build.
const SPINE_FILES = [join(here, 'api-extension.ts'), join(here, 'acp', 'thread-manager.ts')];

/** Positions whose compose is a full-body overwrite (pre-drain is inert). */
const FULL_BODY_OVERWRITE = new Set(['replace', 'patch']);

function newProject(): Project {
  return new Project({
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { noLib: true, allowJs: false },
  });
}

/** Callee's trailing name: `x.foo` → `foo`, `foo` → `foo`, else null. */
function calleeName(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  return null;
}

/**
 * Every string literal the call's `position` argument (3rd positional) can
 * evaluate to. Handles the literal (`'append'`) and the defaulted-expression
 * (`entry.position ?? 'append'`) forms; anything else yields an empty set, which
 * is NOT exempt — an unanalysable position must not buy an exemption.
 */
function positionLiterals(call: Node): Set<string> {
  const out = new Set<string>();
  if (!Node.isCallExpression(call)) return out;
  const arg = call.getArguments()[2];
  if (!arg) return out;
  for (const lit of [
    ...(Node.isStringLiteral(arg) ? [arg] : []),
    ...arg.getDescendantsOfKind(SyntaxKind.StringLiteral),
  ]) {
    out.add(lit.getLiteralText());
  }
  return out;
}

function isFunctionLike(n: Node): boolean {
  return (
    Node.isFunctionDeclaration(n) ||
    Node.isFunctionExpression(n) ||
    Node.isArrowFunction(n) ||
    Node.isMethodDeclaration(n)
  );
}

/**
 * The HANDLER scope for a spine call: the nearest enclosing function that is not
 * itself a `transact(...)` callback. Climbing past transact callbacks is the
 * point — the pre-drain must run in the handler, in its OWN observer-origin
 * transact, never nested inside the agent's (which would capture the flush into
 * the undo frame).
 */
function handlerScope(call: Node): Node | undefined {
  for (const anc of call.getAncestors()) {
    if (!isFunctionLike(anc)) continue;
    const parent = anc.getParent();
    if (parent && Node.isCallExpression(parent) && calleeName(parent) === 'transact') continue;
    return anc;
  }
  return undefined;
}

describe('agent-write pre-drain coverage', () => {
  it('every pre-drainable applyAgentMarkdownWrite spine call is preceded by agentWritePreDrain', () => {
    const project = newProject();
    const spineCalls = SPINE_FILES.flatMap((path) =>
      project
        .addSourceFileAtPath(path)
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => calleeName(c) === 'applyAgentMarkdownWrite'),
    );
    // Guard-the-guard: five HTTP spine sites (write / write-md / write-batch /
    // patch / lint-fix) plus the ACP fs-write site. A refactor that drops below
    // this is suspect.
    expect(spineCalls.length).toBeGreaterThanOrEqual(6);

    // A site is exempt only when every position it can pass is a full-body
    // overwrite, and it passes at least one analysable position.
    const preDrainable = spineCalls.filter((call) => {
      const positions = positionLiterals(call);
      return positions.size === 0 || [...positions].some((p) => !FULL_BODY_OVERWRITE.has(p));
    });
    // At least the three localized-write handlers must be in scope.
    expect(preDrainable.length).toBeGreaterThanOrEqual(3);

    const missing = preDrainable
      .filter((call) => {
        const scope = handlerScope(call);
        if (!scope) return true;
        return !scope
          .getDescendantsOfKind(SyntaxKind.CallExpression)
          .some((c) => calleeName(c) === 'agentWritePreDrain' && c.getStart() < call.getStart());
      })
      .map((c) => `${basename(c.getSourceFile().getFilePath())}:${c.getStartLineNumber()}`);
    expect(missing).toEqual([]);
  });

  it('does not exempt a site that writes at a pre-drainable position (planted positive)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-append-without-pre-drain.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       function h(doc: unknown) {
         applyAgentMarkdownWrite(doc, 'x', 'append');
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    const positions = call ? positionLiterals(call) : new Set<string>();
    expect([...positions]).toEqual(['append']);
    expect([...positions].some((p) => !FULL_BODY_OVERWRITE.has(p))).toBe(true);
  });

  it('exempts a site that only ever writes a full-body overwrite (negative control)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-patch-only.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       function h(doc: unknown) {
         applyAgentMarkdownWrite(doc, 'x', 'patch');
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    const positions = call ? positionLiterals(call) : new Set<string>();
    expect([...positions].some((p) => !FULL_BODY_OVERWRITE.has(p))).toBe(false);
  });

  it('refuses to exempt an unanalysable position (fail-closed)', () => {
    const project = newProject();
    const sf = project.createSourceFile(
      'planted-dynamic-position.ts',
      `declare function applyAgentMarkdownWrite(...a: unknown[]): void;
       function h(doc: unknown, pos: string) {
         applyAgentMarkdownWrite(doc, 'x', pos);
       }`,
    );
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeName(c) === 'applyAgentMarkdownWrite');
    expect(call).toBeDefined();
    // No literal to reason about → in scope for the gate, not exempt.
    expect(call ? positionLiterals(call).size : -1).toBe(0);
  });
});
