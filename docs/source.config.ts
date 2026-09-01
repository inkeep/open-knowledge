import path from 'node:path';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config';
import { remarkAutoTypeTable } from 'fumadocs-typescript';
import { mdxSnippet } from 'remark-mdx-snippets';
import { z } from 'zod';

export const docs = defineDocs({
  dir: 'content',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
    schema: frontmatterSchema.extend({
      sidebarTitle: z.string().optional(),
      keywords: z.string().optional(),
      footer: z.boolean().optional(),
    }),
  },
});

function remarkHtmlPreview() {
  return (tree: unknown) => {
    const visit = (node: { children?: unknown[] } | null) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i] as {
          type?: string;
          lang?: string;
          meta?: string;
          value?: string;
          children?: unknown[];
        };
        if (
          child.type === 'code' &&
          child.lang === 'html' &&
          typeof child.meta === 'string' &&
          /(^|\s)preview(\s|$)/.test(child.meta)
        ) {
          const b64 = Buffer.from(child.value ?? '', 'utf8').toString('base64');
          node.children[i] = {
            type: 'mdxJsxFlowElement',
            name: 'HtmlPreview',
            attributes: [{ type: 'mdxJsxAttribute', name: 'code', value: b64 }],
            children: [],
          } as unknown;
        } else {
          visit(child as { children?: unknown[] });
        }
      }
    };
    visit(tree as { children?: unknown[] });
  };
}

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      remarkHtmlPreview,
      remarkAutoTypeTable,
      remarkMdxMermaid,
      [mdxSnippet, { snippetsDir: path.resolve(process.cwd(), '_snippets') }],
    ],
    rehypeCodeOptions: {
      inline: 'tailing-curly-colon',
      themes: {
        dark: 'houston',
        light: 'slack-ochin',
      },
    },
  },
});
