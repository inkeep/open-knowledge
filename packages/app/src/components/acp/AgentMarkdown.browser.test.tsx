import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderWithI18n } from '../../../tests/foundation/render-with-i18n.test-helper';
import { AgentMarkdown } from './AgentMarkdown';

const settled: { type: string; defaultPrevented: boolean }[] = [];

function recordAndSettle(event: Event): void {
  settled.push({ type: event.type, defaultPrevented: event.defaultPrevented });
  event.preventDefault();
}

afterEach(() => {
  window.removeEventListener('click', recordAndSettle);
  window.removeEventListener('auxclick', recordAndSettle);
  settled.length = 0;
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  cleanup();
});

describe('AgentMarkdown external links in the desktop app', () => {
  test('a click or middle-click on a reply’s link opens it through okDesktop.shell.openExternal', async () => {
    const openExternal = vi.fn(async (_url: string) => {});
    (window as unknown as { okDesktop?: unknown }).okDesktop = { shell: { openExternal } };
    window.addEventListener('click', recordAndSettle);
    window.addEventListener('auxclick', recordAndSettle);

    renderWithI18n(<AgentMarkdown text="see [the docs](https://example.com/docs)" />);
    const link = await screen.findByRole('link', { name: 'the docs' });

    link.click();
    link.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));

    expect(openExternal.mock.calls).toEqual([
      ['https://example.com/docs'],
      ['https://example.com/docs'],
    ]);
    expect(settled).toEqual([
      { type: 'click', defaultPrevented: true },
      { type: 'auxclick', defaultPrevented: true },
    ]);
  });
});
