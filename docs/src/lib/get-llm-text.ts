import type { InferPageType } from 'fumadocs-core/source';
import type { source } from '@/lib/source';

/**
 * Render a single docs page as a clean Markdown document for agent / LLM
 * consumption: a title + canonical-URL header, the description, then the
 * processed Markdown body (snippets resolved, MDX components reduced to plain
 * Markdown). The processed body requires `includeProcessedMarkdown` on the
 * `docs` collection (see source.config.ts).
 *
 * Shared by `/llms-full.txt` (whole corpus) and the per-page `…/<slug>.md`
 * route so the two presentations never drift.
 */
export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const processed = await page.data.getText('processed');

  return `# ${page.data.title} (${page.url})

${page.data.description || ''}

${processed}`;
}
