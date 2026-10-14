import { cleanup, render, screen } from '@testing-library/react';
import { Component, type ReactNode, Suspense, useEffect } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';
import { PANE_CARD_DIVIDER_PX, PANE_CARD_GAP_PX, PANE_CARD_INSET_PX, PaneCard } from './pane-card';

afterEach(cleanup);

function card(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="pane-card"]');
  if (!el) throw new Error('no pane card rendered');
  return el;
}

const SHAPE_TOKENS = [
  'rounded-xl',
  'shadow-[0_2px_8px_0_rgb(0_0_0/0.08),0_1px_2px_-1px_rgb(0_0_0/0.1)]',
];
const FILL_TOKENS = [
  'relative',
  'flex',
  'min-h-0',
  'min-w-0',
  'flex-1',
  'flex-col',
  'overflow-hidden',
];

describe('PaneCard', () => {
  test('the card variant is a plain div carrying today’s shape, clipping and background', () => {
    const { container } = render(<PaneCard pane="editor">body</PaneCard>);
    const el = card(container);

    expect(el.tagName).toBe('DIV');
    expect(screen.queryByRole('region')).toBeNull();
    expect(el.getAttribute('data-pane')).toBe('editor');
    expect(el.getAttribute('data-variant')).toBe('card');
    expectVisualClassTokens(el.getAttribute('class'), [
      ...FILL_TOKENS,
      ...SHAPE_TOKENS,
      'bg-background',
    ]);
    expectVisualClassTokensAbsent(el.getAttribute('class'), ['bg-card', 'ring-1', 'overflow-auto']);
  });

  test('the flat variant keeps the fill and background but drops the rounding and shadow', () => {
    const { container } = render(
      <PaneCard pane="terminal" variant="flat">
        body
      </PaneCard>,
    );
    const el = card(container);

    expect(el.getAttribute('data-variant')).toBe('flat');
    expectVisualClassTokens(el.getAttribute('class'), [...FILL_TOKENS, 'bg-background']);
    expectVisualClassTokensAbsent(el.getAttribute('class'), SHAPE_TOKENS);
  });

  test.each(['editor', 'agents', 'terminal'] as const)('identifies the %s pane', (pane) => {
    const { container } = render(<PaneCard pane={pane}>body</PaneCard>);
    expect(card(container).getAttribute('data-pane')).toBe(pane);
  });

  test('the card is never a resizable row or panel, so panel-space selectors skip it', () => {
    const { container } = render(<PaneCard pane="agents">body</PaneCard>);
    const el = card(container);

    expect(el.hasAttribute('data-panel')).toBe(false);
    expect(el.hasAttribute('data-group')).toBe(false);
    expect(el.hasAttribute('data-separator')).toBe(false);
  });

  test('switching variants restyles the same element and never remounts its children', () => {
    let mounts = 0;
    function Child() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div data-testid="child">child</div>;
    }
    const view = render(
      <PaneCard pane="editor" variant="card">
        <Child />
      </PaneCard>,
    );
    const cardBefore = card(view.container);
    const childBefore = screen.getByTestId('child');

    view.rerender(
      <PaneCard pane="editor" variant="flat">
        <Child />
      </PaneCard>,
    );

    expect(card(view.container)).toBe(cardBefore);
    expect(screen.getByTestId('child')).toBe(childBefore);
    expect(card(view.container).getAttribute('data-variant')).toBe('flat');
    expect(mounts).toBe(1);
  });

  test('caller className and attributes compose onto the same element', () => {
    const { container } = render(
      <PaneCard pane="editor" className="mx-1" data-placement="bottom" aria-label="Editor">
        body
      </PaneCard>,
    );
    const el = card(container);

    expectVisualClassTokens(el.getAttribute('class'), ['mx-1', 'rounded-xl', 'bg-background']);
    expect(el.getAttribute('data-placement')).toBe('bottom');
    expect(el.getAttribute('aria-label')).toBe('Editor');
  });

  test('asChild renders the caller element and keeps the identifying attributes on it', () => {
    render(
      <PaneCard pane="agents" asChild>
        <section aria-label="Agents">body</section>
      </PaneCard>,
    );
    const region = screen.getByRole('region', { name: 'Agents' });

    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('data-slot')).toBe('pane-card');
    expect(region.getAttribute('data-pane')).toBe('agents');
  });

  test('a suspending child reaches the boundary outside the card, so the card owns no Suspense', () => {
    let resolve: (() => void) | null = null;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    function Suspending() {
      throw gate;
    }
    render(
      <Suspense fallback={<div data-testid="outer-fallback" />}>
        <PaneCard pane="editor">
          <Suspending />
        </PaneCard>
      </Suspense>,
    );

    expect(screen.getByTestId('outer-fallback')).toBeTruthy();
    expect(document.querySelector('[data-slot="pane-card"]')).toBeNull();
    resolve?.();
  });

  test('a throwing child reaches the boundary outside the card, so the card owns no error boundary', () => {
    class OuterBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? <div data-testid="outer-error" /> : this.props.children;
      }
    }
    function Throwing(): ReactNode {
      throw new Error('boom');
    }
    const originalError = console.error;
    console.error = () => {};
    try {
      render(
        <OuterBoundary>
          <PaneCard pane="editor">
            <Throwing />
          </PaneCard>
        </OuterBoundary>,
      );
    } finally {
      console.error = originalError;
    }

    expect(screen.getByTestId('outer-error')).toBeTruthy();
    expect(document.querySelector('[data-slot="pane-card"]')).toBeNull();
  });
});

describe('pane card gap accounting', () => {
  test('the gap between two cards is 8px including a 1px divider', () => {
    expect(PANE_CARD_GAP_PX).toBe(8);
    expect(PANE_CARD_DIVIDER_PX).toBe(1);
    expect(PANE_CARD_INSET_PX).toBe(7);
    expect(PANE_CARD_INSET_PX + PANE_CARD_DIVIDER_PX).toBe(PANE_CARD_GAP_PX);
  });
});
