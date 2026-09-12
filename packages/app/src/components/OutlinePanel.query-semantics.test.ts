import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const QUERY_KEY = ['page-headings', 'offsite/liveblocks/liveblocks'];

describe('@tanstack/react-query keeps the last successful data beside a refetch error', () => {
  test('a failed refetch retains data while setting error, so the panel must gate its count', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });

    let shouldFail = false;
    const headings = Array.from({ length: 7 }, (_, i) => ({
      level: 2,
      text: `h${i}`,
      slug: `h${i}`,
    }));

    const observer = new QueryObserver(client, {
      queryKey: QUERY_KEY,
      queryFn: async () => {
        if (shouldFail) throw new Error('Page not found.');
        return headings;
      },
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    });

    const unsubscribe = observer.subscribe(() => {});

    await client.fetchQuery({ queryKey: QUERY_KEY, queryFn: async () => headings });

    const ok = observer.getCurrentResult();
    expect((ok.data as unknown[]).length).toBe(7);
    expect(ok.error).toBeNull();

    shouldFail = true;
    await client.invalidateQueries({ queryKey: QUERY_KEY }).catch(() => {});
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().error).not.toBeNull();
    });

    const failed = observer.getCurrentResult();
    expect((failed.data as unknown[]).length).toBe(7);
    expect((failed.error as Error).message).toBe('Page not found.');
    expect(failed.isLoading).toBe(false);

    unsubscribe();
    client.clear();
  });
});
