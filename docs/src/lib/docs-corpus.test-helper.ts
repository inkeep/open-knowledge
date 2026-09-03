import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const CONTENT_ROOT = fileURLToPath(new URL('../../content/', import.meta.url));

export interface CorpusPage {
  readonly slug: string;
  readonly source: string;
  readonly pageUrl: string;
}

function corpusFiles(dir = CONTENT_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return corpusFiles(full);
    return /\.mdx?$/.test(entry.name) ? [full] : [];
  });
}

export async function readCorpus(): Promise<CorpusPage[]> {
  return Promise.all(
    corpusFiles().map(async (file) => {
      const slug = path
        .relative(CONTENT_ROOT, file)
        .replace(/\.mdx?$/, '')
        .replace(/(^|\/)index$/, '');
      return {
        slug,
        source: await readFile(file, 'utf8'),
        pageUrl: `https://openknowledge.ai/docs/${slug}`.replace(/\/$/, ''),
      };
    }),
  );
}

export interface CorpusSourcePage {
  readonly url: string;
  readonly data: {
    readonly title: string;
    readonly description?: string;
    getText(): Promise<string>;
  };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export function corpusSourcePages(pages: readonly CorpusPage[]): CorpusSourcePage[] {
  return pages.map((page) => {
    const block = FRONTMATTER.exec(page.source)?.[1];
    const data = (block ? parse(block) : {}) as { title?: string; description?: string };
    return {
      url: `/docs/${page.slug}`.replace(/\/$/, ''),
      data: {
        title: data.title ?? page.slug,
        description: data.description,
        getText: async () => page.source,
      },
    };
  });
}
