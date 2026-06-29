
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SemanticIndexStatus } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EmbeddingsKeyTransport } from '@/lib/transports/embeddings-key-transport';
import { EmbeddingsKeySection } from './EmbeddingsKeySection';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const g = globalThis as GlobalWithDomShims;
if (g.NodeFilter === undefined && g.window?.NodeFilter !== undefined)
  g.NodeFilter = g.window.NodeFilter;
if (g.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
}

function statusOf(over: Partial<SemanticIndexStatus>): SemanticIndexStatus {
  return {
    enabled: false,
    keyPresent: false,
    keySource: null,
    keyHint: null,
    ready: false,
    capable: false,
    embedded: 0,
    total: 0,
    ...over,
  };
}

let mockStatus: SemanticIndexStatus;
const originalFetch = global.fetch;

function makeTransport(parts?: Partial<EmbeddingsKeyTransport>): {
  transport: EmbeddingsKeyTransport;
  setCalls: string[];
  clearCalls: number;
} {
  const setCalls: string[] = [];
  let clearCalls = 0;
  const transport: EmbeddingsKeyTransport = {
    setKey: async (key) => {
      setCalls.push(key);
      return parts?.setKey ? parts.setKey(key) : { ok: true };
    },
    clearKey: async () => {
      clearCalls += 1;
      return parts?.clearKey ? parts.clearKey() : { ok: true };
    },
  };
  return {
    transport,
    setCalls,
    get clearCalls() {
      return clearCalls;
    },
  } as { transport: EmbeddingsKeyTransport; setCalls: string[]; clearCalls: number };
}

beforeEach(() => {
  mockStatus = statusOf({});
  global.fetch = (async () => ({
    ok: true,
    json: async () => mockStatus,
  })) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe('EmbeddingsKeySection', () => {
  test('no key: shows an input + Save (disabled until typed), never renders a key', async () => {
    const { transport } = makeTransport();
    mockStatus = statusOf({ keyPresent: false });
    render(<EmbeddingsKeySection transport={transport} />);

    const input = screen.getByTestId('settings-embeddings-key-input');
    expect(input.getAttribute('type')).toBe('password');
    expect(
      screen.getByTestId('settings-embeddings-key-save').getAttribute('disabled'),
    ).not.toBeNull();
    expect(screen.queryByTestId('settings-embeddings-key-set')).toBeNull();
  });

  test('save sends the key to the transport and clears the input', async () => {
    const user = userEvent.setup();
    const rec = makeTransport();
    mockStatus = statusOf({ keyPresent: false });
    render(<EmbeddingsKeySection transport={rec.transport} />);

    const input = screen.getByTestId('settings-embeddings-key-input');
    await user.type(input, 'sk-secret-123');
    await user.click(screen.getByTestId('settings-embeddings-key-save'));

    expect(rec.setCalls).toEqual(['sk-secret-123']);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  test('save failure surfaces the error and keeps the typed key', async () => {
    const user = userEvent.setup();
    const rec = makeTransport({ setKey: async () => ({ ok: false, error: 'Loopback required.' }) });
    mockStatus = statusOf({ keyPresent: false });
    render(<EmbeddingsKeySection transport={rec.transport} />);

    const input = screen.getByTestId('settings-embeddings-key-input');
    await user.type(input, 'sk-bad');
    await user.click(screen.getByTestId('settings-embeddings-key-save'));

    expect(await screen.findByTestId('settings-embeddings-key-error')).toBeDefined();
    expect((input as HTMLInputElement).value).toBe('sk-bad');
  });

  test('key present (file): shows "API key set" + Clear, which calls the transport', async () => {
    const user = userEvent.setup();
    const rec = makeTransport();
    mockStatus = statusOf({ keyPresent: true, keySource: 'file' });
    render(<EmbeddingsKeySection transport={rec.transport} />);

    expect(await screen.findByTestId('settings-embeddings-key-set')).toBeDefined();
    await user.click(screen.getByTestId('settings-embeddings-key-clear'));
    expect(rec.clearCalls).toBe(1);
  });

  test('key present: shows the redacted tail (keyHint), never the full key', async () => {
    const { transport } = makeTransport();
    mockStatus = statusOf({ keyPresent: true, keySource: 'file', keyHint: 'a1b2' });
    render(<EmbeddingsKeySection transport={transport} />);

    const hint = await screen.findByTestId('settings-embeddings-key-hint');
    expect(hint.textContent).toContain('a1b2');
    expect(hint.textContent?.length).toBeLessThan(20);
  });

  test('key present without a hint: the set state still renders (no tail line)', async () => {
    const { transport } = makeTransport();
    mockStatus = statusOf({ keyPresent: true, keySource: 'file', keyHint: null });
    render(<EmbeddingsKeySection transport={transport} />);

    expect(await screen.findByTestId('settings-embeddings-key-set')).toBeDefined();
    expect(screen.queryByTestId('settings-embeddings-key-hint')).toBeNull();
  });

  test('clear failure surfaces the error', async () => {
    const user = userEvent.setup();
    const rec = makeTransport({
      clearKey: async () => ({ ok: false, error: 'Loopback required.' }),
    });
    mockStatus = statusOf({ keyPresent: true, keySource: 'file' });
    render(<EmbeddingsKeySection transport={rec.transport} />);

    await user.click(await screen.findByTestId('settings-embeddings-key-clear'));
    expect(await screen.findByTestId('settings-embeddings-key-error')).toBeDefined();
  });

  test('env-sourced key: read-only note, no input or clear', async () => {
    const { transport } = makeTransport();
    mockStatus = statusOf({ keyPresent: true, keySource: 'env' });
    render(<EmbeddingsKeySection transport={transport} />);

    expect(await screen.findByTestId('settings-embeddings-key-env')).toBeDefined();
    expect(screen.queryByTestId('settings-embeddings-key-input')).toBeNull();
    expect(screen.queryByTestId('settings-embeddings-key-clear')).toBeNull();
  });
});
