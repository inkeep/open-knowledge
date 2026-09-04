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

function shellOptions() {
  const lines = workflow.split('\n');
  const step = lines.findIndex((line) => line.includes('- name: Verify the synthetic tree'));
  const next = lines.findIndex((line, i) => i > step && /^ {6}- name:/.test(line));
  const line = lines
    .slice(step, next === -1 ? undefined : next)
    .find((candidate) => candidate.trim().startsWith('set -'));
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

function extract(logContents, tierVerdict) {
  const logPath = join(scratch, `log-${Math.abs(hash(logContents))}.txt`);
  writeFileSync(logPath, logContents);
  const script = [
    'set -euo pipefail',
    'RETRY_LOG="$1"',
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

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

const ESC = '\u001b';
const failLine = (file, name) =>
  `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${file}${ESC}[2m > ${ESC}[22m${name}`;

describe('exit code to verdict', () => {
  test('both budget codes mint could-not-verify', () => {
    expect(verdictFor(124).verdict).toBe('could-not-verify');
    expect(verdictFor(137).verdict).toBe('could-not-verify');
  });

  test('a first-attempt blow propagates its status past the retry arm', () => {
    expect(verdictFor(124).retryStatus).toBe('124');
    expect(verdictFor(137).retryStatus).toBe('137');
  });

  test('an ordinary failure still mints fail', () => {
    expect(verdictFor(1).verdict).toBe('fail');
    expect(verdictFor(2).verdict).toBe('fail');
  });

  test('a recovered retry leaves nothing for the mapping to fire on', () => {
    expect(verdictFor(1, 0).retryStatus).toBe('0');
  });

  test('a red retry reports its own status, not the tee it pipes into', () => {
    expect(verdictFor(1, 1).retryStatus).toBe('1');
  });

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

  test('replaces the named failures when the attempt ran out of budget', () => {
    const log = [
      failLine('src/acp/thread-socket.test.ts', 'rename round-trips'),
      ' Test Files  1 failed | 474 passed (492)',
    ].join('\n');

    const failures = extract(log, 'could-not-verify');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('did not finish within 999s');
    expect(failures[0]).toContain('exit 124');
    expect(failures[0]).not.toContain('thread-socket');
  });

  test('leaves an ordinary red tier naming its failures', () => {
    const failures = extract(
      failLine('src/acp/thread-socket.test.ts', 'rename round-trips'),
      'fail',
    );
    expect(failures).toEqual(['src/acp/thread-socket.test.ts > rename round-trips']);
  });

  test('falls back to the one turbo line that names the failing task', () => {
    const failures = extract(
      [
        '::error::command (/home/runner/work/ok/ok/packages/core) pnpm run typecheck exited (1)',
        '@inkeep/open-knowledge-core#typecheck:  ERROR  command (/home/runner/work/ok/ok/packages/core) pnpm run typecheck exited (1)',
        ' ERROR  run failed: command  exited (1)',
      ].join('\n'),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('@inkeep/open-knowledge-core#typecheck');
  });

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
