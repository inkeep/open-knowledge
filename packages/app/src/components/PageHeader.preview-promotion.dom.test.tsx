import { HocuspocusProvider } from '@hocuspocus/provider';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { subscribePreviewTabPromotion } from '@/editor/preview-tab-promotion';
import { PageHeader } from './PageHeader';

const DUMMY_WS = 'ws://localhost:1/collab';

const providers: HocuspocusProvider[] = [];
let unsubscribePromotion: (() => void) | undefined;

function makeProvider(docName: string, fenced: string): HocuspocusProvider {
  const p = new HocuspocusProvider({ url: DUMMY_WS, name: docName });
  providers.push(p);
  const ytext = p.document.getText('source');
  p.document.transact(() => {
    ytext.delete(0, ytext.length);
    ytext.insert(0, fenced);
  });
  return p;
}

afterEach(() => {
  cleanup();
  unsubscribePromotion?.();
  unsubscribePromotion = undefined;
  for (const p of providers.splice(0)) {
    try {
      p.destroy();
    } catch {}
  }
});

describe('PageHeader — preview-tab promotion', () => {
  test('committing a cover focal change announces the doc', async () => {
    const promoted = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(promoted);
    const provider = makeProvider(
      'promotion-cover-doc',
      '---\ncover: https://example.com/a.png\ncover_y: 0.5\n---\n',
    );

    render(<PageHeader provider={provider} />);
    const slider = await screen.findByRole('slider');

    const user = userEvent.setup();
    slider.focus();
    await user.keyboard('{ArrowUp}');

    await waitFor(() => expect(promoted).toHaveBeenCalledWith('promotion-cover-doc'));
  });

  test('merely rendering the header announces nothing', async () => {
    const promoted = vi.fn();
    unsubscribePromotion = subscribePreviewTabPromotion(promoted);
    const provider = makeProvider(
      'promotion-cover-render-only',
      '---\ncover: https://example.com/a.png\ncover_y: 0.5\n---\n',
    );

    render(<PageHeader provider={provider} />);
    await screen.findByRole('slider');

    expect(promoted).not.toHaveBeenCalled();
  });
});
