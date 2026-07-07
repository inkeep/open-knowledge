/**
 * RTL behavioral test for `DiffView`'s `oursOverride` prop.
 *
 * Pins the contract: when an explicit `oursOverride` is passed, the
 * conflict-mode merge view displays those bytes as the `ours` pane instead
 * of `newContent`. This closes the byte-divergence class where the
 * editor-area DiffView showed `git show :2:` bytes while a "Keep mine"
 * dispatch with `strategy: 'content'` would write the (different) Y.Text
 * snapshot. Now both surfaces show the same string.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DiffView } from './DiffView';

describe('DiffView oursOverride (FR3)', () => {
  afterEach(() => {
    cleanup();
  });

  test('uses oursOverride as the ours pane content when present', () => {
    const { container } = render(
      <DiffView
        oldContent="# Base\nold paragraph\n"
        newContent="# DEFAULT_NEW\nignored bytes\n"
        oursOverride="# OVERRIDE\nhello world\n"
        layout="unified"
        conflictMode
      />,
    );

    // CodeMirror renders the doc text inside a `.cm-content` container. The
    // bytes the override carries should appear; the bytes `newContent`
    // carries should NOT (since override fully replaces it).
    const cmContent = container.querySelector('.cm-content');
    expect(cmContent).not.toBeNull();
    const rendered = cmContent?.textContent ?? '';
    expect(rendered).toContain('OVERRIDE');
    expect(rendered).toContain('hello world');
    expect(rendered).not.toContain('DEFAULT_NEW');
    expect(rendered).not.toContain('ignored bytes');
  });

  test('falls back to newContent when oursOverride is absent', () => {
    const { container } = render(
      <DiffView
        oldContent="# Base\nold paragraph\n"
        newContent="# DEFAULT_NEW\nlegacy bytes\n"
        layout="unified"
        conflictMode
      />,
    );

    const cmContent = container.querySelector('.cm-content');
    expect(cmContent).not.toBeNull();
    const rendered = cmContent?.textContent ?? '';
    expect(rendered).toContain('DEFAULT_NEW');
    expect(rendered).toContain('legacy bytes');
  });

  test('renders conflict merge controls with shadcn Button', async () => {
    const { container } = render(
      <DiffView
        oldContent="# DiffView conflict sample\n\nThe incoming branch replaces the editor copy.\n"
        newContent="# DiffView conflict sample\n\nThe local branch keeps the current editor copy.\n"
        layout="unified"
        conflictMode
      />,
    );

    const accept = await screen.findByRole('button', { name: 'Accept' });
    const reject = await screen.findByRole('button', { name: 'Reject' });
    expect(accept.closest('.cm-chunkButtons')).not.toBeNull();
    expect(reject.closest('.cm-chunkButtons')).not.toBeNull();
    expect(accept.getAttribute('data-slot')).toBe('button');
    expect(reject.getAttribute('data-slot')).toBe('button');
    expect(accept.getAttribute('data-size')).toBe('xs');
    expect(reject.getAttribute('data-size')).toBe('xs');
    expect(accept.getAttribute('data-variant')).toBe('default');
    expect(reject.getAttribute('data-variant')).toBe('destructive');
    expect(container.querySelectorAll('.cm-chunkButtons button[data-slot="button"]').length).toBe(
      2,
    );
    fireEvent.click(accept);
    await screen.findByText('All hunks resolved');
  });
});

describe('DiffView conflict footer height contract', () => {
  afterEach(() => {
    cleanup();
  });

  // The conflict footer (Exit merge / Undo / Save resolution) must stay
  // clickable while the floating Ask AI composer is visible. The composer
  // anchors its bottom to `--conflict-footer-height` (the counterpart of the
  // composer's own `--ask-composer-height`), so DiffView must publish the
  // footer's measured height on the document root for the whole conflict
  // session and reclaim it afterward.
  test('conflictMode publishes --conflict-footer-height on the document root while mounted', () => {
    const { unmount } = render(
      <DiffView
        oldContent="# Base\ntheirs\n"
        newContent="# Base\nours\n"
        layout="unified"
        conflictMode
      />,
    );

    const value = document.documentElement.style.getPropertyValue('--conflict-footer-height');
    // jsdom: offsetHeight=0, so this is a lifecycle pin (published vs not),
    // not a geometry assertion; real browsers produce the actual height.
    expect(value).toBe('0px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('');
  });

  test('non-conflict renders never publish --conflict-footer-height', () => {
    render(<DiffView oldContent="# Base\ntheirs\n" newContent="# Base\nours\n" layout="unified" />);

    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('');
  });
});
