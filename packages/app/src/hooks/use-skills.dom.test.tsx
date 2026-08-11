import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const originalFetch = globalThis.fetch;

function skillsBody(names: readonly string[]) {
  return {
    skills: names.map((name) => ({
      scope: 'project',
      name,
      path: `.agents/skills/${name}/SKILL.md`,
      installed: false,
      hosts: [],
    })),
    truncated: false,
  };
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * `useSkills` keeps its shared list, in-flight request and invalidation
 * generation in MODULE state, and vitest gives a fresh registry per FILE, not
 * per test. Without this reset the second test would mount already-`ready` from
 * the first test's `lastKnownSkills` and its `waitFor` would pass before any
 * fetch resolved — green for the wrong reason.
 */
async function freshModules() {
  vi.resetModules();
  const [{ useSkills }, events] = await Promise.all([
    import('./use-skills'),
    import('@/lib/documents-events'),
  ]);
  return { useSkills, ...events };
}

describe('useSkills', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  // The staleness bug: every surface shares ONE in-flight request. A mutation
  // that lands while that request is in the air used to coalesce onto it, so the
  // list settled on PRE-write data and never self-healed — the menu kept showing
  // a skill the user had just removed.
  //
  // Both subscription branches (the local skills-changed bus and the cross-client
  // CC1 `files` signal) route through the same `bump()`, but the WIRING is per
  // branch: a refactor that dropped the remote one, or broke the
  // `channels.includes('files')` filter, would regress cross-window mutations
  // while a local-only test stayed green. So each branch gets its own case.
  for (const trigger of ['local skills-changed', 'cross-client CC1 files'] as const) {
    test(`a mutation mid-flight is not served pre-write data (${trigger})`, async () => {
      const { useSkills, emitSkillsChanged, emitDocumentsChanged } = await freshModules();

      let release: ((body: unknown) => void) | undefined;
      const first = new Promise<unknown>((resolve) => {
        release = resolve;
      });

      // Track concurrency, not just call count: the fix must keep the
      // single-flight ceiling (one full server scan at a time) while still
      // refusing to serve pre-write data.
      let live = 0;
      let maxLive = 0;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () => {
          live++;
          maxLive = Math.max(maxLive, live);
          try {
            return jsonResponse(await first);
          } finally {
            live--;
          }
        })
        .mockImplementation(async () => {
          live++;
          maxLive = Math.max(maxLive, live);
          try {
            return jsonResponse(skillsBody(['kept']));
          } finally {
            live--;
          }
        });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      function Probe() {
        const state = useSkills();
        return (
          <div data-testid="names">
            {state.status === 'ready' ? state.data.map((s) => s.name).join(',') : state.status}
          </div>
        );
      }

      render(<Probe />);
      // Nothing is known yet — proves the module reset actually took, so the
      // assertions below cannot pass on a previous test's cached list.
      expect(screen.getByTestId('names').textContent).toBe('loading');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // The write lands while request #1 is still in the air, and #1 stays in
      // the air past the hook's 200 ms coalescing debounce — so the refetch it
      // schedules is issued while #1 is STILL the shared in-flight promise.
      if (trigger === 'local skills-changed') emitSkillsChanged();
      else emitDocumentsChanged(['files']);
      await new Promise((r) => setTimeout(r, 400));

      // Still exactly one scan: the refetch joined the live request rather than
      // stacking a second concurrent walk of every skills root.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // #1 now lands carrying pre-write data. It must be discarded and re-run,
      // never handed to the caller.
      release?.(skillsBody(['kept', 'removed']));

      await waitFor(() => expect(screen.getByTestId('names').textContent).toBe('kept'));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(maxLive).toBe(1);
    });
  }

  // The remote branch is filtered: a signal on an unrelated channel must NOT
  // invalidate, or every backlink/graph recompute would spin a full skills scan.
  test('a CC1 signal on an unrelated channel does not trigger a refetch', async () => {
    const { useSkills, emitDocumentsChanged } = await freshModules();

    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(skillsBody(['kept'])));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    function Probe() {
      const state = useSkills();
      return <div data-testid="names">{state.status}</div>;
    }

    render(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    emitDocumentsChanged(['backlinks']);
    await new Promise((r) => setTimeout(r, 400));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a hung request cannot wedge the shared list', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('carries an abort signal, so a stalled fetch cannot hang forever', async () => {
    // Every reader joins `inFlightSkills`, and the slot is released only in that
    // promise's `.finally`. Without a signal, one fetch that never settles
    // freezes the skills list for the rest of the session — stale rows, stale
    // toolbar, clicks minting doc names from entries that have since moved —
    // and only a reload clears it, because the slot is module state.
    const { useSkills } = await freshModules();
    const seen: (RequestInit | undefined)[] = [];
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve(jsonResponse(skillsBody(['a'])));
    }) as unknown as typeof fetch;

    function Probe() {
      const state = useSkills();
      return <div data-testid="s">{state.status}</div>;
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('ready'));
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('a failed refresh keeps the last good list instead of blanking it', async () => {
    // Stale beats blank: a refresh that fails (offline, or the 20s abort on a
    // huge skills tree) must not replace a list the user is working from with
    // an error screen. Only a FIRST load has nothing to fall back to.
    const { useSkills, emitSkillsChanged } = await freshModules();
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(jsonResponse(skillsBody(['kept'])))
        : Promise.reject(new Error('TimeoutError'));
    }) as unknown as typeof fetch;

    function Probe() {
      const state = useSkills();
      return (
        <div data-testid="s">
          {state.status === 'ready' ? String(state.data.length) : state.status}
        </div>
      );
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('1'));

    emitSkillsChanged();
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    // Still the good list, NOT 'error'.
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('1'));
  });

  test('a failed request frees the slot — the next signal refetches for real', async () => {
    const { useSkills, emitSkillsChanged } = await freshModules();
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('TimeoutError'))
        : Promise.resolve(jsonResponse(skillsBody(['recovered'])));
    }) as unknown as typeof fetch;

    function Probe() {
      const state = useSkills();
      return (
        <div data-testid="s">
          {state.status === 'ready' ? String(state.data.length) : state.status}
        </div>
      );
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('error'));

    emitSkillsChanged();
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('1'));
  });
});
