import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { StrictMode, useInsertionEffect } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  resetStagedThreadDrafts,
  stageThreadDraft,
  stageThreadDraftContent,
} from '@/lib/acp/thread-draft-staging';
import { ThreadView } from './ThreadView';

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null, activeDocName: null }),
}));
vi.mock('@/lib/use-workspace', () => ({ useWorkspace: () => null }));

function BeforeLayout({ run }: { run: () => void }) {
  useInsertionEffect(run, [run]);
  return null;
}

describe('ThreadView staged draft delivery', () => {
  test.for([
    { order: 'before provisional disposal', expire: false },
    { order: 'after provisional disposal', expire: true },
  ])('keeps the pending draft in the current composer $order', async ({ expire }, context) => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    context.onTestFinished(() => {
      try {
        act(() => {
          cleanup();
          query.clear();
          vi.runOnlyPendingTimers();
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        resetStagedThreadDrafts();
        vi.restoreAllMocks();
      }
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const errors = vi.spyOn(console, 'error');
    const warnings = vi.spyOn(console, 'warn');
    i18n.load('en', {});
    i18n.activate('en');
    const created: Editor[] = [];
    const mount = Editor.prototype.mount;
    vi.spyOn(Editor.prototype, 'mount').mockImplementation(function (...args) {
      const result = mount.apply(this, args);
      created.push(this);
      return result;
    });
    const observations: { liveBefore: number; destroyedAfter: number; timerCount: number }[] = [];
    const beforeLayout = () => {
      const provisional = created.filter((editor) => !editor.isDestroyed);
      const timerCount = vi.getTimerCount();
      if (expire) vi.runOnlyPendingTimers();
      observations.push({
        liveBefore: provisional.length,
        destroyedAfter: provisional.filter((editor) => editor.isDestroyed).length,
        timerCount,
      });
    };
    const info: ThreadInfo = {
      threadId: `draft-delivery-${expire}`,
      agent: { id: 'echo', source: 'custom', name: 'Echo' },
      title: 'Chat',
      status: 'ready',
      createdAt: 1,
      lastActivityAt: 1,
      lastSeq: -1,
      modes: null,
      configOptions: null,
    };
    stageThreadDraft(info.threadId, 'Review this document');

    await act(async () => {
      render(
        <StrictMode>
          <I18nProvider i18n={i18n}>
            <QueryClientProvider client={query}>
              <TooltipProvider>
                <BeforeLayout run={beforeLayout} />
                <ThreadView info={info} />
              </TooltipProvider>
            </QueryClientProvider>
          </I18nProvider>
        </StrictMode>,
      );
    });

    expect(observations).toHaveLength(1);
    await context.annotate(JSON.stringify(observations), 'pre-layout editor lifetime');
    const [lifetime] = observations;
    expect(lifetime.liveBefore).toBeGreaterThan(0);
    if (expire) expect(lifetime.timerCount).toBeGreaterThan(0);
    expect(lifetime.destroyedAfter).toBe(expire ? lifetime.liveBefore : 0);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message Echo' }).textContent).toBe(
      'Review this document',
    );
  });

  test.for([
    { order: 'before provisional disposal', expire: false },
    { order: 'after provisional disposal', expire: true },
  ])(
    'keeps the pending draft content and its attachment in the current composer $order',
    async ({ expire }, context) => {
      const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      context.onTestFinished(() => {
        try {
          act(() => {
            cleanup();
            query.clear();
            vi.runOnlyPendingTimers();
          });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
          resetStagedThreadDrafts();
          vi.restoreAllMocks();
        }
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const errors = vi.spyOn(console, 'error');
      const warnings = vi.spyOn(console, 'warn');
      i18n.load('en', {});
      i18n.activate('en');
      const created: Editor[] = [];
      const mount = Editor.prototype.mount;
      vi.spyOn(Editor.prototype, 'mount').mockImplementation(function (...args) {
        const result = mount.apply(this, args);
        created.push(this);
        return result;
      });
      const observations: { liveBefore: number; destroyedAfter: number; timerCount: number }[] = [];
      const beforeLayout = () => {
        const provisional = created.filter((editor) => !editor.isDestroyed);
        const timerCount = vi.getTimerCount();
        if (expire) vi.runOnlyPendingTimers();
        observations.push({
          liveBefore: provisional.length,
          destroyedAfter: provisional.filter((editor) => editor.isDestroyed).length,
          timerCount,
        });
      };
      const info: ThreadInfo = {
        threadId: `draft-content-delivery-${expire}`,
        agent: { id: 'echo', source: 'custom', name: 'Echo' },
        title: 'Chat',
        status: 'ready',
        createdAt: 1,
        lastActivityAt: 1,
        lastSeq: -1,
        modes: null,
        configOptions: null,
      };
      stageThreadDraftContent(info.threadId, {
        doc: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Carry this brief over' }] },
          ],
        },
        attachments: [{ kind: 'file', path: '/notes/brief.md', name: 'brief.md' }],
      });

      await act(async () => {
        render(
          <StrictMode>
            <I18nProvider i18n={i18n}>
              <QueryClientProvider client={query}>
                <TooltipProvider>
                  <BeforeLayout run={beforeLayout} />
                  <ThreadView info={info} />
                </TooltipProvider>
              </QueryClientProvider>
            </I18nProvider>
          </StrictMode>,
        );
      });

      expect(observations).toHaveLength(1);
      await context.annotate(JSON.stringify(observations), 'pre-layout editor lifetime');
      const [lifetime] = observations;
      expect(lifetime.liveBefore).toBeGreaterThan(0);
      if (expire) expect(lifetime.timerCount).toBeGreaterThan(0);
      expect(lifetime.destroyedAfter).toBe(expire ? lifetime.liveBefore : 0);
      expect(screen.getByRole('textbox', { name: 'Message Echo' }).textContent).toBe(
        'Carry this brief over',
      );
      expect(screen.getAllByRole('button', { name: 'Remove brief.md' })).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    },
  );
});
