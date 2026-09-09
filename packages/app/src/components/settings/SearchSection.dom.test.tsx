import {
  type Config,
  type ConfigBinding,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
  type SemanticIndexStatus,
} from '@inkeep/open-knowledge-core';
import { i18n } from '@lingui/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { describedTextOf } from './settings-a11y.test-helper';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

let mockProjectLocalConfig: Config | null = null;
let mockProjectLocalSynced = true;
let mockProjectLocalBinding: ConfigBinding | null = null;

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    projectBinding: null,
    projectLocalBinding: mockProjectLocalBinding,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: null,
    projectLocalConfig: mockProjectLocalConfig,
    projectLocalSynced: mockProjectLocalSynced,
    merged: null,
  }),
}));

const { SearchSection } = await import('./SearchSection');

function configWithSemantic({
  enabled,
  baseUrl,
  model,
  maxBatchSize,
  maxBatchChars,
  docTimeoutMs,
}: {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  maxBatchSize?: number;
  maxBatchChars?: number;
  docTimeoutMs?: number;
}): Config {
  return {
    search: {
      semantic: {
        enabled,
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
        ...(maxBatchChars !== undefined ? { maxBatchChars } : {}),
        ...(docTimeoutMs !== undefined ? { docTimeoutMs } : {}),
      },
    },
  } as unknown as Config;
}

function makeBinding(onPatch?: () => void): { binding: ConfigBinding; calls: unknown[] } {
  const calls: unknown[] = [];
  const binding = {
    current: () => ({}),
    patch: (patch: unknown) => {
      calls.push(patch);
      onPatch?.();
      return { ok: true, value: { applied: [], effective: {} } };
    },
    subscribe: () => () => {},
    hasSynced: () => true,
    subscribeSynced: () => () => {},
    dispose: () => {},
  } as unknown as ConfigBinding;
  return { binding, calls };
}

let mockStatus: SemanticIndexStatus | null = null;
const originalFetch = global.fetch;

beforeEach(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  mockProjectLocalConfig = null;
  mockProjectLocalSynced = true;
  mockProjectLocalBinding = null;
  mockStatus = null;
  global.fetch = (async () => ({
    ok: true,
    json: async () => mockStatus,
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  vi.useRealTimers();
});

describe('SearchSection', () => {
  test('off: switch is unchecked, body says no content leaves, no coverage panel', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const toggle = screen.getByTestId('settings-search-semantic-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('settings-search-body').textContent).toContain(
      'No content leaves this computer',
    );
    expect(screen.queryByTestId('settings-search-coverage')).toBeNull();
    expect(screen.queryByTestId('settings-search-needs-key')).toBeNull();
  });

  test('the egress disclosure is announced with the toggle, not just shown beside it', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });

    render(<SearchSection />);

    expect(describedTextOf('settings-search-semantic-toggle')).toContain(
      'sent to your embeddings provider',
    );
  });

  test('toggle is disabled until the project-local binding has synced', () => {
    mockProjectLocalBinding = null;
    mockProjectLocalSynced = false;

    render(<SearchSection />);

    expect(
      screen.getByTestId('settings-search-semantic-toggle').getAttribute('disabled'),
    ).not.toBeNull();
  });

  test('enabling opens the egress confirm dialog and does NOT write until confirmed', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    await user.click(screen.getByTestId('settings-search-semantic-toggle'));

    expect(await screen.findByText('This sends content off your machine')).toBeDefined();
    expect(calls.length).toBe(0);

    await user.click(screen.getByTestId('settings-search-confirm-enable'));

    expect(calls).toEqual([{ search: { semantic: { enabled: true } } }]);
  });

  test('disabling commits immediately with no confirmation dialog', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: true,
      keyNotRequired: false,
      keySource: 'file',
      ready: true,
      capable: true,
      embedded: 2,
      total: 5,
    };

    render(<SearchSection />);

    await user.click(screen.getByTestId('settings-search-semantic-toggle'));

    expect(screen.queryByText('This sends content off your machine')).toBeNull();
    expect(calls).toEqual([{ search: { semantic: { enabled: false } } }]);
  });

  test('on + keyed + warmed + capable: shows read-only coverage', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: true,
      keyNotRequired: false,
      keySource: 'file',
      ready: true,
      capable: true,
      embedded: 3,
      total: 5,
    };

    render(<SearchSection />);

    const coverage = await screen.findByTestId('settings-search-coverage');
    expect(coverage.textContent).toMatch(/Indexed\s*3\s*of\s*5/);
  });

  test('on + capable but nothing embedded yet: shows the lazy-warm hint', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: true,
      keyNotRequired: false,
      keySource: 'file',
      ready: true,
      capable: true,
      embedded: 0,
      total: 5,
    };

    render(<SearchSection />);

    const coverage = await screen.findByTestId('settings-search-coverage');
    expect(coverage.textContent).toContain('first time a search needs them');
  });

  test('on + NO key: shows the needs-a-key hint pointing at the on-screen field (instant, no warm)', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: false,
      keyNotRequired: false,
      keySource: null,
      ready: false,
      capable: false,
      embedded: 0,
      total: 5,
    };

    render(<SearchSection />);

    const hint = await screen.findByTestId('settings-search-needs-key');
    expect(hint.textContent).toContain('no API key is set');
    expect(hint.textContent).toContain('below');
    expect(screen.queryByTestId('settings-search-coverage')).toBeNull();
    expect(screen.queryByTestId('settings-search-pending')).toBeNull();
  });

  test('on + key present but provider rejected it: shows the provider-error hint', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: true,
      keyNotRequired: false,
      keySource: 'file',
      ready: true,
      capable: false,
      embedded: 0,
      total: 5,
    };

    render(<SearchSection />);

    const err = await screen.findByTestId('settings-search-provider-error');
    expect(err.textContent).toContain('rejected it');
    expect(screen.queryByTestId('settings-search-needs-key')).toBeNull();
  });

  test('on + keyed but not warmed: shows the pending state', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: true,
      keyNotRequired: false,
      keySource: 'file',
      ready: false,
      capable: false,
      embedded: 0,
      total: 5,
    };

    render(<SearchSection />);

    const pending = await screen.findByTestId('settings-search-pending');
    expect(pending.textContent).toContain('activates the first time');
    expect(screen.queryByTestId('settings-search-needs-key')).toBeNull();
    expect(screen.queryByTestId('settings-search-coverage')).toBeNull();
  });

  test('on but server not yet settled: shows the applying state', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: false,
      keyPresent: false,
      keyNotRequired: false,
      keySource: null,
      ready: false,
      capable: false,
      embedded: 0,
      total: 5,
    };

    render(<SearchSection />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-search-settling').textContent).toContain(
        'Applying your change',
      ),
    );
  });

  test('cancelling the confirm dialog writes nothing and leaves the toggle off', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    await user.click(screen.getByTestId('settings-search-semantic-toggle'));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(calls.length).toBe(0);
    expect(screen.getByTestId('settings-search-semantic-toggle').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('write failure keeps the confirm dialog open for retry (egress consent invariant)', async () => {
    const user = userEvent.setup();
    const failBinding = {
      ...makeBinding().binding,
      patch: () => ({ ok: false, error: { code: 'noop', message: 'fail' } }),
    } as unknown as ConfigBinding;
    mockProjectLocalBinding = failBinding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    await user.click(screen.getByTestId('settings-search-semantic-toggle'));
    await user.click(await screen.findByTestId('settings-search-confirm-enable'));

    expect(await screen.findByTestId('settings-search-confirm')).toBeDefined();
  });

  async function openCustomEndpoint(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('settings-search-custom-endpoint-trigger'));
    return screen.getByTestId('settings-search-base-url') as HTMLInputElement;
  }

  async function openPerformanceTuning(user: ReturnType<typeof userEvent.setup>) {
    const trigger = screen.getByTestId('settings-search-performance-trigger');
    if (screen.queryByTestId('settings-search-max-batch-size') === null) await user.click(trigger);
  }

  async function confirmProviderChange(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByTestId('settings-search-provider-confirm-apply'));
  }

  const DEFAULT_MODEL = 'text-embedding-3-small';

  test('shows the default endpoint and model when nothing is overridden', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    expect(input.value).toBe(DEFAULT_EMBEDDINGS_BASE_URL);
    expect((screen.getByTestId('settings-search-model') as HTMLInputElement).value).toBe(
      DEFAULT_MODEL,
    );
  });

  test('shows legacy transport defaults and does not persist machine-specific values in a new project', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);
    await openPerformanceTuning(user);

    expect((screen.getByTestId('settings-search-max-batch-size') as HTMLInputElement).value).toBe(
      String(DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE),
    );
    expect((screen.getByTestId('settings-search-max-batch-chars') as HTMLInputElement).value).toBe(
      String(DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS),
    );
    expect(
      (screen.getByTestId('settings-search-doc-timeout-seconds') as HTMLInputElement).value,
    ).toBe(String(DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS / 1000));
    expect(calls).toEqual([]);
  });

  test('describes tuning controls in terms of embedding requests', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);
    await openPerformanceTuning(user);

    expect(screen.getByTestId('settings-search-performance-trigger').textContent).toContain(
      'Embedding request settings',
    );
    expect(
      screen.getByText(
        'Adjust indexing request size and timeout for slow or memory-constrained embedding servers. Most setups should keep the defaults.',
      ),
    ).toBeDefined();
    expect(screen.getByLabelText('Maximum text chunks per indexing request')).toBeDefined();
    expect(
      screen.getByText(
        'Lower this to reduce memory use and work per request. Smaller batches send more requests and may make indexing slower overall.',
      ),
    ).toBeDefined();
    expect(screen.getByLabelText('Character budget per indexing request')).toBeDefined();
    expect(
      screen.getByText(
        'Limits the combined text sent in each request. A single larger chunk is sent on its own; documents are not split again.',
      ),
    ).toBeDefined();
    expect(screen.getByLabelText('Indexing request timeout (seconds)')).toBeDefined();
    expect(
      screen.getByText(
        'How long OpenKnowledge waits for each embedding request while indexing. Search requests use a fixed 8-second timeout per attempt, unchanged by this setting.',
      ),
    ).toBeDefined();
  });

  test('reaches the tuning controls without opening the Custom endpoint disclosure', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    expect(screen.queryByTestId('settings-search-base-url')).toBeNull();
    await user.click(screen.getByTestId('settings-search-performance-trigger'));

    expect(screen.getByTestId('settings-search-max-batch-size')).toBeDefined();
    expect(screen.queryByTestId('settings-search-base-url')).toBeNull();
  });

  test('describes the custom endpoint disclosure', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);
    await openCustomEndpoint(user);

    expect(
      screen.getByText(
        'Point semantic search at any OpenAI-compatible embeddings endpoint — a self-hosted server or another provider. The API key above is for whichever endpoint you set here.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText('Clear the field to reset back to the default OpenAI endpoint.'),
    ).toBeDefined();
    expect(screen.queryByTestId('settings-search-max-batch-size')).toBeNull();
  });

  test('existing transport overrides auto-expand and display seconds for the timeout', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({
      enabled: false,
      maxBatchSize: 2,
      maxBatchChars: 16_000,
      docTimeoutMs: 120_000,
    });

    render(<SearchSection />);

    expect((screen.getByTestId('settings-search-max-batch-size') as HTMLInputElement).value).toBe(
      '2',
    );
    expect((screen.getByTestId('settings-search-max-batch-chars') as HTMLInputElement).value).toBe(
      '16000',
    );
    expect(
      (screen.getByTestId('settings-search-doc-timeout-seconds') as HTMLInputElement).value,
    ).toBe('120');
  });

  test.each([
    ['settings-search-max-batch-size', 'maxBatchSize', '2', 2],
    ['settings-search-max-batch-size', 'maxBatchSize', '1', 1],
    ['settings-search-max-batch-size', 'maxBatchSize', '2048', 2048],
    ['settings-search-max-batch-chars', 'maxBatchChars', '16000', 16_000],
    ['settings-search-max-batch-chars', 'maxBatchChars', '1', 1],
    ['settings-search-max-batch-chars', 'maxBatchChars', '16384000', 16_384_000],
    ['settings-search-doc-timeout-seconds', 'docTimeoutMs', '120', 120_000],
    ['settings-search-doc-timeout-seconds', 'docTimeoutMs', '0.001', 1],
    ['settings-search-doc-timeout-seconds', 'docTimeoutMs', '600', 600_000],
  ])(
    'commits %s directly without a provider-change confirmation',
    async (id, key, draft, value) => {
      const user = userEvent.setup();
      const { binding, calls } = makeBinding();
      mockProjectLocalBinding = binding;
      mockProjectLocalConfig = configWithSemantic({ enabled: false });

      render(<SearchSection />);
      await openPerformanceTuning(user);
      const input = screen.getByTestId(id);
      await user.clear(input);
      await user.type(input, `${draft}{Enter}`);

      expect(calls).toEqual([{ search: { semantic: { [key]: value } } }]);
      expect(screen.queryByTestId(`${id}-error`)).toBeNull();
      expect(screen.queryByTestId('settings-search-provider-confirm')).toBeNull();
    },
  );

  test('resetting the final override keeps the disclosure open and the field focused', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding(() => {
      mockProjectLocalConfig = configWithSemantic({ enabled: false });
      view.rerender(<SearchSection />);
    });
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, maxBatchSize: 2 });
    const view = render(<SearchSection />);
    const input = screen.getByTestId('settings-search-max-batch-size');

    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(calls).toEqual([
      { search: { semantic: { maxBatchSize: DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE } } },
    ]);
    expect(screen.getByTestId('settings-search-max-batch-size')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(
      screen.getByTestId('settings-search-performance-trigger').getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByTestId('settings-search-max-batch-size-saved').textContent).toBe('Saved');
  });

  test('a tuning commit refreshes status immediately and after the server settles', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true, maxBatchSize: 2 });
    mockStatus = {
      enabled: true,
      keyPresent: true,
      ready: true,
      capable: true,
      embedded: 4,
      total: 4,
    } as SemanticIndexStatus;
    const fetchStatus = vi.fn(global.fetch);
    global.fetch = fetchStatus;
    render(<SearchSection />);
    await screen.findByTestId('settings-search-coverage');
    mockStatus = { ...mockStatus, ready: false };
    const input = screen.getByTestId('settings-search-max-batch-size');
    await user.clear(input);
    await user.type(input, '4');
    fetchStatus.mockClear();
    vi.useFakeTimers();

    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-search-pending')).toBeTruthy();
    mockStatus = { ...mockStatus, ready: true };
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('settings-search-coverage').textContent).toContain('Indexed 4 of 4');
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  test('Saved feedback expires, clears when editing resumes, and timers stop on unmount', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, maxBatchSize: 2 });
    const view = render(<SearchSection />);
    const input = screen.getByTestId('settings-search-max-batch-size');
    await user.clear(input);
    await user.type(input, '4');
    vi.useFakeTimers();

    fireEvent.keyDown(input, { key: 'Enter' });
    const help = screen.getByTestId('settings-search-max-batch-size-help');
    const message = screen.getByTestId('settings-search-max-batch-size-saved');
    expect(message.textContent).toBe('Saved');
    expect(help.textContent).toContain('Lower this');
    expect(help.getAttribute('aria-live')).toBeNull();
    expect(message.getAttribute('aria-live')).toBe('polite');
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(message.textContent).toBe('');
    expect(help.textContent).toContain('Lower this');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(message.textContent).toBe('Saved');
    fireEvent.change(input, { target: { value: '6' } });
    expect(message.textContent).toBe('');
    fireEvent.keyDown(input, { key: 'Enter' });
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    ['settings-search-max-batch-size', 'Lower this'],
    ['settings-search-max-batch-chars', 'Limits the combined text'],
    ['settings-search-doc-timeout-seconds', 'How long OpenKnowledge waits'],
  ])('associates %s with stable help, status, and reset instructions', async (id, help) => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });
    render(<SearchSection />);
    await openPerformanceTuning(user);

    expect(describedTextOf(id)).toContain(help);
    expect(describedTextOf(id)).toContain('Clear a field to restore its default value.');
    expect(screen.getByTestId(id).getAttribute('aria-describedby')?.split(' ')).toContain(
      `${id}-message`,
    );
    expect(screen.getByTestId(`${id}-help`).getAttribute('aria-live')).toBeNull();
    const status = screen.getByTestId(`${id}-saved`);
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
  });

  test('clearing tuning fields resets them to the OpenKnowledge defaults', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, maxBatchSize: 2 });

    render(<SearchSection />);
    const input = screen.getByTestId('settings-search-max-batch-size');
    await user.clear(input);
    await user.tab();

    expect(calls).toEqual([
      { search: { semantic: { maxBatchSize: DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE } } },
    ]);
    expect((input as HTMLInputElement).value).toBe(String(DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE));
  });

  test('clearing the timeout resets it to the default in milliseconds, shown in seconds', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, docTimeoutMs: 120_000 });

    render(<SearchSection />);
    const input = screen.getByTestId('settings-search-doc-timeout-seconds');
    await user.clear(input);
    await user.tab();

    expect(calls).toEqual([
      { search: { semantic: { docTimeoutMs: DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS } } },
    ]);
    expect((input as HTMLInputElement).value).toBe(
      String(DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS / 1000),
    );
  });

  test('blurring an unchanged tuning field writes nothing to project-local config', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);
    await openPerformanceTuning(user);
    await user.click(screen.getByTestId('settings-search-max-batch-size'));
    await user.tab();
    await user.click(screen.getByTestId('settings-search-doc-timeout-seconds'));
    await user.tab();

    expect(calls).toEqual([]);
  });

  test('a sub-second timeout set outside the UI round-trips instead of erroring', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, docTimeoutMs: 1500 });

    render(<SearchSection />);
    const input = screen.getByTestId('settings-search-doc-timeout-seconds');
    expect((input as HTMLInputElement).value).toBe('1.5');

    await user.click(input);
    await user.tab();

    expect(calls).toEqual([]);
    expect(screen.queryByTestId('settings-search-doc-timeout-seconds-error')).toBeNull();

    await user.clear(input);
    await user.type(input, '2.5{Enter}');
    expect(calls).toEqual([{ search: { semantic: { docTimeoutMs: 2500 } } }]);
  });

  test.each(['0', '-1', '1.5', '2049', 'not-a-number'])(
    'rejects invalid tuning input %s with accessible inline feedback',
    async (invalid) => {
      const user = userEvent.setup();
      const { binding, calls } = makeBinding();
      mockProjectLocalBinding = binding;
      mockProjectLocalConfig = configWithSemantic({ enabled: false });

      render(<SearchSection />);
      await openPerformanceTuning(user);
      const input = screen.getByTestId('settings-search-max-batch-size');
      await user.clear(input);
      await user.type(input, `${invalid}{Enter}`);

      expect(calls).toEqual([]);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(
        'settings-search-max-batch-size-message',
      );
      const message = screen.getByTestId('settings-search-max-batch-size-error');
      expect(message.getAttribute('aria-live')).toBe('polite');
      expect(message.textContent).toContain('whole number between 1 and 2,048');
    },
  );

  test.each(['0', '-1', '0.0009', '600.001', '120000', 'not-a-number'])(
    'rejects invalid timeout %s and explains the range in seconds',
    async (invalid) => {
      const user = userEvent.setup();
      const { binding, calls } = makeBinding();
      mockProjectLocalBinding = binding;
      mockProjectLocalConfig = configWithSemantic({ enabled: false });
      render(<SearchSection />);
      await openPerformanceTuning(user);
      const input = screen.getByTestId('settings-search-doc-timeout-seconds');
      await user.clear(input);
      await user.type(input, `${invalid}{Enter}`);

      expect(calls).toEqual([]);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(describedTextOf('settings-search-doc-timeout-seconds')).toContain(
        'seconds between 0.001 and 600',
      );
    },
  );

  test('rejects a character budget above its bound without writing config', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });
    render(<SearchSection />);
    await openPerformanceTuning(user);
    const input = screen.getByTestId('settings-search-max-batch-chars');
    await user.clear(input);
    await user.type(input, '16384001{Enter}');

    expect(calls).toEqual([]);
    expect(describedTextOf('settings-search-max-batch-chars')).toContain(
      'whole number between 1 and 16,384,000',
    );
  });

  test.each([
    ['en', 'settings-search-max-batch-chars', '16384001', '16,384,000'],
    ['fr', 'settings-search-max-batch-chars', '16384001', '16\u202f384\u202f000'],
    ['fr', 'settings-search-doc-timeout-seconds', '0', '0,001'],
  ])('formats the %s locale bounds in %s errors', async (locale, id, value, expected) => {
    i18n.loadAndActivate({ locale, messages: {} });
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });
    render(<SearchSection />);
    await openPerformanceTuning(user);
    const input = screen.getByTestId(id);
    await user.clear(input);
    await user.type(input, `${value}{Enter}`);

    expect(calls).toEqual([]);
    expect(screen.getByTestId(`${id}-error`).textContent).toContain(expected);
  });

  test('tuning inputs remain disabled until the project-local binding has synced', () => {
    mockProjectLocalBinding = null;
    mockProjectLocalSynced = false;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, maxBatchSize: 2 });

    render(<SearchSection />);
    expect(
      screen.getByTestId('settings-search-max-batch-size').getAttribute('disabled'),
    ).not.toBeNull();
  });

  test('external config changes reseed tuning drafts', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, maxBatchSize: 2 });
    const view = render(<SearchSection />);
    expect((screen.getByTestId('settings-search-max-batch-size') as HTMLInputElement).value).toBe(
      '2',
    );

    mockProjectLocalConfig = configWithSemantic({ enabled: false, maxBatchSize: 4 });
    view.rerender(<SearchSection />);

    await waitFor(() =>
      expect((screen.getByTestId('settings-search-max-batch-size') as HTMLInputElement).value).toBe(
        '4',
      ),
    );
  });

  test('a tuning patch failure preserves the draft and exposes an inline live error', async () => {
    const user = userEvent.setup();
    const failBinding = {
      ...makeBinding().binding,
      patch: () => ({ ok: false, error: { code: 'noop', message: 'disk unavailable' } }),
    } as unknown as ConfigBinding;
    mockProjectLocalBinding = failBinding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, maxBatchSize: 2 });

    render(<SearchSection />);
    const input = screen.getByTestId('settings-search-max-batch-size') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '4{Enter}');

    expect(input.value).toBe('4');
    const error = screen.getByTestId('settings-search-max-batch-size-error');
    expect(error.getAttribute('aria-live')).toBe('polite');
    expect(error.textContent).toContain('Failed to update performance setting');
  });

  test('the disclosure starts open when a custom endpoint is already configured', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({
      enabled: false,
      baseUrl: 'https://my-vllm.internal/v1',
    });

    render(<SearchSection />);

    expect((screen.getByTestId('settings-search-base-url') as HTMLInputElement).value).toBe(
      'https://my-vllm.internal/v1',
    );
  });

  test('the disclosure starts open when only the model is overridden', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, model: 'nomic-embed-text' });

    render(<SearchSection />);

    expect((screen.getByTestId('settings-search-model') as HTMLInputElement).value).toBe(
      'nomic-embed-text',
    );
  });

  test('blurring the endpoint field writes the trimmed custom base URL after confirmation', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, '  https://azure.example.com/openai/v1/  ');
    await user.tab();

    expect(calls).toEqual([]);
    await confirmProviderChange(user);

    expect(calls).toEqual([
      {
        search: {
          semantic: { baseUrl: 'https://azure.example.com/openai/v1/', model: DEFAULT_MODEL },
        },
      },
    ]);
  });

  test('pressing Enter in the endpoint field commits the same way', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, '  https://azure.example.com/openai/v1/  {Enter}');
    await confirmProviderChange(user);

    expect(calls).toEqual([
      {
        search: {
          semantic: { baseUrl: 'https://azure.example.com/openai/v1/', model: DEFAULT_MODEL },
        },
      },
    ]);
  });

  test('a custom model is written as free text', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    await openCustomEndpoint(user);
    const model = screen.getByTestId('settings-search-model');
    await user.clear(model);
    await user.type(model, 'nomic-embed-text{Enter}');
    await confirmProviderChange(user);

    expect(calls).toEqual([
      {
        search: { semantic: { baseUrl: DEFAULT_EMBEDDINGS_BASE_URL, model: 'nomic-embed-text' } },
      },
    ]);
  });

  test('clearing the model field resets it to the default', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false, model: 'nomic-embed-text' });

    render(<SearchSection />);

    const model = screen.getByTestId('settings-search-model');
    await user.clear(model);
    await user.tab();
    await confirmProviderChange(user);

    expect(calls).toEqual([
      { search: { semantic: { baseUrl: DEFAULT_EMBEDDINGS_BASE_URL, model: DEFAULT_MODEL } } },
    ]);
  });

  test('cancelling the warning restores the previous values and writes nothing', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, 'https://my-vllm.internal/v1{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(calls).toEqual([]);
    await waitFor(() =>
      expect((screen.getByTestId('settings-search-base-url') as HTMLInputElement).value).toBe(
        DEFAULT_EMBEDDINGS_BASE_URL,
      ),
    );
  });

  test('clearing the endpoint field resets it to the default OpenAI endpoint', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({
      enabled: false,
      baseUrl: 'https://azure.example.com/openai/v1',
    });

    render(<SearchSection />);

    const input = screen.getByTestId('settings-search-base-url');
    await user.clear(input);
    await user.tab();
    await confirmProviderChange(user);

    expect(calls).toEqual([
      { search: { semantic: { baseUrl: DEFAULT_EMBEDDINGS_BASE_URL, model: DEFAULT_MODEL } } },
    ]);
  });

  test('a malformed URL is not flagged mid-typing, but errors on commit and blocks the write', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, 'not-a-url');

    expect(screen.queryByTestId('settings-search-base-url-error')).toBeNull();

    await user.tab();

    expect(screen.getByTestId('settings-search-base-url-error')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('settings-search-provider-confirm')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('committing an invalid URL via Enter also errors and blocks the write', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, 'not-a-url{Enter}');

    expect(screen.getByTestId('settings-search-base-url-error')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(calls).toEqual([]);
  });

  test('a plaintext non-loopback endpoint errors on commit and blocks the write', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, 'http://azure.example.com/v1');
    await user.tab();

    expect(screen.getByTestId('settings-search-base-url-error')).toBeDefined();
    expect(calls).toEqual([]);
  });

  test('an http loopback endpoint is accepted (no error) and written', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, 'http://localhost:11434/v1');
    await user.tab();
    await confirmProviderChange(user);

    expect(screen.queryByTestId('settings-search-base-url-error')).toBeNull();
    expect(calls).toEqual([
      { search: { semantic: { baseUrl: 'http://localhost:11434/v1', model: DEFAULT_MODEL } } },
    ]);
  });

  test('after a failed commit, fixing the value clears the error live and writes on re-commit', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: false });

    render(<SearchSection />);

    const input = await openCustomEndpoint(user);
    await user.clear(input);
    await user.type(input, 'nope');
    await user.tab();
    expect(screen.getByTestId('settings-search-base-url-error')).toBeDefined();

    await user.clear(input);
    await user.type(input, 'https://azure.example.com/openai/v1');
    expect(screen.queryByTestId('settings-search-base-url-error')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('false');

    await user.tab();
    await confirmProviderChange(user);
    expect(calls).toEqual([
      {
        search: {
          semantic: { baseUrl: 'https://azure.example.com/openai/v1', model: DEFAULT_MODEL },
        },
      },
    ]);
  });

  test('a successful connection test reports the detected vector size', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({
      enabled: true,
      baseUrl: 'https://my-vllm.internal/v1',
      model: 'nomic-embed-text',
    });

    render(
      <SearchSection
        transport={{
          setKey: async () => ({ ok: true }),
          clearKey: async () => ({ ok: true }),
          testConnection: async () => ({
            ok: true,
            endpoint: 'https://my-vllm.internal/v1',
            model: 'nomic-embed-text',
            dimensions: 1024,
          }),
        }}
      />,
    );

    await user.click(screen.getByTestId('settings-search-test-connection'));
    const result = await screen.findByTestId('settings-search-test-ok');
    expect(result.textContent).toContain('1024');
  });

  test('a failing connection test names the specific reason', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({
      enabled: true,
      baseUrl: 'https://my-vllm.internal/v1',
    });

    render(
      <SearchSection
        transport={{
          setKey: async () => ({ ok: true }),
          clearKey: async () => ({ ok: true }),
          testConnection: async () => ({
            ok: false,
            endpoint: 'https://my-vllm.internal/v1',
            model: 'text-embedding-3-small',
            reason: 'http_error',
            status: 401,
          }),
        }}
      />,
    );

    await user.click(screen.getByTestId('settings-search-test-connection'));
    const result = await screen.findByTestId('settings-search-test-error');
    expect(result.textContent).toContain('401');
  });

  test('a verdict for a stale endpoint says so instead of reporting it', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({
      enabled: true,
      baseUrl: 'https://my-vllm.internal/v1',
    });

    render(
      <SearchSection
        transport={{
          setKey: async () => ({ ok: true }),
          clearKey: async () => ({ ok: true }),
          testConnection: async () => ({
            ok: true,
            endpoint: DEFAULT_EMBEDDINGS_BASE_URL,
            model: 'text-embedding-3-small',
            dimensions: 1536,
          }),
        }}
      />,
    );

    await user.click(screen.getByTestId('settings-search-test-connection'));
    expect(await screen.findByTestId('settings-search-test-stale')).toBeDefined();
    expect(screen.queryByTestId('settings-search-test-ok')).toBeNull();
  });

  test('the API key field is always visible (not buried in the disclosure)', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: false,
      keyNotRequired: false,
      keySource: null,
      keyHint: null,
      ready: false,
      capable: false,
      embedded: 0,
      total: 3,
    } as unknown as SemanticIndexStatus;

    render(<SearchSection />);
    expect(screen.getByTestId('settings-search-key-input')).toBeDefined();
  });

  test('saving a key calls the transport and refreshes', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: false,
      keyNotRequired: false,
      keySource: null,
      keyHint: null,
      ready: false,
      capable: false,
      embedded: 0,
      total: 3,
    } as unknown as SemanticIndexStatus;

    const setKey = vi.fn(async () => ({ ok: true }) as const);
    render(
      <SearchSection
        transport={{
          setKey,
          clearKey: async () => ({ ok: true }),
          testConnection: async () => null,
        }}
      />,
    );

    const input = await screen.findByTestId('settings-search-key-input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    await user.type(input, 'sk-my-key');
    await user.click(screen.getByTestId('settings-search-key-save'));
    expect(setKey).toHaveBeenCalledWith('sk-my-key');
  });

  test('pressing Enter in the key field saves (parity with endpoint/model)', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: false,
      keyNotRequired: false,
      keySource: null,
      keyHint: null,
      ready: false,
      capable: false,
      embedded: 0,
      total: 3,
    } as unknown as SemanticIndexStatus;

    const setKey = vi.fn(async () => ({ ok: true }) as const);
    render(
      <SearchSection
        transport={{
          setKey,
          clearKey: async () => ({ ok: true }),
          testConnection: async () => null,
        }}
      />,
    );

    const input = await screen.findByTestId('settings-search-key-input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    await user.type(input, 'sk-enter-key{Enter}');
    expect(setKey).toHaveBeenCalledWith('sk-enter-key');
  });

  test('a failed key save surfaces the error, does not clear the input', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: false,
      keyNotRequired: false,
      keySource: null,
      keyHint: null,
      ready: false,
      capable: false,
      embedded: 0,
      total: 3,
    } as unknown as SemanticIndexStatus;

    render(
      <SearchSection
        transport={{
          setKey: async () => ({ ok: false, error: 'disk full' }),
          clearKey: async () => ({ ok: true }),
          testConnection: async () => null,
        }}
      />,
    );

    const input = await screen.findByTestId('settings-search-key-input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    await user.type(input, 'sk-doomed');
    await user.click(screen.getByTestId('settings-search-key-save'));
    const err = await screen.findByTestId('settings-search-key-error');
    expect(err.textContent).toContain('disk full');
    expect((input as HTMLInputElement).value).toBe('sk-doomed');
  });

  test('a present key shows a redacted hint + Clear, never the key', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({ enabled: true });
    mockStatus = {
      enabled: true,
      keyPresent: true,
      keyNotRequired: false,
      keySource: 'project',
      keyHint: '9xяz'.slice(-4),
      ready: true,
      capable: true,
      embedded: 3,
      total: 3,
    } as unknown as SemanticIndexStatus;

    const clearKey = vi.fn(async () => ({ ok: true }) as const);
    render(
      <SearchSection
        transport={{
          setKey: async () => ({ ok: true }),
          clearKey,
          testConnection: async () => null,
        }}
      />,
    );

    expect(await screen.findByTestId('settings-search-key-hint')).toBeDefined();
    await user.click(screen.getByTestId('settings-search-key-clear'));
    expect(clearKey).toHaveBeenCalled();
  });

  test('a localhost endpoint shows the key as not required, and no needs-key nag', async () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithSemantic({
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
    });
    mockStatus = {
      enabled: true,
      keyPresent: false,
      keyNotRequired: true,
      keySource: null,
      keyHint: null,
      ready: false,
      capable: false,
      embedded: 0,
      total: 3,
    } as unknown as SemanticIndexStatus;

    render(<SearchSection />);
    await waitFor(() =>
      expect(screen.getByTestId('settings-search-key').textContent).toContain('Not required'),
    );
    expect(screen.queryByTestId('settings-search-needs-key')).toBeNull();
  });
});
