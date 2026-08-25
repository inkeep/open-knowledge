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
      // Optional short label for this page's row in the docs sidebar, for
      // titles that would wrap its single-line rows. The page still shows
      // `title` elsewhere, so prefer a shortening of it over a different name.
      // The value is trimmed, and a blank one falls back to `title`. Folder
      // rows and separators come from meta.json instead.
      sidebarTitle: z.string().optional(),
      keywords: z.string().optional(),
      // Set `footer: false` on hub/index pages to hide Fumadocs' prev/next
      // page navigation when the page already curates its own forward links.
      footer: z.boolean().optional(),
    }),
  },
});

/**
 * Turn ` ```html preview ` fences into a live <HtmlPreview> iframe, matching
 * OpenKnowledge's own editor: the block renders as an interactive sandboxed
 * preview on both surfaces (native in the OK editor, this plugin on the docs
 * site). Raw HTML is base64'd onto the JSX attribute so nothing in the block
 * (quotes, braces, `<`) collides with MDX parsing.
 */
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
