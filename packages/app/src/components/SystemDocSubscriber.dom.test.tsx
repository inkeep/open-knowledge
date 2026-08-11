import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

type ProviderHandler = () => void;

let provider: { emitSynced(): void } | null = null;
const emittedChannels: string[][] = [];
const setSystemProvider = vi.fn();

vi.doMock('@hocuspocus/provider', () => {
  class FakeHocuspocusProvider {
    private readonly handlers = new Map<string, ProviderHandler[]>();
    awareness = {
      getStates: () => new Map(),
      on: () => {},
      off: () => {},
    };

    constructor() {
      provider = this;
    }

    on(event: string, handler: ProviderHandler) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    emitSynced() {
      for (const handler of this.handlers.get('synced') ?? []) handler();
    }

    destroy() {}
  }

  return { HocuspocusProvider: FakeHocuspocusProvider };
});

vi.doMock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    collabUrl: 'ws://localhost:1/collab',
    setSystemProvider,
    updateServerInstanceId: () => {},
    onBranchSwitched: async () => {},
    observeBranch: async () => {},
    observeDiskAck: () => {},
    refreshServerInfo: async () => {},
  }),
}));

vi.doMock('@/editor/lint-config-client', () => ({ emitLintConfigChanged: () => {} }));
vi.doMock('@/lib/config-ignore-nested-error-events', () => ({
  emitConfigIgnoreNestedError: () => {},
}));
vi.doMock('@/lib/config-validation-events', () => ({
  emitConfigValidationRejected: () => {},
}));
vi.doMock('@/lib/documents-events', () => ({
  emitDocPersisted: () => {},
  emitDocumentsChanged: (channels: string[]) => emittedChannels.push(channels),
  subscribeToDocumentsChanged: () => () => {},
}));

const { SystemDocSubscriber } = await import('./SystemDocSubscriber');

afterEach(() => {
  cleanup();
  emittedChannels.length = 0;
  provider = null;
  setSystemProvider.mockClear();
});

test('first system sync recovers local-target invalidations emitted during connection', () => {
  render(<SystemDocSubscriber />);
  expect(provider).not.toBeNull();

  act(() => provider?.emitSynced());

  expect(emittedChannels).toContainEqual(['files', 'backlinks', 'graph', 'local-targets']);
});
