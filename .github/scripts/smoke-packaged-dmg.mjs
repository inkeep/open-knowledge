#!/usr/bin/env node
/**
 * Packaged-DMG smoke driver — the shared engine behind both release gates.
 *
 * Mounts a `.dmg`, copies the `.app` out, runs the packaged Playwright subset
 * against the copy, and reports a TRI-STATE verdict:
 *
 *   pass  — the subset ran and every test passed.
 *   fail  — the subset ran and the app genuinely misbehaved.
 *   error — infrastructure: the DMG would not mount, the runner would not
 *           start, the report was unreadable, or nothing actually executed.
 *
 * The three-way split is the whole design. Collapsing `error` into `fail` lets
 * a runner outage masquerade as a product verdict; collapsing it into a hard
 * job failure would block the release path the selection gate is required
 * never to block. Callers decide what each state means for them; the driver
 * only decides which one is true.
 *
 * The zero-executed rule is the adversarial core: a DMG so broken that Electron
 * never launches produces an all-skipped run, and an all-skipped run reads
 * green to anyone counting failures. That is exactly the silent-failure shape
 * these gates exist to close, so zero executed is `error`, never `pass`.
 *
 * Usage: node .github/scripts/smoke-packaged-dmg.mjs <path-to.dmg>
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withMountedDmg } from './dmg-mount.mjs';

export const VERDICT = {
  pass: 'pass',
  fail: 'fail',
  error: 'error',
};

export const EXIT_CODES = {
  [VERDICT.pass]: 0,
  [VERDICT.fail]: 1,
  [VERDICT.error]: 2,
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = resolve(SCRIPT_DIR, '..', '..', 'packages', 'desktop');
const PACKAGED_CONFIG = 'playwright.packaged.config.ts';
const PACKAGED_REPORT = join('test-results', 'desktop-smoke-packaged-results.json');

/**
 * Pure verdict function. `report` is the parsed Playwright JSON report, or null
 * when it could not be read or parsed.
 */
export function classifyRun({ runExitCode, report, runnerError }) {
  if (runnerError) {
    return {
      verdict: VERDICT.error,
      reason: `the Playwright runner could not be started: ${runnerError}`,
    };
  }
  if (report === null || report === undefined) {
    return {
      verdict: VERDICT.error,
      reason:
        'the Playwright JSON report was missing or unparseable, so no verdict could be read from the run',
    };
  }
  const stats = report.stats ?? {};
  const expected = stats.expected ?? 0;
  const unexpected = stats.unexpected ?? 0;
  const flaky = stats.flaky ?? 0;
  const skipped = stats.skipped ?? 0;
  const executed = expected + unexpected + flaky;

  if (executed === 0) {
    return {
      verdict: VERDICT.error,
      reason: `no smoke test actually executed (${skipped} skipped) — an all-skipped run proves nothing about the DMG and must never read as a pass`,
    };
  }
  if (unexpected > 0) {
    return {
      verdict: VERDICT.fail,
      reason: `${unexpected} of ${executed} executed smoke tests failed against the packaged app`,
    };
  }
  if (runExitCode !== 0) {
    return {
      verdict: VERDICT.error,
      reason: `the Playwright runner exited ${runExitCode} with no failing test — treat as an infrastructure problem, not an app verdict`,
    };
  }
  return {
    verdict: VERDICT.pass,
    reason: `all ${executed} executed smoke tests passed against the packaged app (${flaky} flaky, ${skipped} skipped)`,
  };
}

/** GitHub annotation for a verdict. `fail` and `error` must read differently. */
export function annotationFor(verdict, reason, dmgPath) {
  if (verdict === VERDICT.pass) {
    return `::notice::DMG smoke PASSED for ${dmgPath} — ${reason}`;
  }
  if (verdict === VERDICT.fail) {
    return `::warning::DMG smoke FAILED (the app misbehaved) for ${dmgPath} — ${reason}`;
  }
  return `::warning::DMG smoke ERRORED (infrastructure, not an app verdict) for ${dmgPath} — ${reason}`;
}

/**
 * Publish the verdict. Writes `verdict=` / `reason=` to the step-output file
 * when GITHUB_OUTPUT is set; otherwise echoes the same pair to stdout so a
 * local run is still readable.
 */
export function publishVerdict({ verdict, reason }, deps = {}) {
  const env = deps.env ?? process.env;
  const appendFile = deps.appendFileSync ?? appendFileSync;
  const write = deps.writeStream ?? ((s) => process.stdout.write(s));
  // Newlines would corrupt the `key=value` step-output format, and every reason
  // this driver produces is a single sentence.
  const flat = String(reason).replace(/\r?\n/g, ' ');
  if (env.GITHUB_OUTPUT) {
    appendFile(env.GITHUB_OUTPUT, `verdict=${verdict}\nreason=${flat}\n`);
  } else {
    write(`verdict=${verdict}\nreason=${flat}\n`);
  }
}

async function defaultRunPlaywright(appPath, deps = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  return await new Promise((resolvePromise) => {
    const child = spawnImpl('pnpm', ['exec', 'playwright', 'test', '--config', PACKAGED_CONFIG], {
      cwd: DESKTOP_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        OK_DESKTOP_PACKAGED_APP: appPath,
        OK_DESKTOP_E2E_SMOKE: '1',
      },
    });
    child.on('exit', (code) => resolvePromise({ exitCode: code ?? 1 }));
    child.on('error', (err) => resolvePromise({ exitCode: 1, runnerError: err.message }));
  });
}

async function defaultReadReport(deps = {}) {
  const warn = deps.warn ?? ((msg) => process.stderr.write(`[smoke-packaged-dmg] ${msg}\n`));
  try {
    return JSON.parse(await readFile(join(DESKTOP_DIR, PACKAGED_REPORT), 'utf-8'));
  } catch (err) {
    // Non-fatal — `classifyRun` maps null to an `error` verdict. But four very
    // different causes collapse into that one generic reason (ENOENT: the
    // runner never launched; SyntaxError: the report was truncated; EPERM:
    // permissions; shape mismatch), and each wants a different response. The
    // responder reading a RELEASE BLOCKED page sees only the generic reason,
    // so this line is the only place the distinction survives.
    warn(`could not read ${PACKAGED_REPORT}: ${err?.message ?? String(err)}`);
    return null;
  }
}

/**
 * Mount, run, classify. Returns `{verdict, reason}`; never throws for a
 * mount/run failure — those become `error` verdicts.
 */
export async function smokePackagedDmg(dmgPath, deps = {}) {
  const withMount = deps.withMountedDmg ?? withMountedDmg;
  const runPlaywright = deps.runPlaywright ?? ((appPath) => defaultRunPlaywright(appPath, deps));
  const readReport = deps.readReport ?? (() => defaultReadReport(deps));

  try {
    return await withMount(
      dmgPath,
      async (appPath) => {
        const { exitCode, runnerError } = await runPlaywright(appPath);
        const report = await readReport(appPath);
        return classifyRun({ runExitCode: exitCode, report, runnerError });
      },
      deps,
    );
  } catch (err) {
    // The mount helper's failures (attach refused, no .app inside) are
    // infrastructure by construction — the DMG never got far enough to say
    // anything about the app.
    return {
      verdict: VERDICT.error,
      reason: `could not prepare the DMG for smoking: ${err?.message ?? String(err)}`,
    };
  }
}

export async function runDriver(argv, deps = {}) {
  const errStream = deps.errStream ?? ((s) => process.stderr.write(s));
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));

  const dmgPath = argv.slice(2).find((a) => !a.startsWith('-'));
  if (!dmgPath) {
    errStream('usage: smoke-packaged-dmg.mjs <path-to.dmg>\n');
    return EXIT_CODES[VERDICT.error];
  }

  const result = await smokePackagedDmg(dmgPath, deps);
  log(annotationFor(result.verdict, result.reason, dmgPath));
  publishVerdict(result, deps);
  // Fails closed: a workflow step that forgets to branch on the verdict still
  // stops the job on fail or error.
  return EXIT_CODES[result.verdict];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDriver(process.argv).then((code) => process.exit(code));
}
