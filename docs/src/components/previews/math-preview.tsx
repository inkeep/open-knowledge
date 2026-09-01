'use client';

import 'katex/dist/katex.min.css';
import katex from 'katex';

export function MathPreview({ formula, display = true }: { formula: string; display?: boolean }) {
  const html = renderFormula(formula, display);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: katex output is trusted
  return <div className="text-fd-foreground" dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderFormula(formula: string, display: boolean): string {
  try {
    return katex.renderToString(formula, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
    });
  } catch (err) {
    return `<span style="color:tomato">${(err as Error)?.message ?? 'Failed to render'}</span>`;
  }
}
