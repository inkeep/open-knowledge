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

  for (const trigger of ['local skills-changed', 'cross-client CC1 files'] as const) {
    test(`a mutation mid-flight is not served pre-write data (${trigger})`, async () => {
      const { useSkills, emitSkillsChanged, emitDocumentsChanged } = await freshModules();

      let release: ((body: unknown) => void) | undefined;
      const first = new Promise<unknown>((resolve) => {
        release = resolve;
      });

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
      expect(screen.getByTestId('names').textContent).toBe('loading');
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      if (trigger === 'local skills-changed') emitSkillsChanged();
      else emitDocumentsChanged(['files']);
      await new Promise((r) => setTimeout(r, 400));

      expect(fetchMock).toHaveBeenCalledTimes(1);

      release?.(skillsBody(['kept', 'removed']));

      await waitFor(() => expect(screen.getByTestId('names').textContent).toBe('kept'));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(maxLive).toBe(1);
    });
  }

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
