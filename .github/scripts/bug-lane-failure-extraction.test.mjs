/**
 * Behavioral proof that the bug lane's failure extraction turns real tier
 * output into the names its refusal page prints.
 *
 * The extraction is inline bash in `bug-lane-verify.yml` rather than a helper
 * script, because that step runs against the SYNTHETIC tree — detached at the
 * stable — where a script added after that stable was cut does not exist. That
 * choice is right and it costs the step its testability, so this test lifts the
 * shipped snippet OUT of the workflow and runs it. Pasting a copy here would
 * pin a copy: the workflow could drift and this would stay green.
 *
 * Everything the page says on a red tier comes through this pipeline, and its
 * failure mode is silence — an empty list renders as "captured no failing test
 * or task name", which is the uninformative page the whole change exists to
 * stop sending.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'bug-lane-verify.yml'), 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'bug-lane-extraction-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The verify step's own shell options, lifted rather than pasted.
 *
 * `pipefail` is load-bearing for the chain below, not housekeeping: without it
 * `timeout … | tee "$RETRY_LOG"` reports tee's status, which is 0 whenever the
 * log is writable, so a genuinely red retry takes the `then` arm, clears
 * RETRY_STATUS, and mints a PASS that dispatches a release. Pasting a copy here
 * would supply the option the shipped step is supposed to prove it sets.
 */
function shellOptions() {
  const lines = workflow.split('\n');
  // Scoped to the verify step, not the file: other steps set their own options,
  // and finding one of those would let this step lose pipefail unnoticed --
  // which is the whole failure being guarded against.
  const step = lines.findIndex((line) => line.includes('- name: Verify the synthetic tree'));
  const next = lines.findIndex((line, i) => i > step && /^ {6}- name:/.test(line));
  const line = lines
    .slice(step, next === -1 ? undefined : next)
    .find((candidate) => candidate.trim().startsWith('set -'));
  // Separate messages because these are separate failures: a renamed step and a
  // dropped option need different fixes, and one diagnostic naming both would
  // report the wrong cause for whichever it was not.
  if (step === -1) {
    throw new Error(
      'bug-lane-verify.yml no longer has a step named "Verify the synthetic tree", so this test cannot find the shell options it runs under. Re-anchor on the current step name.',
    );
  }
  if (!line?.includes('pipefail')) {
    throw new Error(
      "bug-lane-verify.yml's verify step no longer sets pipefail — the retry status read depends on it, and without it a red retry mints a pass. Re-anchor this test rather than pasting the option back.",
    );
  }
  return line.trim();
}

/**
 * The extraction block, lifted verbatim from the workflow and dedented.
 *
 * Anchored on the first and last statements of the block rather than on line
 * numbers, and it throws when either anchor is missing — a silently empty
 * snippet would make every assertion below pass against nothing.
 */
function extractionSnippet() {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.includes("ESC=\"$(printf '\\033')\""));
  const end = lines.findIndex((line) => line.includes('FAILURES_JSON="$(printf'));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'bug-lane-verify.yml no longer contains the failure-extraction block this test lifts (ESC=… through FAILURES_JSON=…). Re-anchor this test on the current shape rather than deleting it.',
    );
  }
  const block = lines.slice(start, end + 1);
  const indent = block[0].length - block[0].trimStart().length;
  return block.map((line) => line.slice(indent)).join('\n');
}

/**
 * Lifts the WHOLE chain from an exit code to a verdict, starting at the
 * RETRY_STATUS seed rather than at the mapping, because the mapping is not
 * where a first-attempt blow is decided. That path never reaches the retry, so
 * its status has to be propagated across the case arm first; lifting only the
 * mapping and injecting RETRY_STATUS steps over that line entirely.
 *
 * Deleting it is the one mutation in this region that manufactures an
 * APPROVAL rather than a wrong page: RETRY_STATUS stays 0, the mapping does
 * not fire, and the `elif` mints verdict=pass with a warning claiming the
 * tiers passed on retry when no retry ran. The dispatch step gates on that
 * verdict, so the lane ships a point release off a tick that never finished.
 */
function verdictSnippet() {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'RETRY_STATUS=0');
  const end = lines.findIndex((line) => line.includes('TIER_VERDICT=could-not-verify ;; esac'));
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'bug-lane-verify.yml no longer contains the exit-code-to-verdict chain this test lifts (the RETRY_STATUS seed through the mapping arm). Re-anchor rather than deleting.',
    );
  }
  const block = lines.slice(start, end + 1);
  const indent = block[0].length - block[0].trimStart().length;
  return block.map((line) => line.slice(indent)).join('\n');
}

/**
 * Run the shipped chain for one FIRST_STATUS and return both the propagated
 * retry status and the verdict.
 *
 * Only the retry's INVOCATION is substituted, not the arm around it and not the
 * `| tee` it feeds -- so PIPESTATUS still has two elements, and the two
 * assignments that read its outcome are the shipped ones and actually execute.
 * Replacing the whole arm would excise `RETRY_STATUS="${PIPESTATUS[0]}"`, and
 * that line has the same failure mode this harness exists to catch: index it
 * `[1]` and it reads `tee`'s status, which is 0 whenever the log is writable,
 * so a genuinely red retry mints a PASS and the lane dispatches a release.
 * Nothing else in the repo executes it — the sibling shape assertions are all
 * textual.
 *
 * Anchored on `if timeout` rather than the bare word so the match cannot start
 * anywhere but the invocation, and so a future line above it cannot capture the
 * anchor away from the retry.
 *
 * The throw on a miss is what keeps the harness honest. `String.replace` returns
 * its input unchanged, so a drifted anchor would leave the real invocation in
 * the chain -- and the two budget-code cases never enter the retry arm at all,
 * so they would keep passing while testing a chain nobody had substituted.
 * Silently green is the failure mode worth refusing.
 */
function verdictFor(firstStatus, retryOutcome = 1) {
  const snippet = verdictSnippet();
  const chain = snippet.replace(
    /if timeout[\s\S]*?--output-logs=errors-only 2>&1/,
    `if (exit ${retryOutcome})`,
  );
  if (chain === snippet) {
    throw new Error(
      'verdictFor no longer matches the retry invocation in bug-lane-verify.yml — re-anchor rather than deleting.',
    );
  }
  const script = [
    shellOptions(),
    `FIRST_STATUS=${firstStatus}`,
    'RETRY_LOG=/dev/null',
    chain,
    'printf "%s %s" "$RETRY_STATUS" "$TIER_VERDICT"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(result.status, `chain exited ${result.status}: ${result.stderr}`).toBe(0);
  const [retryStatus, verdict] = result.stdout.split(' ');
  return { retryStatus, verdict };
}

/** Run the shipped snippet over a log file and return the JSON it emits. */
function extract(logContents, tierVerdict) {
  const logPath = join(scratch, `log-${Math.abs(hash(logContents))}.txt`);
  writeFileSync(logPath, logContents);
  const script = [
    // Pasted rather than lifted, unlike verdictFor above, because the option
    // cannot change what this returns: every pipe in the extraction block ends
    // in `|| true` or `|| echo`, so pipefail has nothing to propagate. Routing
    // it through shellOptions() would redden these six cases for a regression
    // they say nothing about.
    'set -euo pipefail',
    'RETRY_LOG="$1"',
    // Omitting these exercises the ordinary red-tier path: the snippet defaults
    // TIER_VERDICT, and the budget-blow branch it guards is simply not taken, so
    // the two variables that branch would read are never dereferenced.
    // 999 is deliberately not the shipped budget: this pins that the value
    // interpolates, not what it currently is, so re-sizing the real one cannot
    // leave a green test asserting a retired number.
    ...(tierVerdict === undefined
      ? []
      : [`TIER_VERDICT=${tierVerdict}`, 'RETRY_STATUS=124', 'TIER_BUDGET_SECONDS=999']),
    extractionSnippet(),
    'printf %s "$FAILURES_JSON"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script, 'extract', logPath], { encoding: 'utf8' });
  expect(result.status, `extraction exited ${result.status}: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

/** Stable scratch filenames without a random source. */
function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

const ESC = '\u001b';
/** Vitest's real FAIL line shape, escape codes and all. */
const failLine = (file, name) =>
  `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${file}${ESC}[2m > ${ESC}[22m${name}`;

describe('exit code to verdict', () => {
  // 124 is timeout's own signal. 137 is the SIGKILL --kill-after escalates to,
  // which fires precisely when a tier ignores SIGTERM -- so dropping it is the
  // realistic mutation, and it would reclassify a hard-killed run as a red tier
  // and page "failed TWICE, not flake-class" over a truncated failure list.
  test('both budget codes mint could-not-verify', () => {
    expect(verdictFor(124).verdict).toBe('could-not-verify');
    expect(verdictFor(137).verdict).toBe('could-not-verify');
  });

  // Asserted alongside the verdict because this is what the verdict is derived
  // FROM on a first-attempt blow, and it is the step the mapping cannot see.
  // Left at 0, the mapping never fires and the `elif` below mints a PASS.
  test('a first-attempt blow propagates its status past the retry arm', () => {
    expect(verdictFor(124).retryStatus).toBe('124');
    expect(verdictFor(137).retryStatus).toBe('137');
  });

  test('an ordinary failure still mints fail', () => {
    expect(verdictFor(1).verdict).toBe('fail');
    expect(verdictFor(2).verdict).toBe('fail');
  });

  // The success branch of the retry's if/else: a retry that succeeds must leave
  // the status clear, or an ordinary red tier that recovered would be refused.
  test('a recovered retry leaves nothing for the mapping to fire on', () => {
    expect(verdictFor(1, 0).retryStatus).toBe('0');
  });

  // Reading the wrong element of PIPESTATUS gives `tee`'s status, which is 0
  // whenever the log is writable -- so a doubly-red tick would mint a pass and
  // dispatch. This asserts the failing command's own status survives.
  test('a red retry reports its own status, not the tee it pipes into', () => {
    // The recovered-retry case above is the same FIRST_STATUS with the opposite
    // retryOutcome: there the retry succeeds and must clear the status, here it
    // fails and must report its own rather than the tee's.
    //
    // The verdict is deliberately not asserted. TIER_VERDICT starts at `fail`
    // and is only overridden on 124/137, so it reads `fail` under the shipped
    // line and under the mutant alike.
    expect(verdictFor(1, 1).retryStatus).toBe('1');
  });

  // The second route into could-not-verify, exercised nowhere before: the
  // first attempt fails ordinarily and the RETRY runs out of budget.
  test('a retry that blows its own budget still mints could-not-verify', () => {
    expect(verdictFor(1, 124).verdict).toBe('could-not-verify');
    expect(verdictFor(1, 137).verdict).toBe('could-not-verify');
  });
});

describe('bug-lane failure extraction', () => {
  test('names each failing vitest test, with the escape codes stripped', () => {
    const failures = extract(
      [
        failLine(
          'src/skill-bundles.test.ts',
          'every bundle has a SKILL.md on disk whose frontmatter name matches',
        ),
        failLine('src/acp/thread-socket.test.ts', 'rename round-trips'),
        ' Test Files  2 failed | 474 passed | 16 skipped (492)',
      ].join('\n'),
    );
    expect(failures).toHaveLength(2);
    expect(failures).toContain(
      'src/skill-bundles.test.ts > every bundle has a SKILL.md on disk whose frontmatter name matches',
    );
    expect(failures.join('\n')).not.toContain(ESC);
  });

  // A budget blow is the one red verdict that is NOT evidence about the batch.
  // The lane's whole reason to exist is paging correctly, and the incident that
  // prompted this wrapper was a refusal that read as a bad fix. So the page must
  // say "could not verify" even though the log underneath is full of real FAIL
  // lines from tiers that did finish before the clock ran out.
  test('replaces the named failures when the attempt ran out of budget', () => {
    const log = [
      failLine('src/acp/thread-socket.test.ts', 'rename round-trips'),
      ' Test Files  1 failed | 474 passed (492)',
    ].join('\n');

    const failures = extract(log, 'could-not-verify');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('did not finish within 999s');
    // The exit code separates a clean timeout from a SIGKILL escalation, which
    // is the difference between a slow tier and one that ignored the signal.
    expect(failures[0]).toContain('exit 124');
    // The point of the override: no test name survives to be blamed.
    expect(failures[0]).not.toContain('thread-socket');
  });

  // The override must fire ONLY on the budget codes. An ordinary red tier is
  // still the common case and must keep naming what went red.
  test('leaves an ordinary red tier naming its failures', () => {
    const failures = extract(
      failLine('src/acp/thread-socket.test.ts', 'rename round-trips'),
      'fail',
    );
    expect(failures).toEqual(['src/acp/thread-socket.test.ts > rename round-trips']);
  });

  // A typecheck failure prints no FAIL line at all, so the fallback is the only
  // thing standing between that verdict and an empty page.
  test('falls back to the one turbo line that names the failing task', () => {
    const failures = extract(
      [
        '::error::command (/home/runner/work/ok/ok/packages/core) pnpm run typecheck exited (1)',
        '@inkeep/open-knowledge-core#typecheck:  ERROR  command (/home/runner/work/ok/ok/packages/core) pnpm run typecheck exited (1)',
        ' ERROR  run failed: command  exited (1)',
      ].join('\n'),
    );
    // One failing task, one bullet: the ::error:: line duplicates it and the
    // run-failed line names nothing, so matching all three would pad the page.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@inkeep/open-knowledge-core#typecheck');
  });

  // A tier can go red and still match neither pattern — a runner OOM, a
  // truncated log, an output shape a turbo upgrade changed. The block has to
  // hand back a well-formed empty array rather than abort, because aborting
  // fails the step and the paging step that follows has no `if: always()`.
  // (The install-failure path is NOT this case: it exits the step before this
  // block is reached, so it never sets the `failures` output at all, and the
  // page's empty list comes from the paging step defaulting an unset env var
  // to `[]`.)
  test('yields an empty array when nothing matches, without failing the step', () => {
    expect(extract('')).toEqual([]);
    expect(extract('some unrelated log output\nwith no failures\n')).toEqual([]);
  });

  test('prefers the vitest names over the turbo lines when a log carries both', () => {
    const failures = extract(
      [
        failLine('src/thing.test.ts', 'a case'),
        '@inkeep/open-knowledge-server#test:  ERROR  command (…) exited (1)',
      ].join('\n'),
    );
    expect(failures).toEqual(['src/thing.test.ts > a case']);
  });
});
