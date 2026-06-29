
import type { Node as PmNode } from '@tiptap/pm/model';

type SourceFallbackForm = { source: string };

export function sourceFallbackFormFor(node: PmNode): SourceFallbackForm | null {
  if (node.type.name !== 'jsxComponent') return null;
  const componentName = node.attrs.componentName as string | undefined;
  const props = (node.attrs.props as Record<string, unknown> | undefined) ?? {};

  switch (componentName) {
    case 'Math': {
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
