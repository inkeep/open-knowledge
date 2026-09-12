import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFuseFailure,
  FUSE_FAILURE_MARKER,
} from '../../packages/desktop/scripts/packaging-diagnostics.mjs';
import {
  classifyEvidence,
  computeRetryDelayMs,
  createOwnedTreeController,
  DEFAULT_MAX_ATTEMPTS,
  FailureEvidence,
  parseArgs,
  runWithRetry,
} from './retry-transient.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, '.github', 'scripts', 'retry-transient.mjs');
const afterPackSource = readFileSync(
  join(REPO_ROOT, 'packages', 'desktop', 'scripts', 'afterPack.mjs'),
  'utf8',
);
const afterSignSource = readFileSync(
  join(REPO_ROOT, 'packages', 'desktop', 'scripts', 'afterSign.mjs'),
  'utf8',
);
const desktopRelease = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'desktop-release.yml'),
  'utf8',
);
const WORKFLOW_JOBS = [
  ['build-macos', '65', '30m', 'Build + sign + notarize DMG/ZIP'],
  ['build-windows', '35', '15m', 'Package NSIS installers (x64 + arm64, signed)'],
  ['build-linux', '35', '15m', 'Package $' + '{{ matrix.targets }}'],
];
const workflowJob = (name) => {
  const start = desktopRelease.indexOf(`\n  ${name}:`);
  if (start === -1) throw new Error(`missing job ${name}`);
  const rest = desktopRelease.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};
const workflowStep = (body, name) => {
  const start = body.indexOf(`- name: ${name}`);
  if (start === -1) throw new Error(`missing step ${name}`);
  const rest = body.slice(start);
  const ends = [rest.indexOf('\n      - name: ', 1), rest.indexOf('\n      - uses: ', 1)].filter(
    (index) => index !== -1,
  );
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
};
const workflowTiming = ([jobName, , , packageName]) => {
  const body = workflowJob(jobName);
  const budget = /PACKAGING_BUDGET_MINUTES: "(\d+)"/.exec(
    workflowStep(body, 'Start packaging deadline'),
  )?.[1];
  const timeout = /--attempt-timeout "(\d+)m"/.exec(workflowStep(body, packageName))?.[1];
  if (!budget || !timeout) throw new Error(`missing workflow timing for ${jobName}`);
  return { budgetMs: Number(budget) * 60_000, attemptTimeoutMs: Number(timeout) * 60_000 };
};
const scratch = mkdtempSync(join(tmpdir(), 'retry-transient-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

const nodeCmd = (src) => [process.execPath, '-e', src];
const sourceSection = (source, start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex === -1 || endIndex === -1) throw new Error(`missing source section: ${start}`);
  return source.slice(startIndex, endIndex);
};
const throwTargets = (source) =>
  new Set(
    [...source.matchAll(/\bthrow\s+((?:new\s+)?[A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
  );
const run = (overrides = {}) => {
  const lines = [];
  const now = Date.now();
  return runWithRetry({
    command: nodeCmd('process.exit(0)'),
    deadlineEpochMs: now + 120_000,
    attemptTimeoutMs: 10_000,
    cleanupReserveMs: 100,
    cleanupGraceMs: 20,
    pollIntervalMs: 2,
    sleepFn: () => Promise.resolve(),
    randomFn: () => 0,
    log: (line) => lines.push(line),
    ...overrides,
  }).then((result) => ({ ...result, lines, log: lines.join('\n') }));
};

const inspect = (text, options) => {
  const evidence = new FailureEvidence(options);
  evidence.ingest(Buffer.from(text));
  evidence.finish();
  return { evidence, classification: classifyEvidence(evidence) };
};

describe('failure evidence classification', () => {
  test.each([408, 429, 500, 502, 503, 504, 521, 522, 524])(
    'classifies structured HTTP %s as transient',
    (status) => {
      expect(inspect(`HTTPError: Response code ${status} (service response)`).classification).toBe(
        'transient',
      );
    },
  );

  test.each(['502 Bad Gateway', '503 Service Unavailable', '504 Gateway Time-out'])(
    'keeps structured status-line coverage: %s',
    (text) => {
      expect(inspect(text).classification).toBe('transient');
    },
  );

  test.each([
    'getaddrinfo EAI_AGAIN github.com',
    'getaddrinfo ENOTFOUND github.com',
    'connect ECONNREFUSED 127.0.0.1:443',
    'connect ENETUNREACH 10.0.0.1:443',
    'connect EHOSTUNREACH 10.0.0.1:443',
    'read ECONNABORTED',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'write EPIPE',
    'cause: UND_ERR_CONNECT_TIMEOUT',
    'cause: UND_ERR_HEADERS_TIMEOUT',
    'cause: UND_ERR_BODY_TIMEOUT',
    'cause: UND_ERR_SOCKET',
    'curl: (28) Operation timed out',
    'curl: (56) Recv failure: Connection reset by peer',
  ])('classifies scoped network evidence as transient: %s', (text) => {
    expect(inspect(text).classification).toBe('transient');
  });

  test.each([-1001, -1003, -1004, -1005, -1006, -1008, -1009, -1011])(
    'classifies NSURLErrorDomain Code=%s as transient',
    (code) => {
      expect(inspect(`Error Domain=NSURLErrorDomain Code=${code}`).classification).toBe(
        'transient',
      );
    },
  );

  test.each([-1201, -1202, -1203, -1204, -1205, -1206])(
    'classifies bare NSURLErrorDomain TLS trust Code=%s as terminal',
    (code) => {
      expect(inspect(`Error Domain=NSURLErrorDomain Code=${code}`).classification).toBe('terminal');
    },
  );

  test('leaves generic NSURLErrorDomain secure-connection failure unknown', () => {
    expect(inspect('Error Domain=NSURLErrorDomain Code=-1200').classification).toBe('unknown');
  });

  test.each([
    'A timestamp was expected but was not found',
    'The timestamp service is not available',
    'HTTPError(statusCode: nil)',
    'The request timed out',
    'The network connection was lost',
    'Could not connect to the server',
    'socket hang up',
    'Client network socket disconnected before secure TLS connection was established',
    'unexpected EOF',
    'You have exceeded a secondary rate limit',
    'abuse detection mechanism',
    'was submitted too quickly',
  ])('keeps narrow transient phrase coverage: %s', (text) => {
    expect(inspect(text).classification).toBe('transient');
  });

  test.each([
    'HTTP 401 Unauthorized',
    'HTTP 400 Bad Request',
    'HTTPError: Response code 422 (Unprocessable Entity)',
    'response status: 404',
    'statusCode=413',
    'error TS2345: Argument of type string is not assignable',
    'electron-vite build failed',
    'Invalid configuration object',
    'configuration is invalid',
    '⨯ Invalid configuration object. electron-builder 26.0.1 has been initialized using a configuration object that does not match the API schema.',
    'Error: unknown option "--foo"',
    ' ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date',
    'authentication failed for signing service',
    'invalid credentials supplied to Azure Trusted Signing',
    'The specified item could not be found in the keychain',
    'certificate has expired',
    'certificate not trusted',
    'notarization failed with status: Invalid',
    'notarytool submission completed\nstatus: Invalid',
    'notarytool submission completed\n{"status":"Invalid"}',
    'entitlement com.apple.security.foo is not permitted',
    'Electron fuse verification failed',
    '[afterSign] fuse verification failed (D17 paranoid check):\n  RunAsNode: expected ENABLE (target=true), got DISABLE [OK_PACKAGING_FUSE_FAILURE]',
    '[afterSign] fuse verification read failed on /tmp/OpenKnowledge: EACCES [OK_PACKAGING_FUSE_FAILURE]',
    '[afterPack] fuse flip failed on /tmp/OpenKnowledge: Could not find sentinel [OK_PACKAGING_FUSE_FAILURE]',
    'Electron fuse mismatch',
    'Electron fuse mismatches target',
    'Electron fuse mismatched target',
    'integrity check failed: checksum mismatch',
    'sha512 checksum mismatch, expected AAA, got BBB',
    'sha512 hash mismatch, expected AAA, got BBB',
    'Error: Cannot find module ./missing',
    'bash: pnpm: command not found',
    'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "electron-builder" not found',
    'spawn electron-builder ENOENT',
    'ENOSPC: no space left on device',
  ])('classifies explicit terminal evidence as terminal: %s', (text) => {
    expect(inspect(text).classification).toBe('terminal');
  });

  test('classifies errors from the owned fuse-failure factory', () => {
    const error = createFuseFailure('fuse detail changed');
    expect(error.message).toBe(`fuse detail changed [${FUSE_FAILURE_MARKER}]`);
    expect(inspect(error.message).classification).toBe('terminal');
  });

  test('routes every throw in the owned fuse functions through the shared factory', () => {
    const afterPackFuseFunction = sourceSection(
      afterPackSource,
      'async function flipElectronFuses',
      '\n\nexport default async function afterPack',
    );
    const afterSignFuseFunction = sourceSection(
      afterSignSource,
      'async function verifyFuses',
      '\n\nexport default async function afterSign',
    );
    expect(throwTargets(afterPackFuseFunction)).toEqual(new Set(['createFuseFailure']));
    expect(throwTargets(afterSignFuseFunction)).toEqual(new Set(['createFuseFailure']));
  });

  test.each([
    '[afterSign] getCurrentFuseWire failed on /tmp/OpenKnowledge: EACCES',
    '[afterSign] Fuse verification failed (D17 paranoid check):\n  RunAsNode: expected ENABLE (target=true), got DISABLE',
    '[afterPack] fuse flip failed on /tmp/OpenKnowledge: Could not find sentinel',
  ])('classifies old-tag fuse failures without the owned marker: %s', (text) => {
    expect(inspect(text).classification).toBe('terminal');
  });

  test.each([
    'warning: optional tool: command not found\nsocket hang up',
    'download retry noted checksum mismatch\nECONNRESET',
    'warning: unknown option "--foo"\nsocket hang up',
  ])('does not let incidental terminal-like prose outrank network evidence: %s', (text) => {
    expect(inspect(text).classification).toBe('transient');
  });

  test.each([
    '[afterSign] fuse verification passed — all 6 fuses match targetFuses',
    '[afterSign] fuse verification done; no notarize step on platform "linux"',
    '[afterSign] signed + notarized + stapled + fuse-verified successfully',
    '[afterPack] skipping per-arch temp "/tmp/app-temp" — fuses flip on the merged universal app',
    '[afterPack] flipping fuses on /tmp/OpenKnowledge',
    '[afterPack] fuses flipped successfully; electron-builder will re-sign next',
    '[afterPack] fuses done; skipping darwin-only helper-bundle + node-pty steps on "linux"',
    'fuse: failed to exec fusermount: No such file or directory',
  ])('does not classify excluded fuse output as terminal: %s', (text) => {
    expect(inspect(`${text}\nHTTP 500`).classification).toBe('transient');
  });

  test.each(['unknown option "--foo"', 'bash: pnpm: command not found'])(
    'does not treat a chunk-carry boundary as a line boundary: %s',
    (phrase) => {
      const evidence = new FailureEvidence();
      evidence.ingest(
        Buffer.from(`${'x'.repeat(2048)}${phrase}${'y'.repeat(2048 - phrase.length)}`),
      );
      evidence.ingest(Buffer.from('\nsocket hang up'));
      evidence.finish();
      expect(classifyEvidence(evidence)).toBe('transient');
    },
  );

  test('does not treat a chunk-carry boundary as a module-error line start', () => {
    const phrase = 'Error: Cannot find module ./missing';
    const evidence = new FailureEvidence();
    evidence.ingest(Buffer.from(`${'x'.repeat(2048)}${phrase}${'y'.repeat(2048 - phrase.length)}`));
    evidence.ingest(Buffer.from('\nsocket hang up'));
    evidence.finish();
    expect(classifyEvidence(evidence)).toBe('transient');
  });

  test('does not treat a chunk-carry boundary as a decorated-status line start', () => {
    const phrase = '⨯ 502 Bad Gateway';
    const evidence = new FailureEvidence();
    evidence.ingest(Buffer.from(`${'x'.repeat(2048)}${phrase}${'y'.repeat(2048 - phrase.length)}`));
    evidence.finish();
    expect(classifyEvidence(evidence)).toBe('unknown');
  });

  test.each([
    ['Error: unknown option "--foo"', 'terminal'],
    ['Error: Cannot find module ./missing', 'terminal'],
    ['bash: pnpm: command not found', 'terminal'],
    ['⨯ 502 Bad Gateway', 'transient'],
  ])('retains a real line boundary across chunks: %s', (line, classification) => {
    const evidence = new FailureEvidence();
    evidence.ingest(Buffer.from('progress without a newline'));
    evidence.ingest(Buffer.from(`\n${line}`));
    evidence.finish();
    expect(classifyEvidence(evidence)).toBe(classification);
  });

  test('distinguishes permission-denied and rate-limited HTTP 403', () => {
    expect(inspect('HTTP 403 Forbidden').classification).toBe('terminal');
    expect(inspect('HTTP 403 Forbidden\nsecondary rate limit exceeded').classification).toBe(
      'transient',
    );
    expect(inspect('HTTP 403 Forbidden\nRetry-After: 45').classification).toBe('terminal');
    expect(inspect('HTTP 403 Forbidden\nX-RateLimit-Remaining: 0').classification).toBe(
      'transient',
    );
    expect(inspect('HTTP 403 Forbidden\nRetry-After: tomorrow').classification).toBe('terminal');
  });

  test.each(['⨯ 502 Bad Gateway', 'Error: 503 Service Unavailable'])(
    'accepts explicit decorated status lines: %s',
    (text) => expect(inspect(text).classification).toBe('transient'),
  );

  test('rejects arbitrary decorated status lines', () => {
    expect(inspect('download failed: 502 Bad Gateway').classification).toBe('unknown');
  });

  test('matched reasons follow classifier precedence for mixed evidence', async () => {
    const terminal = await run({
      command: nodeCmd('console.error("certificate has expired\\nHTTP 404");process.exit(1)'),
    });
    expect(terminal.log).toContain('reason=rule:certificate outcome=terminal');
    expect(terminal.log).not.toContain('reason=http:404');
    const downloadIntegrity = await run({
      command: nodeCmd(
        'console.error("sha512 checksum mismatch, expected AAA, got BBB");process.exit(1)',
      ),
    });
    expect(downloadIntegrity.log).toContain('reason=rule:download-integrity outcome=terminal');
    const maskedIntegrity = await run({
      command: nodeCmd(
        'console.error("sha512 checksum mismatch, expected AAA, got BBB\\nrejected entitlements for app");process.exit(1)',
      ),
    });
    expect(maskedIntegrity.log).toContain('reason=rule:entitlement outcome=terminal');
    const maskedTlsTrust = await run({
      command: nodeCmd(
        'console.error("sha512 checksum mismatch, expected AAA, got BBB\\nError Domain=NSURLErrorDomain Code=-1202");process.exit(1)',
      ),
    });
    expect(maskedTlsTrust.log).toContain('reason=rule:tls-trust outcome=terminal');
    expect(maskedTlsTrust.log).not.toContain('rule:download-integrity');
    const tlsTrustWithSymptom = await run({
      command: nodeCmd(
        'console.error("Error Domain=NSURLErrorDomain Code=-1202\\nError: Exit code: ENOENT. spawn /Users/runner/Library/Caches/electron-builder/app-builder/app-builder ENOENT");process.exit(1)',
      ),
    });
    expect(tlsTrustWithSymptom.log).toContain('reason=rule:tls-trust outcome=terminal');
    const tlsTrustWithIntegrity = await run({
      command: nodeCmd(
        'console.error("Error Domain=NSURLErrorDomain Code=-1202\\nintegrity check failed");process.exit(1)',
      ),
    });
    expect(tlsTrustWithIntegrity.log).toContain('reason=rule:tls-trust outcome=terminal');
    const notarizationInvalidWithTlsNoise = await run({
      command: nodeCmd(
        'console.error("Error Domain=NSURLErrorDomain Code=-1202");console.error(`Failed to notarize via notarytool\\n{"id":"abc","status":"Invalid","message":"Processing complete"}`);process.exit(1)',
      ),
    });
    expect(notarizationInvalidWithTlsNoise.log).toContain(
      'reason=rule:notarization-invalid outcome=terminal',
    );
    const fuseFailure = await run({
      command: nodeCmd(
        'console.error("[afterPack] fuse flip failed on /tmp/OpenKnowledge: Could not find sentinel [OK_PACKAGING_FUSE_FAILURE]");process.exit(1)',
      ),
    });
    expect(fuseFailure.log).toContain('reason=rule:fuse outcome=terminal');
    const d17FuseFailure = await run({
      command: nodeCmd(
        'console.error("[afterSign] fuse verification failed (D17 paranoid check):\\n  RunAsNode: expected ENABLE (target=true), got DISABLE [OK_PACKAGING_FUSE_FAILURE]");process.exit(1)',
      ),
    });
    expect(d17FuseFailure.log).toContain('reason=rule:fuse outcome=terminal');
    const diskFull = await run({
      command: nodeCmd(
        'console.error("ENOSPC: no space left on device\\nintegrity check failed");process.exit(1)',
      ),
    });
    expect(diskFull.log).toContain('reason=rule:disk-full outcome=terminal');
    const diskFullWithCertificate = await run({
      command: nodeCmd(
        'console.error("certificate has expired\\nENOSPC: no space left on device");process.exit(1)',
      ),
    });
    expect(diskFullWithCertificate.log).toContain('reason=rule:disk-full outcome=terminal');
    const signedIntegrity = await run({
      command: nodeCmd(
        'console.error("integrity check failed: code signature invalid");process.exit(1)',
      ),
    });
    expect(signedIntegrity.log).toContain('reason=rule:integrity outcome=terminal');
    expect(signedIntegrity.log).not.toContain('download-integrity');
    const transient = await run({
      command: nodeCmd('console.error("ECONNRESET\\nHTTP 503");process.exit(1)'),
      maxAttempts: 1,
    });
    expect(transient.log).toContain('reason=code:ECONNRESET');
    expect(transient.log).not.toContain('reason=http:503');
  });

  test.each([
    'earlier warning: ECONNRESET\nnotarization failed with status: Invalid',
    'certificate has expired\nlater warning: socket hang up',
  ])('terminal evidence dominates transient evidence in either order', (text) => {
    expect(inspect(text).classification).toBe('terminal');
  });

  test('deletes broad CFNetwork matching and retains byte-capped early evidence', () => {
    expect(
      inspect('Error Domain=kCFErrorDomainCFNetwork Code=-1202 certificate not trusted')
        .classification,
    ).toBe('terminal');
    expect(inspect('Error Domain=NSURLErrorDomain Code=-1202').classification).toBe('terminal');
    const evidence = new FailureEvidence({ maxTailBytes: 19 });
    evidence.ingest(Buffer.from('certificate has expired\n'));
    evidence.ingest(Buffer.from('🙂'.repeat(100)));
    evidence.finish();
    expect(classifyEvidence(evidence)).toBe('terminal');
    expect(Buffer.byteLength(evidence.tail, 'utf8')).toBeLessThanOrEqual(19);
    expect(evidence.tail).not.toContain('certificate');
  });

  test('does not consume the first-line anchor on an empty chunk', () => {
    const evidence = new FailureEvidence();
    evidence.ingest(Buffer.alloc(0));
    evidence.ingest(Buffer.from('Error: unknown option "--publish"'));
    evidence.finish();
    expect(classifyEvidence(evidence)).toBe('terminal');
  });

  test('leaves unrelated failures unknown', () => {
    expect(inspect('packager exited without a diagnostic').classification).toBe('unknown');
  });
});

describe('retry state machine', () => {
  test('success runs once and terminal evidence never retries', async () => {
    expect(await run({ command: nodeCmd('console.log("built")') })).toMatchObject({
      ok: true,
      attempts: 1,
    });
    const terminal = await run({
      command: nodeCmd(
        'console.error("socket hang up");console.error("notarization failed with status: Invalid");process.exit(1)',
      ),
    });
    expect(terminal).toMatchObject({ ok: false, reason: 'terminal', attempts: 1 });
    expect(terminal.log).toContain(
      'decision=stop reason=rule:notarization-invalid outcome=terminal attempt=1/3 code=1 signal=none',
    );
  });

  test('shell mode executes the workflow command with Bash', async () => {
    expect(await run({ command: ['true && printf composed'], shell: true })).toMatchObject({
      ok: true,
      attempts: 1,
    });
  });

  test('transient failures retry within three total attempts and can recover', async () => {
    const count = join(scratch, 'transient-recovery-count');
    writeFileSync(count, '0');
    const result = await run({
      command: nodeCmd(
        `const fs=require('fs');const p=${JSON.stringify(count)};const n=+fs.readFileSync(p,'utf8')+1;fs.writeFileSync(p,String(n));if(n<3){console.error('HTTPError: Response code 500 (Internal Server Error)');process.exit(1)}`,
      ),
    });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(readFileSync(count, 'utf8')).toBe('3');
    expect(result.log).toContain(
      'decision=retry reason=http:500 classification=transient attempt=1/3 code=1 signal=none',
    );
  });

  test('persistent transient failure stops at the total-attempt bound', async () => {
    const result = await run({
      command: nodeCmd('console.error("socket hang up");process.exit(1)'),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'transient-exhausted',
      attempts: DEFAULT_MAX_ATTEMPTS,
    });
    expect(result.log).toContain('outcome=transient-exhausted');
  });

  test('one unknown can recover but a second unknown stops', async () => {
    const count = join(scratch, 'unknown-recovery-count');
    writeFileSync(count, '0');
    const recovered = await run({
      command: nodeCmd(
        `const fs=require('fs');const p=${JSON.stringify(count)};const n=+fs.readFileSync(p,'utf8')+1;fs.writeFileSync(p,String(n));if(n===1){console.error('unrecognized packager failure');process.exit(1)}`,
      ),
    });
    expect(recovered).toMatchObject({ ok: true, attempts: 2, recoveredFrom: 'unknown' });
    expect(recovered.log).toContain(
      'decision=retry reason=diagnostic:unknown classification=unknown attempt=1/3 code=1 signal=none',
    );
    expect(recovered.log).toContain(
      'UNKNOWN_CLASSIFICATION_RETRY allowance=invocation-wide-single-use',
    );
    const exhausted = await run({
      command: nodeCmd('console.error("unrecognized packager failure");process.exit(1)'),
    });
    expect(exhausted).toMatchObject({ ok: false, reason: 'unknown-exhausted', attempts: 2 });
    expect(exhausted.log).toContain('outcome=unknown-exhausted');
    const bounded = await run({
      command: nodeCmd('console.error("unrecognized packager failure");process.exit(1)'),
      maxAttempts: 1,
    });
    expect(bounded).toMatchObject({ ok: false, reason: 'unknown-exhausted', attempts: 1 });
    expect(bounded.log).toContain('outcome=unknown-exhausted');
  });

  test('the unknown allowance is shared across a mixed sequence', async () => {
    const count = join(scratch, 'mixed-count');
    writeFileSync(count, '0');
    const result = await run({
      command: nodeCmd(
        `const fs=require('fs');const p=${JSON.stringify(count)};const n=+fs.readFileSync(p,'utf8')+1;fs.writeFileSync(p,String(n));console.error(n===2?'socket hang up':'unrecognized packager failure');process.exit(1)`,
      ),
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown-exhausted', attempts: 3 });
    expect(result.log).toContain('outcome=unknown-exhausted');
  });

  test('spawn failure and child signals are process-control stops', async () => {
    const spawnFailed = await run({ command: ['definitely-not-a-real-binary-xyz'] });
    expect(spawnFailed).toMatchObject({
      ok: false,
      reason: 'spawn-failure',
      attempts: 1,
    });
    expect(spawnFailed.log).toContain('outcome=spawn-failure');
    expect(spawnFailed.log).not.toContain('cleanup=');
    const signalled = await run({ command: nodeCmd('process.kill(process.pid, "SIGTERM")') });
    expect(signalled).toMatchObject({
      ok: false,
      reason: 'child-signal',
      attempts: 1,
      signal: 'SIGTERM',
    });
    expect(signalled.log).toContain(
      'decision=stop reason=control:child-signal outcome=child-signal attempt=1/3 code=none signal=SIGTERM',
    );
  });

  test('the re-emitted bounded tail is redacted and workflow-command safe', async () => {
    const secret = 'super-secret-output-value';
    const sensitive = [
      `CSC_KEY_PASSWORD=${secret}`,
      `Authorization: Bearer ${secret}`,
      `"api_key": "${secret}"`,
      '-----BEGIN PRIVATE KEY-----',
      'private-body',
      '-----END PRIVATE KEY-----',
      '::error::injected',
      '##[error]legacy-injected',
    ].join('\n');
    const result = await run({
      command: nodeCmd(`console.error(${JSON.stringify(sensitive)});process.exit(1)`),
      maxAttempts: 1,
    });
    expect(result.log).toContain(
      'reason=diagnostic:unknown outcome=unknown-exhausted attempt=1/1 code=1 signal=none',
    );
    expect(result.log).toContain('::group::command bounded failure diagnostic');
    expect(result.log).toContain('| CSC_KEY_PASSWORD=[REDACTED]');
    expect(result.log).toContain('| Authorization: [REDACTED]');
    expect(result.log).toContain('| "api_key": [REDACTED]');
    expect(result.log).toContain('| [REDACTED PEM]');
    expect(result.log).toContain('| ::error::injected');
    expect(result.log).not.toContain('\n::error::injected');
    expect(result.log).toContain('| # #[error]legacy-injected');
    expect(result.log).not.toContain('##[');
    expect(result.log).not.toContain(secret);
    expect(result.log).not.toContain('private-body');
    expect(result).not.toHaveProperty('diagnosticTail');
  });

  test('the live child stream remains verbatim before the bounded duplicate', async () => {
    const marker = 'PUBLIC_TRANSCRIPT_MARKER';
    const result = await run({
      command: nodeCmd(`console.error(${JSON.stringify(marker)});process.exit(1)`),
      maxAttempts: 1,
    });
    const liveStderr = process.stderr.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(liveStderr).toContain(marker);
    expect(result.log).toContain(`| ${marker}`);
  });

  test('production diagnostic output remains byte bounded', async () => {
    const result = await run({
      command: nodeCmd(
        `console.error(${JSON.stringify(`rolled-off-marker\n${'x'.repeat(40_000)}\nfinal-marker`)});process.exit(1)`,
      ),
      maxAttempts: 1,
    });
    expect(result.log).not.toContain('rolled-off-marker');
    expect(result.log).toContain('final-marker');
    expect(Buffer.byteLength(result.log, 'utf8')).toBeLessThan(18_000);
  });

  test('unproven cleanup stops before diagnostic classification', async () => {
    const result = await run({
      command: nodeCmd('console.error("socket hang up");process.exit(1)'),
      treeController: { cleanup: async () => ({ ok: false, reason: 'tree-survived-kill' }) },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'cleanup-failure',
      cleanup: 'tree-survived-kill',
      attempts: 1,
    });
    expect(result.log).toContain('cleanup=tree-survived-kill');
  });

  test('exit zero with unproven cleanup fails closed', async () => {
    const result = await run({
      command: nodeCmd('process.exit(0)'),
      treeController: { cleanup: async () => ({ ok: false, reason: 'close-not-observed' }) },
    });
    expect(result).toMatchObject({ ok: false, reason: 'cleanup-failure', attempts: 1 });
    expect(result.log).toContain('reason=control:cleanup-failure outcome=cleanup-failure');
    expect(result.log).toContain('cleanup=close-not-observed');
  });

  test('retry warning emits only when a retry is actually scheduled', async () => {
    const warning = 'duplicate Apple notarization submission risk';
    const success = await run({ retryWarning: warning });
    expect(success.log).not.toContain(warning);
    expect(success.log).not.toContain('bounded failure diagnostic');
    const terminal = await run({
      command: nodeCmd('console.error("certificate has expired");process.exit(1)'),
      retryWarning: warning,
    });
    expect(terminal.log).not.toContain(warning);
    const transient = await run({
      command: nodeCmd('console.error("socket hang up");process.exit(1)'),
      retryWarning: warning,
    });
    expect(transient.log.match(new RegExp(warning, 'g'))).toHaveLength(2);
  });

  test('the state machine rejects an invalid attempt bound before installing handlers', async () => {
    const signals = new EventEmitter();
    await expect(run({ maxAttempts: 0, signalSource: signals })).rejects.toThrow(
      /maxAttempts must be an integer from 1 to 3/,
    );
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('retry delay', () => {
  test('uses jittered 30s and 60s bases', () => {
    const evidence = inspect('socket hang up').evidence;
    expect(computeRetryDelayMs(1, evidence, { randomFn: () => 0, nowMs: 0 })).toBe(30_001);
    expect(computeRetryDelayMs(2, evidence, { randomFn: () => 0, nowMs: 0 })).toBe(60_001);
    expect(computeRetryDelayMs(2, evidence, { randomFn: () => 1, nowMs: 0 })).toBeLessThanOrEqual(
      65_000,
    );
  });

  test('honors both Retry-After forms as a minimum plus positive jitter', () => {
    const delta = inspect('HTTP 429\nRetry-After: 120', { nowFn: () => 0 }).evidence;
    expect(computeRetryDelayMs(1, delta, { randomFn: () => 0, nowMs: 0 })).toBe(120_001);
    const nowMs = Date.parse('2026-09-11T20:00:00Z');
    const retryAt = new Date(nowMs + 90_000).toUTCString();
    const date = inspect(`HTTP 429\nRetry-After: ${retryAt}`, { nowFn: () => nowMs }).evidence;
    expect(computeRetryDelayMs(1, date, { randomFn: () => 0, nowMs })).toBe(90_001);
  });

  test('does not reinterpret a carried delta Retry-After against a later clock', () => {
    let nowMs = 0;
    const evidence = new FailureEvidence({ nowFn: () => nowMs });
    evidence.ingest(Buffer.from('HTTP 429\nRetry-After: 120\n'));
    nowMs = 10_000;
    evidence.ingest(Buffer.from('download cleanup\n'));
    nowMs = 20_000;
    evidence.ingest(Buffer.from('another chunk\n'));
    evidence.finish();
    expect(evidence.retryAfterEpochMs).toBe(120_000);
    expect(computeRetryDelayMs(1, evidence, { randomFn: () => 0, nowMs })).toBe(100_001);
  });

  test('accepts only header-shaped lines and keeps the first valid Retry-After', () => {
    const evidence = new FailureEvidence({ nowFn: () => 0 });
    evidence.ingest(
      Buffer.from('noise Retry-After: 900\nError: Retry-After: 800\n* Retry-After: 700\n'),
    );
    evidence.ingest(Buffer.from('< Retry-After: 45\nRetry-After: 120\n'));
    evidence.finish();
    expect(evidence.retryAfterEpochMs).toBe(45_000);
  });
});

describe('deadlines and cancellation', () => {
  const completedAttempt = (text, code = 1, options) => ({
    code,
    closeSignal: null,
    cancellationSignal: null,
    cancelled: false,
    timedOut: false,
    deadlineExpired: false,
    spawnError: null,
    cleanup: { ok: true, reason: 'clean' },
    evidence: inspect(text, options).evidence,
  });
  const assertPidDead = (path) => {
    const pid = Number(readFileSync(path, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  };

  test('real macOS budget arithmetic admits a quick incident-style retry', async () => {
    const minute = 60_000;
    const timing = workflowTiming(WORKFLOW_JOBS[0]);
    let clock = 15 * minute;
    let attempt = 0;
    const result = await run({
      deadlineEpochMs: timing.budgetMs,
      attemptTimeoutMs: timing.attemptTimeoutMs,
      cleanupReserveMs: 15_000,
      nowFn: () => clock,
      sleepFn: async (ms) => {
        clock += ms;
      },
      attemptRunner: async () => {
        attempt += 1;
        clock += minute;
        return attempt === 1
          ? completedAttempt('HTTPError: Response code 500 (Internal Server Error)')
          : completedAttempt('', 0);
      },
    });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  test('real Windows and Linux budget arithmetic rejects a doomed retry projection', async () => {
    const minute = 60_000;
    const windowsTiming = workflowTiming(WORKFLOW_JOBS[1]);
    const linuxTiming = workflowTiming(WORKFLOW_JOBS[2]);
    expect(linuxTiming).toEqual(windowsTiming);
    const execute = async (evidenceText) => {
      let clock = 19 * minute;
      return run({
        deadlineEpochMs: windowsTiming.budgetMs,
        attemptTimeoutMs: windowsTiming.attemptTimeoutMs,
        cleanupReserveMs: 15_000,
        nowFn: () => clock,
        attemptRunner: async () => {
          clock += 12 * minute;
          return completedAttempt(evidenceText, 1, { nowFn: () => clock });
        },
      });
    };
    const baseline = await execute('socket hang up');
    const withHeader = await execute('HTTP 429\nRetry-After: 31');
    for (const result of [baseline, withHeader]) {
      expect(result).toMatchObject({ ok: false, reason: 'deadline', attempts: 1 });
      expect(result.log).toContain('reason=control:deadline outcome=deadline');
      expect(result.log).toContain('phase=before-backoff');
      expect(result.log).toContain('projected-attempt-ms=900000');
    }
    expect(baseline.log).not.toContain('retry-after-ms=');
    expect(baseline.log).toContain('matched=rule:socket-hangup');
    expect(withHeader.log).toContain('retry-after-ms=31000');
    expect(withHeader.log).toContain('matched=http:429');
  });

  test('a genuine Retry-After beyond the wall-clock budget stops explicitly', async () => {
    const timing = workflowTiming(WORKFLOW_JOBS[1]);
    let clock = 0;
    const result = await run({
      deadlineEpochMs: timing.budgetMs,
      attemptTimeoutMs: timing.attemptTimeoutMs,
      nowFn: () => clock,
      attemptRunner: async () => {
        clock += 1_000;
        return completedAttempt('HTTP 429\nRetry-After: 3600', 1, { nowFn: () => clock });
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'deadline', attempts: 1 });
    expect(result.log).toContain('reason=control:deadline outcome=deadline');
    expect(result.log).toContain('retry-after-ms=3600000');
    expect(result.log).toContain('projected-attempt-ms=1250');
  });

  test('attempt timeout stops and cleans the child without retrying', async () => {
    const pidFile = join(scratch, 'timeout-child-pid');
    const result = await run({
      command: nodeCmd(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(() => {},1000)`,
      ),
      attemptTimeoutMs: 40,
      deadlineEpochMs: Date.now() + 5_000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'attempt-timeout', attempts: 1 });
    expect(result.log).toContain(
      'decision=stop reason=control:attempt-timeout outcome=attempt-timeout attempt=1/3 code=none signal=SIGTERM',
    );
    expect(result.log).not.toContain('phase=');
    assertPidDead(pidFile);
  });

  test('absolute deadline stops and cleans a live child', async () => {
    const pidFile = join(scratch, 'deadline-child-pid');
    const result = await run({
      command: nodeCmd(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(() => {},1000)`,
      ),
      attemptTimeoutMs: 10_000,
      cleanupReserveMs: 10,
      deadlineEpochMs: Date.now() + 1_100,
    });
    expect(result).toMatchObject({ ok: false, reason: 'deadline', attempts: 1 });
    expect(result.log).toContain('reason=control:deadline outcome=deadline');
    expect(result.log).toContain('phase=mid-attempt');
    assertPidDead(pidFile);
  });

  test('does not start an attempt or backoff that cannot fit the deadline', async () => {
    const spawnFn = vi.fn();
    const nowMs = 10_000;
    const beforeAttempt = await run({
      spawnFn,
      nowFn: () => nowMs,
      deadlineEpochMs: nowMs + 1_099,
      attemptTimeoutMs: 1_000,
      cleanupReserveMs: 100,
    });
    expect(beforeAttempt).toMatchObject({ ok: false, reason: 'deadline', attempts: 0 });
    expect(beforeAttempt.log).toContain('reason=control:deadline outcome=deadline');
    expect(beforeAttempt.log).toContain('phase=before-attempt');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(
      await run({
        command: nodeCmd('console.error("socket hang up");process.exit(1)'),
        nowFn: () => nowMs,
        deadlineEpochMs: nowMs + 31_000,
        attemptTimeoutMs: 1_000,
        cleanupReserveMs: 50,
      }),
    ).toMatchObject({ ok: false, reason: 'deadline', attempts: 1 });
  });

  test('global deadline exhaustion aborts an active attempt', async () => {
    let reads = 0;
    const result = await run({
      command: nodeCmd('setInterval(() => {}, 1000)'),
      nowFn: () => {
        reads += 1;
        return reads === 1 ? 0 : 1_401;
      },
      deadlineEpochMs: 1_500,
      attemptTimeoutMs: 1_000,
      cleanupReserveMs: 100,
    });
    expect(result).toMatchObject({ ok: false, reason: 'deadline', attempts: 1 });
    expect(result.log).toContain('reason=control:deadline outcome=deadline');
  });

  test('parent cancellation during a child stops the tree and removes handlers', async () => {
    const signals = new EventEmitter();
    const pidFile = join(scratch, 'cancelled-child-pid');
    const promise = run({
      command: nodeCmd(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('ready');setInterval(() => {},1000)`,
      ),
      signalSource: signals,
    });
    while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 5));
    signals.emit('SIGINT');
    const result = await promise;
    expect(result).toMatchObject({ ok: false, reason: 'signal', signal: 'SIGINT', attempts: 1 });
    expect(result.log).toContain('reason=control:signal outcome=signal');
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    assertPidDead(pidFile);
  });

  test('parent cancellation during backoff prevents another attempt', async () => {
    const signals = new EventEmitter();
    const count = join(scratch, 'backoff-cancel-count');
    let enterBackoff;
    const backoffStarted = new Promise((resolve) => {
      enterBackoff = resolve;
    });
    writeFileSync(count, '0');
    const promise = run({
      command: nodeCmd(
        `const fs=require('fs');const p=${JSON.stringify(count)};fs.writeFileSync(p,String(+fs.readFileSync(p,'utf8')+1));console.error('socket hang up');process.exit(1)`,
      ),
      signalSource: signals,
      sleepFn: (_ms, signal) =>
        new Promise((resolve) => {
          enterBackoff();
          signal.addEventListener('abort', resolve, { once: true });
        }),
    });
    await backoffStarted;
    signals.emit('SIGTERM');
    const result = await promise;
    expect(result).toMatchObject({
      ok: false,
      reason: 'signal',
      signal: 'SIGTERM',
      attempts: 1,
    });
    expect(result.log).toContain('reason=control:signal outcome=signal');
    expect(readFileSync(count, 'utf8')).toBe('1');
  });

  test.runIf(process.platform !== 'win32')(
    'reaps a real grandchild before the next attempt starts',
    async () => {
      const helper = join(scratch, 'tree-helper.mjs');
      const count = join(scratch, 'tree-count');
      const pidFile = join(scratch, 'grandchild-pid');
      const overlap = join(scratch, 'tree-overlap');
      writeFileSync(count, '0');
      writeFileSync(
        helper,
        `import { spawn } from 'node:child_process';import { readFileSync,writeFileSync } from 'node:fs';const [count,pidFile,overlap]=process.argv.slice(2);const n=+readFileSync(count,'utf8')+1;writeFileSync(count,String(n));if(n===1){const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(pidFile,String(child.pid));console.error('socket hang up');process.exit(1)}const pid=+readFileSync(pidFile,'utf8');try{process.kill(pid,0);writeFileSync(overlap,'alive');process.exit(1)}catch{process.exit(0)}`,
      );
      const result = await run({
        command: [process.execPath, helper, count, pidFile, overlap],
        cleanupGraceMs: 30,
      });
      expect(result).toMatchObject({ ok: true, attempts: 2 });
      expect(existsSync(overlap)).toBe(false);
      expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
    },
    5_000,
  );

  test.runIf(process.platform !== 'win32')(
    'the CLI exits with the same parent signal after cleanup',
    async () => {
      const child = spawn(
        process.execPath,
        [
          SCRIPT,
          '--deadline-epoch-ms',
          String(Date.now() + 60_000),
          '--attempt-timeout',
          '30s',
          '--',
          process.execPath,
          '-e',
          'console.log("ready");setInterval(()=>{},1000)',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', resolve);
      });
      child.kill('SIGTERM');
      const closed = await new Promise((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      expect(closed).toEqual({ code: null, signal: 'SIGTERM' });
    },
    5_000,
  );
});

describe('POSIX owned-tree cleanup reasons', () => {
  const options = { graceMs: 1, cleanupReserveMs: 1, waitForClose: async () => false };

  test('distinguishes signal-send failure', async () => {
    const controller = createOwnedTreeController({
      platform: 'darwin',
      killFn: (_pid, signal) => {
        if (signal !== 0) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    });
    expect(await controller.cleanup(4321, options)).toEqual({
      ok: false,
      reason: 'signal-send-failure',
    });
  });

  test('distinguishes a tree surviving SIGKILL', async () => {
    const controller = createOwnedTreeController({
      platform: 'linux',
      killFn: () => {},
      sleepFn: async () => {},
      pollIntervalMs: 1,
    });
    expect(await controller.cleanup(4321, options)).toEqual({
      ok: false,
      reason: 'tree-survived-kill',
    });
  });

  test('distinguishes a missing close observation', async () => {
    const controller = createOwnedTreeController({
      platform: 'linux',
      killFn: () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      },
    });
    expect(await controller.cleanup(4321, options)).toEqual({
      ok: false,
      reason: 'close-not-observed',
    });
  });
});

describe('Windows owned-tree adapter', () => {
  test('shell mode uses Bash through the injected Windows spawn boundary', async () => {
    const calls = [];
    const spawnFn = (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    };
    const result = await run({
      command: ['printf windows-shell'],
      shell: true,
      platform: 'win32',
      spawnFn,
    });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(calls).toEqual([
      {
        executable: 'bash',
        args: ['-c', 'printf windows-shell'],
        options: { stdio: ['inherit', 'pipe', 'pipe'], detached: false, windowsHide: true },
      },
    ]);
  });

  test('uses taskkill tree mode then forced tree mode after grace', async () => {
    const calls = [];
    const controller = createOwnedTreeController({
      platform: 'win32',
      taskkillFn: async (args) => {
        calls.push(args);
        return { ok: true };
      },
      sleepFn: () => Promise.resolve(),
    });
    const cleaned = await controller.cleanup(4321, {
      graceMs: 50,
      waitForClose: async () => calls.length > 1,
    });
    expect(cleaned).toEqual({ ok: true, reason: 'clean' });
    expect(calls).toEqual([
      ['/PID', '4321', '/T'],
      ['/PID', '4321', '/T', '/F'],
    ]);
  });

  test('fails closed when forced taskkill cannot prove cleanup', async () => {
    const controller = createOwnedTreeController({
      platform: 'win32',
      taskkillFn: async () => ({ ok: false }),
    });
    expect(
      await controller.cleanup(4321, {
        graceMs: 1,
        waitForClose: async () => false,
      }),
    ).toEqual({ ok: false, reason: 'taskkill-failure' });
  });

  test('distinguishes successful taskkill without a close observation', async () => {
    const controller = createOwnedTreeController({
      platform: 'win32',
      taskkillFn: async () => ({ ok: true }),
    });
    expect(
      await controller.cleanup(4321, {
        graceMs: 1,
        waitForClose: async () => false,
      }),
    ).toEqual({ ok: false, reason: 'close-not-observed' });
  });
});

describe('parseArgs', () => {
  const argv = (...rest) => ['node', 'x', ...rest];

  test('parses the bounded caller contract', () => {
    expect(
      parseArgs(
        argv(
          '--label',
          'pkg (linux)',
          '--max-attempts',
          '3',
          '--deadline-epoch-ms',
          '2000000000000',
          '--attempt-timeout',
          '15m',
          '--retry-warning',
          'retry side effect',
          '--shell',
          '--',
          'pnpm exec electron-builder',
        ),
      ),
    ).toEqual({
      label: 'pkg (linux)',
      maxAttempts: 3,
      deadlineEpochMs: 2_000_000_000_000,
      attemptTimeoutMs: 900_000,
      retryWarning: 'retry side effect',
      shell: true,
      command: ['pnpm exec electron-builder'],
    });
  });

  test('rejects missing budgets, excess attempts, and malformed shell commands', () => {
    expect(() => parseArgs(argv('--', 'true'))).toThrow(/deadline/);
    expect(() => parseArgs(argv('--deadline-epoch-ms', '2000000000000', '--', 'true'))).toThrow(
      /attempt-timeout/,
    );
    expect(() =>
      parseArgs(
        argv(
          '--max-attempts',
          '4',
          '--deadline-epoch-ms',
          '2000000000000',
          '--attempt-timeout',
          '1m',
          '--',
          'true',
        ),
      ),
    ).toThrow(/max-attempts/);
    expect(() =>
      parseArgs(
        argv(
          '--shell',
          '--deadline-epoch-ms',
          '2000000000000',
          '--attempt-timeout',
          '1m',
          '--',
          'a',
          'b',
        ),
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      parseArgs(
        argv(
          '--unknown',
          'value',
          '--deadline-epoch-ms',
          '2000000000000',
          '--attempt-timeout',
          '1m',
          '--',
          'true',
        ),
      ),
    ).toThrow(/unknown flag/);
    expect(() =>
      parseArgs(
        argv(
          '--label',
          '--deadline-epoch-ms',
          '2000000000000',
          '--attempt-timeout',
          '1m',
          '--',
          'true',
        ),
      ),
    ).toThrow(/--label requires a value/);
  });

  test('accepts an explicit empty retry warning', () => {
    const parsed = parseArgs(
      argv(
        '--deadline-epoch-ms',
        '2000000000000',
        '--attempt-timeout',
        '1m',
        '--retry-warning',
        '',
        '--',
        'true',
      ),
    );
    expect(parsed.retryWarning).toBe('');
  });

  test('rejects an empty label while permitting only the optional warning to be empty', () => {
    expect(() =>
      parseArgs(
        argv(
          '--label',
          '',
          '--deadline-epoch-ms',
          '2000000000000',
          '--attempt-timeout',
          '1m',
          '--',
          'true',
        ),
      ),
    ).toThrow(/--label requires a value/);
  });
});

describe('workflow wiring', () => {
  const job = workflowJob;
  const step = workflowStep;
  const jobs = WORKFLOW_JOBS;

  test('download-integrity recovery depends on uncached packaging downloads', () => {
    expect(desktopRelease).not.toMatch(
      /ELECTRON_BUILDER_CACHE|ELECTRON_CACHE|electron_config_cache|electronDownload|[Cc]aches?[\\/]electron|electron(?:-builder)?[\\/][Cc]ache/,
    );
  });
  const materializationBlock = (packageStep) => {
    const start = packageStep.indexOf('WRAPPER="');
    const notice = packageStep.indexOf(
      'echo "::notice::Retry wrapper materialized from workflow SHA $' + '{GITHUB_WORKFLOW_SHA}."',
    );
    if (start === -1 || notice === -1) throw new Error('materialization block not found');
    const end = packageStep.indexOf('\n', notice);
    return packageStep.slice(start, end);
  };
  const packageSteps = () => jobs.map((row) => step(job(row[0]), row[3]));
  const runMaterialization = ({
    fetchFailures = 0,
    showFailure = false,
    emptyShow = false,
    mvFailure = false,
    mutate,
  } = {}) => {
    const dir = mkdtempSync(join(scratch, 'materialize-'));
    let block = materializationBlock(packageSteps()[0]);
    if (mutate) block = mutate(block);
    const script = join(dir, 'run.sh');
    writeFileSync(
      script,
      [
        'set -euo pipefail',
        'git() {',
        '  if [[ " $* " == *" fetch "* ]]; then',
        '    n=$(cat "$RUNNER_TEMP/fetch-count")',
        '    n=$((n + 1))',
        '    printf %s "$n" > "$RUNNER_TEMP/fetch-count"',
        '    [[ "$n" -gt "$FETCH_FAILURES" ]]',
        '    return',
        '  fi',
        '  if [[ "$SHOW_FAILURE" == true ]]; then printf partial; return 1; fi',
        '  if [[ "$EMPTY_SHOW" == true ]]; then return 0; fi',
        "  printf '%s\\n' '#!/usr/bin/env node'",
        '}',
        'sleep() { echo "SLEEP:$1"; }',
        ...(mvFailure ? ['mv() { return 1; }'] : []),
        block,
        'echo REACHED',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'fetch-count'), '0');
    const result = spawnSync('bash', ['--noprofile', '--norc', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: dir,
        GITHUB_WORKSPACE: dir,
        GITHUB_WORKFLOW_SHA: 'deadbeef',
        FETCH_FAILURES: String(fetchFailures),
        SHOW_FAILURE: String(showFailure),
        EMPTY_SHOW: String(emptyShow),
      },
    });
    return { ...result, dir, files: readdirSync(dir) };
  };

  test.each(jobs)('%s starts an absolute %sm clock before checkout', (name, budget) => {
    const body = job(name);
    expect(body.indexOf('- name: Start packaging deadline')).toBeLessThan(
      body.indexOf('- uses: actions/checkout'),
    );
    expect(step(body, 'Start packaging deadline')).toContain(
      `PACKAGING_BUDGET_MINUTES: "${budget}"`,
    );
  });

  test.each(jobs)(
    '%s always materializes workflow-SHA tooling into RUNNER_TEMP',
    (name, _budget, _timeout, packageName) => {
      const packageStep = step(job(name), packageName);
      expect(packageStep).toContain('GITHUB_WORKFLOW_SHA: $' + '{{ github.workflow_sha }}');
      expect(packageStep).toContain('WRAPPER="$' + '{RUNNER_TEMP}/retry-transient.mjs"');
      expect(packageStep).toContain('fetch --no-tags --depth=1 origin "$GITHUB_WORKFLOW_SHA"');
      expect(packageStep).toContain(
        'show "$GITHUB_WORKFLOW_SHA:.github/scripts/retry-transient.mjs"',
      );
      expect(packageStep).not.toContain('GITHUB_WORKSPACE}/.github/scripts/retry-transient.mjs');
      expect(packageStep).not.toMatch(/if \[\[ ! -f "\$WRAPPER"/);
      expect(packageStep).not.toContain('packaging without transient retry');
    },
  );

  test('all three workflow-SHA materialization blocks are byte-equivalent', () => {
    const blocks = packageSteps().map(materializationBlock);
    expect(new Set(blocks).size).toBe(1);
    expect(blocks[0]).not.toMatch(/do\s+rm -f "\$WRAPPER_TMP"/);
    expect(blocks[0]).toMatch(
      /\[\[ -s "\$WRAPPER_TMP" \]\] &&\s+mv "\$WRAPPER_TMP" "\$WRAPPER"; then/,
    );
  });

  test('materialization retries transient fetch failure with bounded delays', () => {
    const result = runMaterialization({ fetchFailures: 1 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SLEEP:5');
    expect(result.stdout).not.toContain('SLEEP:10');
    expect(readFileSync(join(result.dir, 'retry-transient.mjs'), 'utf8')).toContain(
      '#!/usr/bin/env node',
    );
  });

  test('materialization fails before mv and cleans temporary output', () => {
    const terminal = runMaterialization({ showFailure: true });
    expect(terminal.status).toBe(1);
    expect(terminal.stdout).toContain('SLEEP:5');
    expect(terminal.stdout).toContain('SLEEP:10');
    expect(terminal.stdout).toContain('::error::Failed to materialize retry wrapper');
    expect(terminal.stdout).not.toContain('REACHED');
    expect(terminal.files.some((file) => file.startsWith('retry-transient.mjs'))).toBe(false);

    const trapped = runMaterialization({ mvFailure: true });
    expect(trapped.status).toBe(1);
    expect(trapped.stdout).toContain('SLEEP:5');
    expect(trapped.stdout).toContain('SLEEP:10');
    expect(trapped.stdout).toContain('::error::Failed to materialize retry wrapper');
    expect(trapped.files.some((file) => file.includes('.tmp.'))).toBe(false);
  });

  test('zero-byte successful show reaches the bounded final error', () => {
    const result = runMaterialization({ emptyShow: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Failed to materialize retry wrapper');
    expect(result.stdout).not.toContain('REACHED');
    expect(result.files.some((file) => file.startsWith('retry-transient.mjs'))).toBe(false);
  });

  test('the materialization harness discriminates a missing terminal exit', () => {
    const result = runMaterialization({
      fetchFailures: 99,
      mutate: (block) => block.replace('            exit 1', '            true'),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REACHED');
  });

  test.each(jobs)(
    '%s compiles once outside retry and passes exact budgets',
    (name, _budget, timeout, packageName) => {
      const body = job(name);
      expect(body.indexOf('- name: Build desktop main/preload/renderer')).toBeLessThan(
        body.indexOf(`- name: ${packageName}`),
      );
      const packageStep = step(body, packageName);
      expect(packageStep).not.toContain('pnpm run build:desktop');
      expect(packageStep).toContain(`--attempt-timeout "${timeout}"`);
      expect(packageStep).toContain('--deadline-epoch-ms "$PACKAGING_DEADLINE_EPOCH_MS"');
      const command = packageStep.split('\n').find((line) => /^\s*PKG_CMD:/.test(line));
      expect(command).toContain("PKG_CMD: 'rm -rf dist-desktop && pnpm exec electron-builder");
      expect(command).toContain('--publish never');
    },
  );

  test('logs duplicate Apple submissions and keeps strict downstream gates outside retry', () => {
    const macPackage = step(job('build-macos'), 'Build + sign + notarize DMG/ZIP');
    expect(macPackage).toContain('duplicate Apple notarization submission');
    expect(macPackage).toContain('at most 2');
    expect(macPackage).toContain('--retry-warning');
    expect(macPackage).not.toMatch(/echo .*duplicate Apple notarization submission/);
    for (const [body, packageName, downstream] of [
      [
        job('build-macos'),
        'Build + sign + notarize DMG/ZIP',
        [
          'Attest the signed macOS app',
          'Smoke the packaged DMG (FR5b)',
          'Upload macOS release assets for the fan-in publisher',
        ],
      ],
      [
        job('build-windows'),
        'Package NSIS installers (x64 + arm64, signed)',
        [
          'Attest signed Windows packages',
          'Assert the packaged asar carries its dependencies',
          'Upload Windows release assets for the fan-in publisher',
        ],
      ],
      [
        job('build-linux'),
        'Package $' + '{{ matrix.targets }}',
        [
          'Assert the packaged asar carries its dependencies',
          'Assert app-update.yml + package-type are present and channel-correct',
          'Upload Linux $' + '{{ matrix.arch }} release assets for the fan-in publisher',
        ],
      ],
    ]) {
      const packageAt = body.indexOf(`- name: ${packageName}`);
      const packageStep = step(body, packageName);
      for (const name of downstream) {
        expect(body.indexOf(`- name: ${name}`)).toBeGreaterThan(packageAt);
        expect(packageStep).not.toContain(name);
      }
    }
    for (const gate of [
      'Assert the complete cross-platform inventory',
      'Verify the Release carries the full inventory',
      'Promote draft release to published',
    ]) {
      expect(desktopRelease).toContain(`- name: ${gate}`);
    }
  });
});
