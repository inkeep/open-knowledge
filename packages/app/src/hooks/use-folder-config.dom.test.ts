import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/documents-events', () => ({
  subscribeToTemplatesChanged: () => () => {},
}));

const { useAllTemplates } = await import('./use-folder-config');

const template = {
  name: 'meeting-notes',
  title: 'Meeting Notes',
  path: 'meetings/.ok/templates/meeting-notes.md',
  source_folder: 'meetings',
};

function stubTemplatesResponse(body: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useAllTemplates', () => {
  test.each([true, false])('surfaces the server truncated flag: %s', async (truncated) => {
    const fetchMock = stubTemplatesResponse({ templates: [template], truncated });
    const { result } = renderHook(() => useAllTemplates());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledWith('/api/templates');
    expect(result.current).toEqual({
      status: 'ready',
      data: { templates: [template], truncated },
    });
  });

  test('a response missing the truncated flag is reported as an error', async () => {
    stubTemplatesResponse({ templates: [template] });
    const { result } = renderHook(() => useAllTemplates());

    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});
