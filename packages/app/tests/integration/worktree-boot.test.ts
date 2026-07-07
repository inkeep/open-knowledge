/**
 * End-to-end coverage for booting `bootServer` against a real linked git
 * worktree (`git worktree add`-created, `.git` is a pointer file). Locks the
 * (lazy shadow init) and (State A/B/C config-presence) contracts
 * against regression.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootServer, ConfigSchema } from '@inkeep/open-knowledge-server';
import { context, metrics, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createLinkedWorktree, type LinkedWorktreeHandle } from './worktree-test-harness.ts';

const TEST_CONFIG = ConfigSchema.parse({});

let handle: LinkedWorktreeHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('bootServer in a linked git worktree (FR2)', () => {
  test('lazy-inits shadow at <repo>/.git/worktrees/<name>/ok/HEAD on first boot', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: true });
    const expectedShadowHead = resolve(handle.worktreeGitdir, 'ok/HEAD');
    expect(existsSync(expectedShadowHead)).toBe(false);

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: handle.worktreePath,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      // Shadow init is async — runs inside `ready` (createServer's initAsync).
      await booted.ready;
      // Bare repo + HEAD should have been created by initShadowRepo via the
      // worktree-aware resolveShadowDir. No <wt>/.git/ok/ should exist —
      // that's the legacy main-worktree path; in a linked worktree the
      // shadow lives under the source repo's worktrees admin dir.
      expect(existsSync(expectedShadowHead)).toBe(true);
      // Negative: the legacy path under the worktree itself must NOT have
      // a shadow — that would mean resolveShadowDir wasn't worktree-aware.
      expect(existsSync(resolve(handle.worktreePath, '.git/ok/HEAD'))).toBe(false);
    } finally {
      await booted.destroy();
    }
  });
});

describe('bootServer pre-listen check in a linked worktree (FR3)', () => {
  test('State A: rejects with MissingOkConfigError when .ok/ is absent', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: false });

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir: handle.worktreePath,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { name?: string; kind?: string };
    expect(e.name).toBe('MissingOkConfigError');
    expect(e.kind).toBe('okdir');
    // No partial state — the worktree's gitdir should not have a shadow.
    const shadowDir = resolve(handle.worktreeGitdir, 'ok');
    expect(existsSync(shadowDir)).toBe(false);
  });

  test('State B: rejects with MissingOkConfigError when .ok/config.yml is missing', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: false });
    // .ok/ exists, but no config.yml inside.
    mkdirSync(resolve(handle.worktreePath, '.ok'), { recursive: true });

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir: handle.worktreePath,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { name?: string; kind?: string };
    expect(e.name).toBe('MissingOkConfigError');
    expect(e.kind).toBe('config');
    const shadowDir = resolve(handle.worktreeGitdir, 'ok');
    expect(existsSync(shadowDir)).toBe(false);
  });

  test('State C: proceeds with one-time stderr warning when only .ok/.gitignore is missing', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: false });
    const okDir = resolve(handle.worktreePath, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    // No .gitignore.

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    let booted: Awaited<ReturnType<typeof bootServer>> | null = null;
    try {
      booted = await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir: handle.worktreePath,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      const bootWarnings = warnings.filter((w) => w.startsWith('[boot]'));
      expect(bootWarnings.length).toBe(1);
      expect(bootWarnings[0]).toContain('.ok/.gitignore');
    } finally {
      console.warn = originalWarn;
      if (booted) await booted.destroy();
    }
  });
});

describe('bootServer ok.boot span attributes against a real linked worktree', () => {
  // Mirror unit-tier OTel coverage from boot.test.ts here so it runs on CI
  // (boot.test.ts is gated behind the bun#11892 skip-on-CI marker; this file
  // is not). One linked-worktree assertion is enough — the unit tests cover
  // main / failure / kind-flip cases against fakes.
  let exporter: InMemorySpanExporter | null = null;
  let provider: BasicTracerProvider | null = null;

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
    await provider?.shutdown();
    trace.disable();
    metrics.disable();
    context.disable();
    exporter = null;
    provider = null;
  });

  test('linked worktree boot emits ok.boot span with worktree.kind=linked + bounded gitdir', async () => {
    handle = createLinkedWorktree({ seedOkScaffold: true });

    const booted = await bootServer({
      host: '127.0.0.1',
      config: TEST_CONFIG,
      contentDir: handle.worktreePath,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      attachUiSibling: false,
    });
    try {
      const spans = exporter?.getFinishedSpans() ?? [];
      const bootSpan = spans.find((s) => s.name === 'ok.boot');
      expect(bootSpan).toBeDefined();
      expect(bootSpan?.attributes['ok.worktree.kind']).toBe('linked');
      const gitdirAttr = bootSpan?.attributes['ok.worktree.gitdir'];
      expect(typeof gitdirAttr).toBe('string');
      // normalizeFsPath caps at last-two-segments form so collector cardinality
      // stays bounded regardless of the user's home/tmp prefix length.
      expect((gitdirAttr as string).split('/').filter(Boolean).length).toBeLessThanOrEqual(3);
    } finally {
      await booted.destroy();
    }
  });
});

describe('createLinkedWorktree harness sanity', () => {
  beforeEach(() => {
    handle = null;
  });

  test('creates a real linked worktree where .git is a file pointing at the source repo', () => {
    handle = createLinkedWorktree();
    expect(existsSync(handle.repoRoot)).toBe(true);
    expect(existsSync(handle.worktreePath)).toBe(true);
    // The worktree's `.git` is a file (pointer), not a directory.
    const dotGitPath = resolve(handle.worktreePath, '.git');
    expect(statSync(dotGitPath).isFile()).toBe(true);
    const pointerContent = readFileSync(dotGitPath, 'utf-8');
    expect(pointerContent).toContain('gitdir:');
    expect(pointerContent).toContain(handle.worktreeGitdir);
  });
});

// Main-worktree counterpart to the State A/B coverage in
// `bootServer pre-listen check in a linked worktree` above.
// `bootServer`'s config-presence check fires before any subprocess work, so
// these cases — which are the common case for non-worktree users — can run
// on CI without tripping bun#11892. The fixture only needs a tmpdir; no
// `git init` is required.
describe('bootServer pre-listen check on main worktree (FR3)', () => {
  let mainTmp: string;

  beforeEach(async () => {
    mainTmp = await mkdtemp(resolve(tmpdir(), 'ok-main-pre-listen-'));
  });

  afterEach(async () => {
    await rm(mainTmp, { recursive: true, force: true });
  });

  test('State A: rejects with MissingOkConfigError when .ok/ is absent', async () => {
    const contentDir = mkdtempSync(resolve(mainTmp, 'state-a-'));
    // No git, no .ok/ — bootServer must throw before any subprocess runs.

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { name?: string; kind?: string; projectDir?: string };
    expect(e.name).toBe('MissingOkConfigError');
    expect(e.kind).toBe('okdir');
    expect(e.projectDir).toBe(contentDir);
    expect(e.message).toContain('OpenKnowledge config not found at .ok/config.yml');
    expect(e.message).toContain('Run ok init');
    // Fail-fast invariant: nothing under .git should have been touched.
    expect(existsSync(resolve(contentDir, '.git/ok'))).toBe(false);
  });

  test('State B: rejects with MissingOkConfigError when .ok/ exists but config.yml is missing', async () => {
    const contentDir = mkdtempSync(resolve(mainTmp, 'state-b-'));
    // .ok/ exists, but no config.yml inside.
    mkdirSync(resolve(contentDir, '.ok'), { recursive: true });

    let caught: unknown;
    try {
      await bootServer({
        host: '127.0.0.1',
        config: TEST_CONFIG,
        contentDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const e = caught as Error & { name?: string; kind?: string };
    expect(e.name).toBe('MissingOkConfigError');
    expect(e.kind).toBe('config');
    expect(e.message).toContain('OpenKnowledge config not found at .ok/config.yml');
    expect(existsSync(resolve(contentDir, '.git/ok'))).toBe(false);
  });
});
