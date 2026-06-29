import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { MathView } from './Math.tsx';

describe('MathView — placeholder branch', () => {
  test('empty formula renders the math-placeholder shell with a zero-width space', () => {
    const html = renderToString(<MathView formula="" />);
    expect(html).toContain('class="math math-placeholder"');
    expect(html).toContain('data-component-type="math"');
    expect(html).toContain(' ');
  });

  test('undefined formula treated as empty (defaults via ?? "")', () => {
    const html = renderToString(<MathView />);
    expect(html).toContain('math-placeholder');
  });

  test('id prop reaches the placeholder DOM (deep-link anchor)', () => {
    const html = renderToString(<MathView formula="" id="eq-zero" />);
    expect(html).toContain('id="eq-zero"');
  });
});

describe('MathView — non-empty formula', () => {
  test('renders the Suspense fallback (placeholder) under renderToString', () => {
    const html = renderToString(<MathView formula="E = mc^2" />);
    expect(html).toContain('data-component-type="math"');
    expect(html).toContain('E = mc^2');
  });

  test('id prop carries through the Suspense fallback', () => {
    const html = renderToString(<MathView formula="x^2" id="square" />);
    expect(html).toContain('id="square"');
  });
});
