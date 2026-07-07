import { describe, expect, test } from 'bun:test';
import { getLLMText } from './get-llm-text.ts';

type Page = Parameters<typeof getLLMText>[0];

/** Minimal page stand-in — getLLMText only touches `url` + `data`. */
function fakePage(data: Partial<Page['data']> = {}, url = '/docs/get-started/overview'): Page {
  return {
    url,
    data: {
      title: 'Overview',
      description: 'What OpenKnowledge is.',
      getText: async (type: 'raw' | 'processed') => `BODY(${type})`,
      ...data,
    },
  } as unknown as Page;
}

describe('getLLMText', () => {
  test('renders title + URL header, description, then processed body', async () => {
    const md = await getLLMText(fakePage());
    expect(md).toBe(
      `# Overview (/docs/get-started/overview)

What OpenKnowledge is.

BODY(processed)`,
    );
  });

  test('requests the processed Markdown variant (snippets resolved), not raw', async () => {
    let requested: string | undefined;
    await getLLMText(
      fakePage({
        getText: async (type) => {
          requested = type;
          return '';
        },
      }),
    );
    expect(requested).toBe('processed');
  });

  test('tolerates a missing description without emitting "undefined"', async () => {
    const md = await getLLMText(fakePage({ description: undefined }));
    expect(md).not.toContain('undefined');
    expect(md).toContain('# Overview (/docs/get-started/overview)');
  });
});
