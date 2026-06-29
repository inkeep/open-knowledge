import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { MermaidView } from './Mermaid.tsx';

describe('MermaidView — placeholder branch', () => {
  test('empty chart renders the placeholder shell', () => {
    const html = renderToString(<MermaidView chart="" />);
    expect(html).toContain('class="mermaid mermaid-placeholder"');
    expect(html).toContain('data-component-type="mermaid"');
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
  test('non-empty chart starts in idle/rendering state under renderToString', () => {
    const html = renderToString(<MermaidView chart="graph TD; A-->B;" />);
    expect(html).toContain('data-component-type="mermaid"');
  });
});
