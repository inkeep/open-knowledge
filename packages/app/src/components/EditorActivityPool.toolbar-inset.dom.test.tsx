import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ScrollPreservingContainer } from './EditorActivityPool';

afterEach(cleanup);

function scrollerOf(container: HTMLElement) {
  const el = container.querySelector('[data-testid="editor-scroll-container"]');
  if (!el) throw new Error('scroll container not found');
  return el;
}

describe('ScrollPreservingContainer toolbar inset', () => {
  test('reserves the toolbar band when the toolbar is mounted', () => {
    const { container } = render(
      <ScrollPreservingContainer isActive docName="doc-a" mode="wysiwyg">
        <div>body</div>
      </ScrollPreservingContainer>,
    );
    const cls = scrollerOf(container).className;
    expect(cls).toContain('pt-14');
    expect(cls).toContain('scroll-pt-14');
  });

  test('drops the reserve when the toolbar is absent', () => {
    const { container } = render(
      <ScrollPreservingContainer isActive docName="doc-b" mode="wysiwyg" hasToolbar={false}>
        <div>body</div>
      </ScrollPreservingContainer>,
    );
    const cls = scrollerOf(container).className;
    expect(cls).toContain('pt-0');
    expect(cls).not.toContain('pt-14');
    expect(cls).not.toContain('scroll-pt-14');
  });
});
