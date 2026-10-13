import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  placeCaretAtEndOfText,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

interface NestedComponentCase {
  title: string;
  seed: string;
  editedText: string;
}

const TYPED = 'Z';

const CASES: readonly NestedComponentCase[] = [
  {
    title: 'a Callout inside a list item',
    seed: '# Nested\n\n- item\n\n  <Callout type="info">\n    body line\n  </Callout>\n\n- next\n\nAfter.\n',
    editedText: 'item',
  },
  {
    title: 'a Callout inside a blockquote',
    seed: '# Nested\n\n> quote\n>\n> <Callout type="info">\n> body line\n> </Callout>\n\nAfter.\n',
    editedText: 'quote',
  },
  {
    title: 'an unknown component inside a list item',
    seed: '# Nested\n\n- item\n\n  <Unknown a="1">\n    body line\n  </Unknown>\n\n- next\n\nAfter.\n',
    editedText: 'item',
  },
  {
    title: 'an unknown component inside a Callout',
    seed: '# Nested\n\n<Callout type="info">\n  para\n\n  <Unknown a="1">\n    body line\n  </Unknown>\n</Callout>\n\nAfter.\n',
    editedText: 'para',
  },
  {
    title: 'a Callout inside a Callout',
    seed: '# Nested\n\n<Callout type="info">\n  para\n\n  <Callout type="warning">\n    body line\n  </Callout>\n</Callout>\n\nAfter.\n',
    editedText: 'para',
  },
  {
    title: 'a Callout inside an ordered list item',
    seed: '# Nested\n\n10) item\n\n    <Callout type="info">\n      body line\n    </Callout>\n\n11) next\n\nAfter.\n',
    editedText: 'item',
  },
  {
    title: 'a Callout inside a blockquote inside a list item',
    seed: '# Nested\n\n- item\n\n  > <Callout type="info">\n  > body line\n  > </Callout>\n\n- next\n\nAfter.\n',
    editedText: 'item',
  },
  {
    title: 'a Callout inside a list item inside a blockquote',
    seed: '# Nested\n\n> - item\n>\n>   <Callout type="info">\n>     body line\n>   </Callout>\n\nAfter.\n',
    editedText: 'item',
  },
  {
    title: 'a Callout on the first line of a list item',
    seed: '# Nested\n\n- <Callout type="info">\n    body line\n  </Callout>\n- item\n\nAfter.\n',
    editedText: 'item',
  },
  {
    title: 'a multi-line expression inside a list item',
    seed: "# Nested\n\n- item\n\n  {\n    'body line'\n  }\n\n- next\n\nAfter.\n",
    editedText: 'item',
  },
];

function readSource(page: Page): Promise<string> {
  return page.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
}

async function openSeededDoc(page: Page, docName: string): Promise<void> {
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await page.waitForFunction(
    () => {
      const editor = window.__activeEditor;
      if (!editor?.state.doc.textContent.includes('body line')) return false;
      let unconvertedWildcard = false;
      editor.state.doc.descendants((node) => {
        if (
          node.type.name === 'jsxComponent' &&
          (node.attrs.componentName === 'Unknown' || node.attrs.kind === 'expression')
        ) {
          unconvertedWildcard = true;
        }
      });
      return !unconvertedWildcard;
    },
    null,
    { timeout: 10_000 },
  );
}

function readParseErrorFallbacks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('readParseErrorFallbacks: window.__activeEditor not set');
    const reasons: string[] = [];
    editor.state.doc.descendants((node) => {
      const reason = typeof node.attrs.reason === 'string' ? node.attrs.reason : '';
      if (node.type.name === 'rawMdxFallback' && !reason.startsWith('Unregistered component:')) {
        reasons.push(reason);
      }
    });
    return reasons;
  });
}

test.describe('a WYSIWYG edit beside a nested multi-line component', () => {
  for (const c of CASES) {
    test(`keeps the bytes of ${c.title}`, async ({ page, api }) => {
      const docName = `test-nested-component-${randomUUID().slice(0, 8)}`;
      const expected = c.seed.replace(c.editedText, `${c.editedText}${TYPED}`);
      await api.createPage(`${docName}.md`);
      await api.testReset(docName);
      await api.replaceDoc(docName, c.seed);
      await openSeededDoc(page, docName);

      expect(
        await readSource(page),
        'opening the document changed its bytes before any edit, so the sibling edit below is not what rewrote the nested component',
      ).toBe(c.seed);

      await placeCaretAtEndOfText(page, c.editedText);
      await page.keyboard.type(TYPED);

      await expect
        .poll(() => readSource(page), { timeout: 10_000 })
        .toContain(`${c.editedText}${TYPED}`);
      expect(
        await readSource(page),
        'the sibling edit re-serialized the container, and the untouched nested component did not keep its bytes',
      ).toBe(expected);

      await page.reload();
      await openSeededDoc(page, docName);
      expect(await readSource(page)).toBe(expected);
      expect(
        await readParseErrorFallbacks(page),
        'after a reload the nested component renders as a parse-error box',
      ).toEqual([]);
    });
  }
});
