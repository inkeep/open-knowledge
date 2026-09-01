import { beforeEach, describe, expect, test, vi } from 'vitest';

const actual = await import('@inkeep/open-knowledge-server');

interface EmittedError {
  name: string;
  platform: string;
  detected?: string;
}

const emissions: EmittedError[] = [];

vi.doMock('@inkeep/open-knowledge-server', () => ({
  ...actual,
  emitPreflightFailureSpan: (err: unknown) => {
    const e = err as Error & { platform?: string; detected?: string };
    emissions.push({
      name: e.name,
      platform: String(e.platform ?? ''),
      detected: e.detected,
    });
  },
}));

const { ensureGitAvailable } = await import('./git-preflight-handler.ts');
const { GitNotAvailableError, GitTooOldError } = actual;

const LINUX_GUIDANCE = {
  product: 'Git',
  url: 'https://git-scm.com/download/linux',
  options: [{ label: 'apt', command: 'sudo apt install git', requiresAdmin: true as const }],
};

interface MessageBoxOptionsLite {
  readonly response?: number;
}

function showMessageBoxSequence(responses: readonly number[]) {
  const remaining = [...responses];
  return vi.fn(async () => {
    const next = remaining.shift();
    if (next === undefined) {
      throw new Error('showMessageBox called more times than queued');
    }
    return { response: next } as MessageBoxOptionsLite;
  });
}

describe('ensureGitAvailable — FR8 emission per typed-error observation', () => {
  beforeEach(() => {
    emissions.length = 0;
  });

  test('first-try success: zero emissions (D7 success-silent)', async () => {
    const assertGitAvailable = () => ({
      ok: true as const,
      version: '2.45.0',
      resolvedPath: '/usr/bin/git',
      source: 'PATH' as const,
    });
    const showMessageBox = showMessageBoxSequence([]);
    const openExternal = vi.fn(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      // biome-ignore lint/suspicious/noExplicitAny: vi.doMock returns the spy
      showMessageBox: showMessageBox as any,
      openExternal,
    });

    expect(outcome).toBe('ok');
    expect(emissions).toHaveLength(0);
  });

  test('initial GitNotAvailableError + quit: exactly one emission', async () => {
    const assertGitAvailable = () => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    };
    const showMessageBox = showMessageBoxSequence([2]);
    const openExternal = vi.fn(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      // biome-ignore lint/suspicious/noExplicitAny: vi.doMock returns the spy
      showMessageBox: showMessageBox as any,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.name).toBe('GitNotAvailableError');
    expect(emissions[0]?.platform).toBe('linux');
    expect(emissions[0]?.detected).toBeUndefined();
  });

  test('initial fail + retry-fail + quit: two emissions (initial + retry)', async () => {
    const assertGitAvailable = () => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    };
    const showMessageBox = showMessageBoxSequence([1, 2]);
    const openExternal = vi.fn(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      // biome-ignore lint/suspicious/noExplicitAny: vi.doMock returns the spy
      showMessageBox: showMessageBox as any,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(emissions).toHaveLength(2);
    expect(emissions[0]?.name).toBe('GitNotAvailableError');
    expect(emissions[1]?.name).toBe('GitNotAvailableError');
  });

  test('initial fail + retry-success: one emission only (recovery on second probe is silent)', async () => {
    let attempts = 0;
    const assertGitAvailable = () => {
      attempts += 1;
      if (attempts === 1) {
        throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
      }
      return {
        ok: true as const,
        version: '2.45.0',
        resolvedPath: '/usr/bin/git',
        source: 'PATH' as const,
      };
    };
    const showMessageBox = showMessageBoxSequence([1]);
    const openExternal = vi.fn(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      // biome-ignore lint/suspicious/noExplicitAny: vi.doMock returns the spy
      showMessageBox: showMessageBox as any,
      openExternal,
    });

    expect(outcome).toBe('recovered');
    expect(emissions).toHaveLength(1);
  });

  test('GitTooOldError variant: emission carries reason=too_old + detected version', async () => {
    const assertGitAvailable = () => {
      throw new GitTooOldError('darwin', '2.20.0', '2.31.0', '/usr/bin/git', LINUX_GUIDANCE);
    };
    const showMessageBox = showMessageBoxSequence([2]);
    const openExternal = vi.fn(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      // biome-ignore lint/suspicious/noExplicitAny: vi.doMock returns the spy
      showMessageBox: showMessageBox as any,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.name).toBe('GitTooOldError');
    expect(emissions[0]?.platform).toBe('darwin');
    expect(emissions[0]?.detected).toBe('2.20.0');
  });

  test('non-typed first error: zero emissions (handler scopes telemetry to typed errors)', async () => {
    const assertGitAvailable = () => {
      throw new Error('something completely different');
    };
    const showMessageBox = showMessageBoxSequence([]);
    const openExternal = vi.fn(async () => {});
    const warn = vi.fn(() => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      // biome-ignore lint/suspicious/noExplicitAny: vi.doMock returns the spy
      showMessageBox: showMessageBox as any,
      openExternal,
      log: { warn },
    });

    expect(outcome).toBe('aborted');
    expect(emissions).toHaveLength(0);
  });

  test('open-install-page click does NOT itself emit (no fresh probe ran)', async () => {
    const assertGitAvailable = () => {
      throw new GitNotAvailableError('linux', LINUX_GUIDANCE);
    };
    const showMessageBox = showMessageBoxSequence([0, 2]);
    const openExternal = vi.fn(async () => {});

    const outcome = await ensureGitAvailable({
      assertGitAvailable,
      // biome-ignore lint/suspicious/noExplicitAny: vi.doMock returns the spy
      showMessageBox: showMessageBox as any,
      openExternal,
    });

    expect(outcome).toBe('aborted');
    expect(emissions).toHaveLength(1);
  });
});
