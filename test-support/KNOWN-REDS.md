# Known reds, quarantines and skips

How Open Knowledge marks a test that is expected to fail or that deliberately does not run.

- **The listing command:** `pnpm known-reds` lists every such test.
- **The checks:** `pnpm known-reds` exits 1 when a test breaks a rule below, and the guard test `scripts/check-known-reds.uncached.test.mjs` runs the same checks in the uncached test tier.
- **The scanner and its data:** `scripts/known-reds.mjs` holds the scanner and the owner list, and `scripts/known-reds-allowlist.json` holds the CI-keyed skips still waiting to be removed.

## A known bug: pin it

A test that fails because the product is wrong is still a working test. Write the assertion the product should satisfy, and wrap it in `expectKnownBug`. Its signature names the wrong outcome you observed:

```ts
import { expectKnownBug } from '../../../test-support/known-bug.vitest.test-helper';

test(
  'hiding a file removes its sidebar row',
  {
    tags: ['known-bug'],
    meta: {
      issue: 'https://github.com/inkeep/agents-private/issues/2816',
      owner: 'get-main-green',
      until: '2026-12-01',
    },
  },
  async () => {
    await expectKnownBug(/expected \[ 'notes\.md', 'draft\.md' \] to deeply equal/, async () => {
      expect(await sidebarRowNames()).toEqual(['notes.md']);
    });
  },
);
```

**How a pin behaves:**
- While the bug is present, the pin passes.
- Once the bug is fixed, it fails with "known bug appears fixed".
- If anything else goes wrong, it fails with the original error.

**The signature** names the wrong outcome itself: the whole received value, or the Playwright call-log line that shows it. An assertion's name or a timeout alone is not enough, because a broken selector would match it too. The guard refuses a signature without at least 4 literal characters in a row, such as `/./`.

**Before you pin,** run the test several times at the revision you pin, and state the count in the PR. Pin only a failure that shows the same wrong outcome on every run. A test that now passes needs no pin: un-skip it. One that fails only sometimes is a flake: quarantine it, as below. Parked tests are often already fixed, or fail only sometimes, by the time someone pins them.

**The three fields:**
- `issue` is a GitHub or Linear issue URL.
- `owner` is one of the owners listed in `scripts/known-reds.mjs`.
- `until` is a date no more than 90 days away.

A date that has passed does not fail the guard: `pnpm known-reds` lists the entry under "Expired, reported and not failed" and in the feed's `expired`, and the owner either fixes the bug, or moves the date and records why on the issue. A missing or malformed field, or a date more than 90 days away on the day the guard runs, still fails. The listing shows every pin, quarantine and allowlist entry under "Expiring within 14 days" before its date passes.<br>_[Recorded 2026-10-12 post-ship: before 2026-10-12 this passage read "When the date passes, the guard fails", so a pin or quarantine past its `until` turned the guard red on that date alone; the owner's decisions Q52 and 8A made a passed date reported and not failed.]_

**Never use** `test.fails`, `{ fails: true }` or Playwright's `test.fail()`. Each accepts any failure, including one that has nothing to do with the bug.

**Playwright pins** differ in four ways:
- they import `test-support/known-bug.test-helper`;
- they use the tag `'@known-bug'`;
- they carry the three fields as `annotation` entries, `{ type: 'issue' | 'owner' | 'until', description }`;
- they sit in a describe that calls `test.describe.configure({ retries: 0 })`, so that a retry cannot turn a changed failure into a flaky pass.

**When the bug is fixed,** keep the assertion, remove `expectKnownBug` and the tag, and close the issue.

## A limitation accepted by design

This is not a known red. Assert today's behaviour in an ordinary test whose title says what it is.

## A flake: quarantine it

Declare the test skipped, tag it `quarantine` (`@quarantine` in Playwright), and give it the same `issue`, `owner` and `until` fields. A flake is never pinned, because a pin has to fail on every run.

## A test that cannot run here

Skip it with the runner's own conditional skip, and say why:
- `test.skipIf(condition)` or `ctx.skip(condition, note)` in Vitest;
- `test.skip(condition, reason)` in Playwright.

Never `return` early from a test body on an environment condition, such as the platform, an environment variable or a missing build: the runner reports that as a pass.

A test in the uncached tier (`*.uncached.test.*`) may not skip at all. That tier fails any run in which a test did not execute, and prints the rule for such tests (`test-support/uncached-tier-floor.ts`).

A skip keyed on CI (`process.env.CI`, `IS_CI` and the like) hides the test from the run that gates merges. It fails the guard unless `scripts/known-reds-allowlist.json` lists it with an `issue`, an `owner`, an `until` date, a `reason` and an `exit` (what removes it), each non-blank, the same five fields as any other temporary gate exception. An entry past its date is reported, not failed. Prefer to key the skip on the missing capability instead.<br>_[Recorded 2026-10-12 post-ship: before 2026-10-12 an allowlist entry needed only an owner, a date and a reason, with an optional `issue`, and one past its date failed the guard; the owner's decisions Q52 and 8A made a passed date reported and not failed, and 8A made `issue` required and added `exit`.]_

The guard follows a condition through names declared in the same file: a renamed or destructured `process.env`, a destructured `CI`, a constant key, a helper that takes no arguments and whose body is a single return expression, and `isCI` from `ci-info`. Anything else, such as a helper imported from another file, a longer helper body, a rest element or a nested destructuring, is labelled `unknown` and listed under "Gates with a condition the scanner cannot read", where a reviewer has to check it.

## A test not written yet

Use `test.todo('title')`.

## The listing

- `pnpm known-reds` prints the pins, the quarantines and the CI-keyed skips.
- `--all` adds every test that does not run, every environment gate, and each gate whose condition the scanner cannot read. Without it, those groups show only their counts.
- `--json` prints the full feed (`schemaVersion` 4).<br>_[Recorded 2026-10-12 post-ship: before 2026-10-12 the feed was `schemaVersion` 3, carried no `expired` list and reported a passed date as a `violation`; the owner's decisions Q52 and 8A made a passed date reported and not failed, which version 4's `expired` carries.]_

  Beyond the listing, it carries:
  - `expired` and `expiringSoon`: each pin, quarantine and allowlist entry past its `until`, or due within 14 days, with its owner and issue. An expired date is never a `violation`.
  - `atoms` on each CI skip and environment gate: the facts its condition reads, following each name to the declaration visible where the gate sits. Each is `{ kind, name, text }`, and `kind` is `platform`, `arch`, `uid`, `env`, `ci`, `fs`, `import`, `runtime` or `unknown`. `runtime` is a resolved read of `process.versions` or `process.release`, which keeps its full name, or of an `os` function with no narrower kind. `unknown` is anything the scanner cannot resolve, such as a helper imported from another file; the receiver and arguments of an unresolved call are still read, so `isTerminalPlatform(process.platform)` yields `unknown` and `platform`, and `process.env.DIR?.trim()` yields `unknown` and `env`.
  - `titles` on every pin and quarantine, and on each other entry scoped to a test or describe: the enclosing describe titles, ending with the entry's own declaration title, so a describe-scoped gate ends with its describe's title. A title that is not a string literal appears as `{ nonLiteral: <source> }`.
