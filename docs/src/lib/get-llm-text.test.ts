import { describe, expect, test } from 'vitest';
import { getLLMText } from './get-llm-text.ts';

type Page = Parameters<typeof getLLMText>[0];

const SOURCE = `---
title: Overview
description: What OpenKnowledge is.
---

Read the [quickstart](../get-started/quickstart.mdx).

<Callout type="info" title="Heads up">

It is early.

</Callout>
`;

function fakePage(data: Partial<Page['data']> = {}, url = '/docs/get-started/overview'): Page {
  return {
    url,
    data: {
      title: 'Overview',
      description: 'What OpenKnowledge is.',
      getText: async () => SOURCE,
      ...data,
    },
  } as unknown as Page;
}

describe('getLLMText', () => {
  test('renders title + URL header, description, then the serialized body', async () => {
    const md = await getLLMText(fakePage());
    expect(md).toBe(
      `# Overview (https://openknowledge.ai/docs/get-started/overview)

What OpenKnowledge is.

Read the [quickstart](https://openknowledge.ai/docs/get-started/quickstart).

> **Heads up**
>
> It is early.`,
    );
  });

  test('heads the document with the absolute human URL, not the site-relative one', async () => {
    const md = await getLLMText(fakePage({}, '/docs/reference/components/callout'));
    expect(md.split('\n')[0]).toBe(
      '# Overview (https://openknowledge.ai/docs/reference/components/callout)',
    );
  });

  test('serializes the raw MDX source, not the compiled Markdown rendition', async () => {
    let requested: string | undefined;
    await getLLMText(
      fakePage({
        getText: async (type) => {
          requested = type;
          return SOURCE;
        },
      }),
    );
    expect(requested).toBe('raw');
  });

  test('strips the frontmatter rather than serving it as body text', async () => {
    const md = await getLLMText(fakePage());
    expect(md).not.toContain('---');
    expect(md).not.toContain('title: Overview');
  });

  test('neutralises raw HTML a title names in passing', async () => {
    const md = await getLLMText(fakePage({ title: 'The <details> element' }));
    expect(md.split('\n')[0]).toBe(
      '# The \\<details> element (https://openknowledge.ai/docs/get-started/overview)',
    );
  });

  test('keeps a multi-line title on the heading line', async () => {
    const md = await getLLMText(fakePage({ title: 'Folded\n\ntitle' }));
    expect(md.split('\n')[0]).toBe(
      '# Folded title (https://openknowledge.ai/docs/get-started/overview)',
    );
  });

  test('tolerates a missing description without emitting "undefined"', async () => {
    const md = await getLLMText(fakePage({ description: undefined }));
    expect(md).not.toContain('undefined');
    expect(md).toContain('# Overview (https://openknowledge.ai/docs/get-started/overview)');
  });

  test('fails loudly on a component with no registry disposition', async () => {
    await expect(
      getLLMText(fakePage({ getText: async () => '<Widget>content</Widget>' })),
    ).rejects.toThrow('No serializer disposition for <Widget>');
  });
});
