import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

describe('jsdom-preload backfills', () => {
  test('a Range over mounted text can be measured (ProseMirror coordsAtPos path)', () => {
    render(<p data-testid="measured">hello world</p>);
    const paragraph = screen.getByTestId('measured');

    const range = document.createRange();
    range.selectNodeContents(paragraph);

    expect(typeof range.getClientRects).toBe('function');
    expect(typeof range.getBoundingClientRect).toBe('function');

    const rects = range.getClientRects();
    expect(rects.length).toBe(0);

    const rect = range.getBoundingClientRect();
    expect(rect.top).toBe(0);
    expect(rect.left).toBe(0);
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
  });

  test('the other backfills jsdom omits are installed', () => {
    expect(typeof window.matchMedia).toBe('function');
    expect(window.matchMedia('(prefers-reduced-transparency: reduce)').matches).toBe(false);

    expect(typeof globalThis.ResizeObserver).toBe('function');

    expect(typeof HTMLElement.prototype.scrollIntoView).toBe('function');
    expect(() => document.body.scrollIntoView()).not.toThrow();

    expect(typeof globalThis.MessageChannel).toBe('function');
  });
});
