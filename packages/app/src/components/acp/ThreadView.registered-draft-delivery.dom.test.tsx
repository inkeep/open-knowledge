import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { StrictMode, useEffect, useInsertionEffect, useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as staging from '@/lib/acp/thread-draft-staging';
import { ThreadView } from './ThreadView';

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null, activeDocName: null }),
}));
vi.mock('@/lib/use-workspace', () => ({ useWorkspace: () => null }));

function BeforeLayout({ run }: { run: () => void }) {
  useInsertionEffect(run, [run]);
  return null;
}

function AfterSubscription({ stage }: { stage: () => void }) {
  const staged = useRef(false);
  useEffect(() => {
    if (staged.current) return;
    staged.current = true;
    stage();
  }, [stage]);
  return null;
}

describe('ThreadView registered staged draft delivery', () => {
  test('keeps a draft staged after subscription in the current composer after provisional disposal', async (context) => {
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
        staging.resetStagedThreadDrafts();
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
    const lifecycle: { liveBefore: number; destroyedAfter: number; timerCount: number }[] = [];
    const beforeLayout = () => {
      const provisional = created.filter((editor) => !editor.isDestroyed);
      const timerCount = vi.getTimerCount();
      vi.runOnlyPendingTimers();
      lifecycle.push({
        liveBefore: provisional.length,
        destroyedAfter: provisional.filter((editor) => editor.isDestroyed).length,
        timerCount,
      });
    };
    const info: ThreadInfo = {
      threadId: 'registered-draft-delivery',
      agent: { id: 'echo', source: 'custom', name: 'Echo' },
      title: 'Chat',
      status: 'ready',
      createdAt: 1,
      lastActivityAt: 1,
      lastSeq: -1,
      modes: null,
      configOptions: null,
    };
    let stageInProgress = false;
    const deliveries: {
      threadId: string;
      text: string;
      duringStage: boolean;
      accepted: boolean;
    }[] = [];
    const subscribe = staging.subscribeStagedThreadDraft;
    vi.spyOn(staging, 'subscribeStagedThreadDraft').mockImplementation((threadId, listener) =>
      subscribe(threadId, (text) => {
        const duringStage = stageInProgress;
        const accepted = listener(text);
        deliveries.push({ threadId, text, duringStage, accepted });
        return accepted;
      }),
    );
    const stage = () => {
      stageInProgress = true;
      try {
        staging.stageThreadDraft(info.threadId, 'Review this document');
      } finally {
        stageInProgress = false;
      }
    };

    await act(async () => {
      render(
        <StrictMode>
          <I18nProvider i18n={i18n}>
            <QueryClientProvider client={query}>
              <TooltipProvider>
                <BeforeLayout run={beforeLayout} />
                <ThreadView info={info} />
                <AfterSubscription stage={stage} />
              </TooltipProvider>
            </QueryClientProvider>
          </I18nProvider>
        </StrictMode>,
      );
    });

    expect(lifecycle).toHaveLength(1);
    await context.annotate(JSON.stringify({ lifecycle, deliveries }), 'registered draft delivery');
    const [lifetime] = lifecycle;
    expect(lifetime.liveBefore).toBeGreaterThan(0);
    expect(lifetime.timerCount).toBeGreaterThan(0);
    expect(lifetime.destroyedAfter).toBe(lifetime.liveBefore);
    expect(deliveries.filter((delivery) => delivery.duringStage)).toEqual([
      { threadId: info.threadId, text: 'Review this document', duringStage: true, accepted: false },
    ]);
    expect(deliveries).toContainEqual({
      threadId: info.threadId,
      text: 'Review this document',
      duringStage: false,
      accepted: true,
    });
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message Echo' }).textContent).toBe(
      'Review this document',
    );
  });
});
