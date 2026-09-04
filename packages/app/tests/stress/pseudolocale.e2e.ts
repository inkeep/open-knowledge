import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from './_helpers';

function compiledCatalog(locale: string): Record<string, unknown[]> {
  const path = fileURLToPath(new URL(`../../src/locales/${locale}/messages.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { messages: Record<string, unknown[]> })
    .messages;
}

const EN = compiledCatalog('en');
const PSEUDO = compiledCatalog('pseudo');

function markedForm(english: string): string {
  const id = Object.keys(EN).find((key) => EN[key]?.[0] === english);
  if (id === undefined) throw new Error(`"${english}" is not a message in the en catalog`);

  const marked = PSEUDO[id]?.[0];
  if (typeof marked !== 'string' || marked === english) {
    throw new Error(`the pseudolocale leaves "${english}" unmarked`);
  }
  return marked;
}

const WRAPPED = 'New file';

const UNWRAPPED_TITLE = 'OpenKnowledge';

test.describe('pseudolocale', () => {
  test('marks the copy that went through the catalog and leaves the rest plain', async ({
    page,
  }) => {
    await page.goto('/?lang=pseudo');

    await expect(
      page.getByRole('button', { name: markedForm(WRAPPED), exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: WRAPPED, exact: true })).toHaveCount(0);

    await expect(page).toHaveTitle(UNWRAPPED_TITLE);
  });

  test('an ordinary load is unmarked, so the marking above is the parameter talking', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: WRAPPED, exact: true })).toBeVisible();
  });
});
