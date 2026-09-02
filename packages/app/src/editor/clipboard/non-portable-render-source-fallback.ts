import { selectFenceChar, widenFenceLength } from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { normalizeCodeLanguage } from '../extensions/code-block-languages.ts';
import { shouldShowPreview } from '../extensions/code-block-meta.ts';

type SourceFallbackForm = { source: string };

export function sourceFallbackFormFor(node: PmNode): SourceFallbackForm | null {
  if (node.type.name === 'codeBlock') {
    const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
    const meta = typeof node.attrs.meta === 'string' ? node.attrs.meta : '';
    if (!shouldShowPreview(normalizeCodeLanguage(language), meta)) return null;
    const body = node.textContent;
    const info = meta ? `${language} ${meta}` : language;
    const fenceChar = selectFenceChar(info);
    const fence = fenceChar.repeat(widenFenceLength(fenceChar, body));
    return { source: `${fence}${info}\n${body}\n${fence}` };
  }

  if (node.type.name !== 'jsxComponent') return null;
  const componentName = node.attrs.componentName as string | undefined;
  const props = (node.attrs.props as Record<string, unknown> | undefined) ?? {};

  switch (componentName) {
    case 'Math':
    case 'DollarMath':
    case 'MathFence': {
      const formula = typeof props.formula === 'string' ? props.formula : '';
      return { source: `$$\n${formula}\n$$` };
    }
    case 'MermaidFence': {
      const chart = typeof props.chart === 'string' ? props.chart : '';
      return { source: `\`\`\`mermaid\n${chart}\n\`\`\`` };
    }
    default:
      return null;
  }
}

export function nonPortableRenderSourceFallback(node: PmNode, doc: Document): Element | null {
  const form = sourceFallbackFormFor(node);
  if (!form) return null;

  const pre = doc.createElement('pre');
  pre.className = 'mdx-component';
  const code = doc.createElement('code');
  code.textContent = form.source;
  pre.appendChild(code);
  return pre;
}
