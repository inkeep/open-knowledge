import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { context, metrics, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import {
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
  type InstallGuidance,
} from './git-preflight.ts';
import type { PinoLogger } from './logger.ts';

const TEST_CONFIG = ConfigSchema.parse({});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-git-preflight-boot-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Seed `<projectDir>/.ok/config.yml` + `.gitignore` so `bootServer`'s
 * pre-listen MissingOkConfigError check passes. The preflight runs AFTER
 * that check, so these tests can't reach the preflight site without the
 * scaffold.
 */
function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
}

interface LogEntry {
  fields: Record<string, unknown>;
  msg: string;
}

/**
 * Minimal `PinoLogger`-shaped capture. The preflight catch path only calls
 * `log.warn(fields, msg)`; the other log methods are no-ops to satisfy the
 * `PinoLogger` interface. `child()` returns the same capture so any nested
 * logger calls (none expected for the preflight-failure paths) keep landing
 * in the same array.
 */
function createCaptureLogger(): { entries: LogEntry[]; logger: PinoLogger } {
  const entries: LogEntry[] = [];
  const noop = (): void => {};
  const logger = {
    warn: (fields: Record<string, unknown>, msg: string) => entries.push({ fields, msg }),
    info: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    level: 'info',
    silent: noop,
    bindings: () => ({}),
    child: () => logger,
  } as unknown as PinoLogger;
  return { entries, logger };
}

/**
 * Hand-rolled `InstallGuidance` for tests. Avoids relying on the real
 * `buildGuidance()` (which probes the test environment for brew/winget/etc.
 * and reads `/etc/os-release`) so assertions are deterministic across
 * macOS/Linux/Windows CI runners.
 */
function makeGuidance(): InstallGuidance {
  return {
    product: 'Git',
    url: 'https://git-scm.com/download/linux',
    options: [
      {
        label: 'Install with apt',
        command: 'sudo apt install git',
        requiresAdmin: true,
      },
    ],
  };
}

describe('bootServer git-preflight', () => {
  test('GitNotAvailableError → structured log + stderr + re-throw of typed error', async () => {
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    seedOkScaffold(projectDir);

    const { entries, logger } = createCaptureLogger();

    let capturedStderr = '';
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as never;

    const thrown = new GitNotAvailableError('linux', makeGuidance());

    let caught: unknown;
    try {
      await bootServer({
        config: TEST_CONFIG,
        contentDir: projectDir,
        port: 0,
        quiet: true,
        gitEnabled: true,
        idleShutdownMs: null,
        attachUiSibling: false,
        log: logger,
        gitPreflight: () => {
          throw thrown;
        },
      });
    } catch (err) {
      caught = err;
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    // Identity-preserving re-throw — callers (CLI / Electron utility) can
    // pattern-match the same instance they would catch from a synchronous
    // `assertGitAvailable()` call.
    expect(caught).toBe(thrown);
    expect(caught).toBeInstanceOf(GitNotAvailableError);

    // stderr received the typed error's `.message` (which contains the
    // install guidance composed by `buildMissingMessage`).
    expect(capturedStderr).toContain('OpenKnowledge needs Git');
    expect(capturedStderr).toContain('sudo apt install git');

    // Structured log emitted BEFORE the re-throw.
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.fields.event).toBe('git_preflight_fail');
    expect(entry?.fields.platform).toBe('linux');
    expect(entry?.fields.reason).toBe('not_available');
    expect(entry?.fields.detectedVersion).toBe('');
    expect(entry?.msg).toBe('git binary not found');
  });

  test('GitTooOldError → structured log carries detectedVersion + reason=too_old', async () => {
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    seedOkScaffold(projectDir);

    const { entries, logger } = createCaptureLogger();

    let capturedStderr = '';
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as never;

    const thrown = new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', makeGuidance());

    let caught: unknown;
    try {
      await bootServer({
        config: TEST_CONFIG,
        contentDir: projectDir,
        port: 0,
        quiet: true,
        gitEnabled: true,
        idleShutdownMs: null,
        attachUiSibling: false,
        log: logger,
        gitPreflight: () => {
          throw thrown;
        },
      });
    } catch (err) {
      caught = err;
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(caught).toBe(thrown);
    expect(caught).toBeInstanceOf(GitTooOldError);

    expect(capturedStderr).toContain('OpenKnowledge requires Git 2.31.0 or newer');
    expect(capturedStderr).toContain('detected 2.20.0');
    expect(capturedStderr).toContain('/usr/bin/git');

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.fields.event).toBe('git_preflight_fail');
    expect(entry?.fields.platform).toBe('linux');
    expect(entry?.fields.reason).toBe('too_old');
    expect(entry?.fields.detectedVersion).toBe('2.20.0');
    expect(entry?.msg).toBe('git binary too old');
  });

  test('non-typed error from preflight propagates unchanged — no log, no stderr', async () => {
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    seedOkScaffold(projectDir);

    const { entries, logger } = createCaptureLogger();

    let capturedStderr = '';
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as never;

    const unexpected = new Error('something completely different');

    let caught: unknown;
    try {
      await bootServer({
        config: TEST_CONFIG,
        contentDir: projectDir,
        port: 0,
        quiet: true,
        gitEnabled: true,
        idleShutdownMs: null,
        attachUiSibling: false,
        log: logger,
        gitPreflight: () => {
          throw unexpected;
        },
      });
    } catch (err) {
      caught = err;
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    // Original error propagates with identity preserved.
    expect(caught).toBe(unexpected);
    expect(capturedStderr).toBe('');
    expect(entries).toHaveLength(0);
  });

  test('preflight callback success allows boot to proceed past the gate', async () => {
    // Positive-path check: when the injected preflight returns a valid
    // GitDetected (no throw), the catch block doesn't fire and boot
    // continues to subsequent gates. We don't drive boot all the way
    // through createServer (that needs a real git repo + shadow init);
    // instead, we point `contentDir` at a directory missing the .ok scaffold
    // so the next gate (`MissingOkConfigError`) fires. Reaching that gate
    // proves the preflight passed without log/stderr side effects.
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    // NOTE: deliberately NOT calling seedOkScaffold — we want the next gate
    // to fire so we can confirm the preflight didn't short-circuit.

    const { entries, logger } = createCaptureLogger();

    let capturedStderr = '';
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as never;

    const ok: GitDetected = {
      ok: true,
      version: '2.45.0',
      resolvedPath: '/usr/bin/git',
      source: 'PATH',
    };

    let caught: unknown;
    try {
      await bootServer({
        config: TEST_CONFIG,
        contentDir: projectDir,
        port: 0,
        quiet: true,
        gitEnabled: true,
        idleShutdownMs: null,
        attachUiSibling: false,
        log: logger,
        gitPreflight: () => ok,
      });
    } catch (err) {
      caught = err;
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    // Boot reached the next gate (config scaffold missing). That proves
    // the preflight passed without short-circuiting.
    expect(caught).toBeDefined();
    const e = caught as Error & { name?: string };
    // The next gate fires (or a downstream error if seedOkScaffold ran in
    // some race) — we only require that the preflight didn't fire.
    expect(e.name).not.toBe('GitNotAvailableError');
    expect(e.name).not.toBe('GitTooOldError');
    expect(capturedStderr).toBe('');
    expect(entries).toHaveLength(0);
  });

  test('gitEnabled:false skips the preflight entirely (no-project ephemeral single-file shape)', async () => {
    // The single-file `ok <file>` server boots git-off, so the preflight must
    // not run — otherwise a user without git could not open a loose file. Inject
    // a preflight that WOULD throw and assert it is never invoked, and that boot
    // reaches a live server handle past the (skipped) gate.
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    seedOkScaffold(projectDir);

    const { entries, logger } = createCaptureLogger();

    let capturedStderr = '';
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as never;

    let preflightCalled = false;
    let booted: Awaited<ReturnType<typeof bootServer>> | null = null;
    try {
      booted = await bootServer({
        config: TEST_CONFIG,
        contentDir: projectDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
        log: logger,
        gitPreflight: () => {
          preflightCalled = true;
          throw new GitNotAvailableError('linux', makeGuidance());
        },
      });
      expect(booted.port).toBeGreaterThan(0);
    } finally {
      process.stderr.write = originalStderrWrite;
      if (booted) await booted.destroy();
    }

    // The gate short-circuited the preflight before it could run, so none of the
    // failure side effects fired.
    expect(preflightCalled).toBe(false);
    expect(capturedStderr).toBe('');
    expect(entries).toHaveLength(0);
    // Full server boot (binds a port) can exceed Bun's 5s default under CI
    // contention. This per-test 30s intentionally matches the server `test`
    // script's --timeout 30000 (not redundant): it keeps the headroom even
    // under a direct `bun test <file>` run, where the package timeout is absent.
  }, 30_000);
});

/**
 * OTEL emission — verifies the boot catch site invokes
 * `emitPreflightFailureSpan` on the typed-error path AND stays silent on the
 * success path. Uses an `InMemorySpanExporter` mounted as the global tracer
 * provider; `getTracer()` (called by `withSpanSync` inside the helper)
 * resolves to that provider, so we observe whatever the production code
 * actually emits.
 */
describe('bootServer git-preflight OTEL emission', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    trace.disable();
    metrics.disable();
    context.disable();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    metrics.disable();
    context.disable();
  });

  function findPreflightSpan() {
    return exporter.getFinishedSpans().find((s) => s.name === 'ok.preflight.git.fail');
  }

  test('GitNotAvailableError → ok.preflight.git.fail emitted with reason=not_available', async () => {
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    seedOkScaffold(projectDir);

    const { logger } = createCaptureLogger();

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as never;

    try {
      try {
        await bootServer({
          config: TEST_CONFIG,
          contentDir: projectDir,
          port: 0,
          quiet: true,
          gitEnabled: true,
          idleShutdownMs: null,
          attachUiSibling: false,
          log: logger,
          gitPreflight: () => {
            throw new GitNotAvailableError('linux', makeGuidance());
          },
        });
      } catch {
        // The typed re-throw is expected; the span is what we care about.
      }
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    const span = findPreflightSpan();
    expect(span).toBeDefined();
    expect(span?.attributes['ok.platform']).toBe('linux');
    expect(span?.attributes['ok.preflight.git.reason']).toBe('not_available');
    expect(span?.attributes['ok.preflight.git.detected_version']).toBe('');
  });

  test('GitTooOldError → ok.preflight.git.fail emitted with reason=too_old + detected version', async () => {
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    seedOkScaffold(projectDir);

    const { logger } = createCaptureLogger();

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as never;

    try {
      try {
        await bootServer({
          config: TEST_CONFIG,
          contentDir: projectDir,
          port: 0,
          quiet: true,
          gitEnabled: true,
          idleShutdownMs: null,
          attachUiSibling: false,
          log: logger,
          gitPreflight: () => {
            throw new GitTooOldError('linux', '2.20.0', '2.31.0', '/usr/bin/git', makeGuidance());
          },
        });
      } catch {
        // The typed re-throw is expected; the span is what we care about.
      }
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    const span = findPreflightSpan();
    expect(span).toBeDefined();
    expect(span?.attributes['ok.platform']).toBe('linux');
    expect(span?.attributes['ok.preflight.git.reason']).toBe('too_old');
    expect(span?.attributes['ok.preflight.git.detected_version']).toBe('2.20.0');
  });

  test('preflight success → no ok.preflight.git.* span emitted', async () => {
    const projectDir = await mkdtemp(resolve(tmpDir, 'state-'));
    // Deliberately NOT seedOkScaffold — the next gate fires after preflight
    // and we only care that the preflight didn't emit a span.

    const { logger } = createCaptureLogger();

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as never;

    const ok: GitDetected = {
      ok: true,
      version: '2.45.0',
      resolvedPath: '/usr/bin/git',
      source: 'PATH',
    };

    try {
      try {
        await bootServer({
          config: TEST_CONFIG,
          contentDir: projectDir,
          port: 0,
          quiet: true,
          gitEnabled: true,
          idleShutdownMs: null,
          attachUiSibling: false,
          log: logger,
          gitPreflight: () => ok,
        });
      } catch {
        // Expected: MissingOkConfigError from the next gate.
      }
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    // Failure-only emission — the success path stays silent.
    const preflightSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith('ok.preflight.git.'));
    expect(preflightSpans).toHaveLength(0);
  });
});
