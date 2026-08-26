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

/** Run the shipped snippet over a log file and return the JSON it emits. */
function extract(logContents) {
  const logPath = join(scratch, `log-${Math.abs(hash(logContents))}.txt`);
  writeFileSync(logPath, logContents);
  const script = [
    'set -euo pipefail',
    'RETRY_LOG="$1"',
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
