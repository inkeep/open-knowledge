import { renderToString } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import * as actualLinguiReactMacro from '../../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiReactMacro,
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { MermaidView, compensatedMaxScale } = await import('./Mermaid.tsx');

describe('MermaidView — placeholder branch', () => {
  test('empty chart renders the placeholder shell with real height', () => {
    const html = renderToString(<MermaidView chart="" />);
    expect(html).toContain('mermaid-placeholder');
    expect(html).toContain('data-component-type="mermaid"');
    expect(html).toContain('min-h-16');
    expect(html).toContain('Empty diagram');
  });

  test('whitespace-only chart treated as empty', () => {
    const html = renderToString(<MermaidView chart="   " />);
    expect(html).toContain('mermaid-placeholder');
  });

  test('undefined chart treated as empty', () => {
    const html = renderToString(<MermaidView />);
    expect(html).toContain('mermaid-placeholder');
  });
});

describe('MermaidView — pre-render mount state', () => {
  test('non-empty chart starts in the rendering state under renderToString', () => {
    const html = renderToString(<MermaidView chart="graph TD; A-->B;" />);
    expect(html).toContain('data-component-type="mermaid"');
    expect(html).toContain('mermaid-rendering');
  });
});

describe('compensatedMaxScale', () => {
  test('returns the raw MERMAID_ZOOM_MAX floor when the diagram paints at or above natural size', () => {
    expect(compensatedMaxScale(500, 500)).toBe(4);
    expect(compensatedMaxScale(1000, 500)).toBe(4);
  });

  test('compensates a fit-shrunk diagram so it can still reach the intended natural-size multiple', () => {
    expect(compensatedMaxScale(500, 2000)).toBe(16);
    expect(compensatedMaxScale(1000, 2000)).toBe(8);
  });

  test('falls back to the raw floor for degenerate inputs', () => {
    expect(compensatedMaxScale(0, 500)).toBe(4);
    expect(compensatedMaxScale(500, 0)).toBe(4);
    expect(compensatedMaxScale(-5, 500)).toBe(4);
  });
});
