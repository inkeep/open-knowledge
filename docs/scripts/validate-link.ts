import { getTableOfContents } from 'fumadocs-core/content/toc';
import { getSlugs } from 'fumadocs-core/source';
import { printErrors, readFiles, scanURLs, validateFiles } from 'next-validate-link';
import { composeTabId } from '../src/components/tabs';

const TABS_OPEN_TAG = /<Tabs\b([^>]*)>/g;
const GROUP_ID_ATTR = /groupId=["']([^"']+)["']/;
const ITEMS_ATTR = /items=\{\[(.*?)\]\}/s;
const STRING_LITERAL = /(['"])(.*?)\1/g;

function tabHashes(content: string): string[] {
  const hashes: string[] = [];
  for (const tag of content.matchAll(TABS_OPEN_TAG)) {
    const attrs = tag[1] ?? '';
    const groupId = attrs.match(GROUP_ID_ATTR)?.[1];
    const items = attrs.match(ITEMS_ATTR)?.[1];
    if (!items) continue;
    for (const literal of items.matchAll(STRING_LITERAL)) {
      const id = composeTabId(literal[2], groupId);
      if (id) hashes.push(id);
    }
  }
  return hashes;
}

async function checkLinks() {
  const docsFiles = await readFiles(['content/**/*.{md,mdx}']);

  const scanned = await scanURLs({
    populate: {
      'docs/[...slug]': docsFiles.map((file) => {
        return {
          value: getSlugs(file.path.replace(/^content\//, '')),
          hashes: [
            ...getTableOfContents(file.content).map((item) => item.url.slice(1)),
            ...tabHashes(file.content),
          ],
        };
      }),
    },
  });

  const standardErrors = await validateFiles(docsFiles, {
    scanned,
  });

  printErrors(standardErrors, true);
}

void checkLinks();
