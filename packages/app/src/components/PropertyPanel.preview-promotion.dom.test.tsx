import { HocuspocusProvider } from '@hocuspocus/provider';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { subscribePreviewTabPromotion } from '@/editor/preview-tab-promotion';
import { PropertyProvider } from './PropertyContext';
import { PropertyPanel } from './PropertyPanel';

let unsubscribePromotion: (() => void) | undefined;

const DUMMY_WS = 'ws://localhost:1/collab';

const providers: HocuspocusProvider[] = [];

function makeProvider(docName: string): HocuspocusProvider {
  const p = new HocuspocusProvider({ url: DUMMY_WS, name: docName });
  providers.push(p);
  return p;
}

function seedYTextFm(provider: HocuspocusProvider, fenced: string): void {
  const ytext = provider.document.getText('source');
  provider.document.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, fenced);
  });
}

function renderPanel(provider: HocuspocusProvider) {
  return render(
    <TooltipProvider>
      <PropertyProvider>
        <PropertyPanel provider={provider} />
      </PropertyProvider>
    </TooltipProvider>,
  );
}

function findInputByKey(testid: string, key: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector(
      `[data-testid="${testid}"][data-key="${key}"]`,
    ) as HTMLElement | null;
    if (!el) throw new Error(`element not found: [data-testid="${testid}"][data-key="${key}"]`);
    return el;
  });
}

afterEach(() => {
  cleanup();
  unsubscribePromotion?.();
  for (const p of providers.splice(0)) {
    try {
      p.destroy();
    } catch {}
  }
});

describe('PropertyPanel — preview-tab promotion', () => {
  test('committing a property edit announces the doc as user-edited', async () => {
    const onUserEdit = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(onUserEdit);

    const provider = makeProvider('promotion-commit-doc');
    seedYTextFm(provider, '---\ntitle: Draft\n---\n');
    renderPanel(provider);

    const titleInput = (await findInputByKey('text-widget', 'title')) as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    if (!titleInput) return;

    const user = userEvent.setup();
    await user.click(titleInput);
    await user.clear(titleInput);
    await user.type(titleInput, 'Published');
    await user.tab();

    expect(onUserEdit).toHaveBeenCalledWith('promotion-commit-doc');
  });

  test('merely rendering the panel announces nothing', async () => {
    const onUserEdit = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(onUserEdit);

    const provider = makeProvider('promotion-render-only-doc');
    seedYTextFm(provider, '---\ntitle: Draft\n---\n');
    renderPanel(provider);

    await findInputByKey('text-widget', 'title');

    expect(onUserEdit).not.toHaveBeenCalled();
  });

  test('focusing and blurring without changing anything announces nothing', async () => {
    const onUserEdit = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(onUserEdit);

    const provider = makeProvider('promotion-no-change-doc');
    seedYTextFm(provider, '---\ntitle: Draft\n---\n');
    renderPanel(provider);

    const titleInput = (await findInputByKey('text-widget', 'title')) as HTMLTextAreaElement | null;
    if (!titleInput) return;

    const user = userEvent.setup();
    await user.click(titleInput);
    await user.tab();

    expect(onUserEdit).not.toHaveBeenCalled();
  });
});
