// FIXTURE — drives `no-hand-rolled-branch-validation.test.ts` via shell-out to
// `pnpm exec oxlint`. Not part of the main lint: `__fixtures__/` is in
// `oxlint.config.ts#ignorePatterns`, and `__fixtures__/oxlint.fixtures.json`
// re-enables the rules for the test.
//
// 4 positive cases (deliberate violations — rule must fire) + 4 negative cases
// (sanctioned or unrelated shapes that must NOT fire). Exact-equality
// (`toBe(4)`) in the test catches both false-negative regressions (drop below
// 4) and false-positive widenings (above 4).
//
// Positive1 is the load-bearing one: it is the exact pre-fix source line
// from packages/server/src/http/history-routes.ts, verbatim. If the rule
// stops firing on it, the rule no longer covers the bug it was promoted for.
//
// Negative3 is the audit's only false positive under a string-method
// predicate (a GC filter selecting by naming convention, not validating). The
// rule is deliberately regex-only so this stays silent.

declare const branch: string;
declare const branchName: string;
declare const ref: { branch: string };
declare const isValidBranchName: (b: unknown) => b is string;
declare const skillName: string;

// === Positive cases — must fire ===

// (1) The exact pre-fix guard, verbatim.
export function Positive1(): boolean {
  if (branch.includes('..') || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) {
    return false;
  }
  return true;
}

// (2) Same defect wearing a different identifier and a `.match` shape.
export function Positive2(): boolean {
  return branchName.match(/^[a-z0-9-]+$/) !== null;
}

// (3) Same defect reached through a member expression.
export function Positive3(): boolean {
  return /^[\w.-]+$/.test(ref.branch);
}

// (4) Same defect through `.exec`, which shares `.test`'s AST shape and is
//     one `typescript-eslint/prefer-regexp-exec` autofix away from Positive2.
export function Positive4(): boolean {
  return /^[a-z0-9-]+$/.exec(branchName) !== null;
}

// === Negative cases — must NOT fire ===

// (1) The sanctioned shape: delegate to the declared contract.
export function Negative1(): boolean {
  return isValidBranchName(branch);
}

// (2) A regex tested against something that is not a branch value.
export function Negative2(): boolean {
  return /^[a-z0-9-]+$/.test(skillName);
}

// (3) A string-method filter selecting by naming convention, not validating.
//     This is shadow-branch-gc.ts:111's shape — the footprint audit's only
//     false positive under a string-method predicate.
export function Negative3(): boolean {
  return branch.startsWith('detached-');
}

// (4) A regex applied to a branch value for a non-admissibility purpose
//     (extraction), through a method the rule does not claim.
export function Negative4(): string {
  return branch.replace(/^refs\/heads\//, '');
}
