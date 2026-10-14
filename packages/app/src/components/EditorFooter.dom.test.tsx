import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DocumentStats } from '@/lib/document-stats';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{value === 1 ? one : other}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const SERVER_BRANCH = 'feature/app-header';

vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith('/api/server-info')) {
    return Response.json({ serverInstanceId: 'server-1', currentBranch: SERVER_BRANCH });
  }
  if (url.endsWith('/api/workspace')) {
    return Response.json({
      contentDir: '/srv/field-notes',
      pathSeparator: '/',
      symlinkResolved: true,
    });
  }
  return new Response(null, { status: 404 });
});

function installDesktopBridge() {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: { config: { projectName: 'Field Notes', projectPath: '/projects/field-notes' } },
  });
}

const STATS: DocumentStats = { words: 10, chars: 50, tokens: 12 };

async function renderFooter(composerBadge?: { onReopen: () => void } | null) {
  const { EditorFooter } = await import('./EditorFooter');
  return render(
    <TooltipProvider>
      <EditorFooter stats={STATS} composerBadge={composerBadge} />
    </TooltipProvider>,
  );
}

async function renderFooterWithFileList(fileList: 'open' | 'closed') {
  const { EditorFooter } = await import('./EditorFooter');
  return render(
    <SidebarProvider open={fileList === 'open'} onOpenChange={() => {}}>
      <TooltipProvider>
        <EditorFooter stats={STATS} />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'okDesktop', { configurable: true, value: undefined });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('EditorFooter identity row', () => {
  test.each([
    { host: 'desktop', fileList: 'open' },
    { host: 'desktop', fileList: 'closed' },
    { host: 'web', fileList: 'open' },
    { host: 'web', fileList: 'closed' },
  ] as const)(
    'shows the current branch and no project name on $host with the file list $fileList',
    async ({ host, fileList }) => {
      if (host === 'desktop') installDesktopBridge();
      await renderFooterWithFileList(fileList);

      const branch = await screen.findByTestId('editor-footer-branch');
      expect(branch.textContent).toBe(SERVER_BRANCH);
      expect(screen.queryByTestId('editor-footer-project-name')).toBeNull();
      expect(screen.queryByText('Field Notes')).toBeNull();
    },
  );

  test('shows the current branch with no file list in the tree at all, which is what note and single-file windows get', async () => {
    installDesktopBridge();
    await renderFooter();

    const branch = await screen.findByTestId('editor-footer-branch');
    expect(branch.textContent).toBe(SERVER_BRANCH);
  });
});

describe('EditorFooter (Ask AI reopen badge)', () => {
  test('renders the Ask AI badge when composerBadge is set', async () => {
    await renderFooter({ onReopen: () => {} });

    const badge = screen.getByTestId('ask-ai-reopen-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('Ask AI');
    expect(screen.getByText(/words/)).toBeTruthy();
  });

  test('clicking the badge calls onReopen', async () => {
    const onReopen = vi.fn(() => {});
    await renderFooter({ onReopen });

    fireEvent.click(screen.getByTestId('ask-ai-reopen-badge'));

    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  test('no badge when composerBadge is absent', async () => {
    await renderFooter(null);

    expect(screen.queryByTestId('ask-ai-reopen-badge')).toBeNull();
  });
});
