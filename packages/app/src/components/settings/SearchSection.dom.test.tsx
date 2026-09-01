import {
  type Config,
  type ConfigBinding,
  DEFAULT_EMBEDDINGS_BASE_URL,
  type SemanticIndexStatus,
} from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
}: {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
}): Config {
  return {
    search: { semantic: { enabled, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) } },
  } as unknown as Config;
}

function makeBinding(): { binding: ConfigBinding; calls: unknown[] } {
  const calls: unknown[] = [];
  const binding = {
    current: () => ({}),
    patch: (patch: unknown) => {
      calls.push(patch);
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
