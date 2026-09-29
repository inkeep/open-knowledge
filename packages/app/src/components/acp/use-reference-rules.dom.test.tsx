import { ConfigSchema } from '@inkeep/open-knowledge-core';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { type ReferenceRulesInput, remarkReferenceLinks } from './reference-links';
import { useReferenceRules } from './use-reference-rules';

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

function linked(
  rules: ReferenceRulesInput,
  text: string,
): Array<[string | undefined, string | undefined]> {
  const tree: Node = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  };
  remarkReferenceLinks(rules)(tree);
  return (tree.children?.[0]?.children ?? [])
    .filter((n) => n.type === 'link')
    .map((n) => [n.children?.[0]?.value, n.url]);
}

function stubSyncStatus(webUrl: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/sync/status')
        ? new Response(JSON.stringify({ remote: { label: 'origin', webUrl } }), { status: 200 })
        : new Response('{}', { status: 404 }),
    ),
  );
}

function contextWith(overrides: Partial<ConfigContextValue>): ConfigContextValue {
  const base = ConfigSchema.parse({});
  return {
    userBinding: null,
    userSynced: true,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: true,
    userConfig: base,
    projectConfig: base,
    projectSynced: true,
    projectLocalConfig: base,
    projectLocalSynced: true,
    merged: base,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReferenceRules', () => {
  test('links with the project autolinks and the GitHub host the server reports for the remote', async () => {
    stubSyncStatus('https://ghe.example.com/team/repo');
    const base = ConfigSchema.parse({});
    const value = contextWith({
      userConfig: {
        ...base,
        autolinks: [{ prefix: 'PRD-', url: 'https://user-scope.example/<num>' }],
      },
      projectConfig: {
        ...base,
        autolinks: [{ prefix: 'PRD-', url: 'https://linear.example/PRD-<num>' }, null],
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ConfigContext value={value}>{children}</ConfigContext>
    );
    const { result } = renderHook(() => useReferenceRules(), { wrapper });
    await waitFor(() => expect(result.current.githubBase).toBe('https://ghe.example.com'));
    expect(linked(result.current, 'Fixed PRD-5 in team/repo#9.')).toEqual([
      ['PRD-5', 'https://linear.example/PRD-5'],
      ['team/repo#9', 'https://ghe.example.com/team/repo/issues/9'],
    ]);
  });

  test('with no config and no GitHub remote, only qualified references link, to github.com', async () => {
    stubSyncStatus(null);
    const { result } = renderHook(() => useReferenceRules());
    await waitFor(() => expect(result.current.githubBase).toBe('https://github.com'));
    expect(linked(result.current, 'PRD-5 and team/repo#9')).toEqual([
      ['team/repo#9', 'https://github.com/team/repo/issues/9'],
    ]);
  });
});
