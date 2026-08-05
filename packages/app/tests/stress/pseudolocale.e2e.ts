/**
 * Pseudolocale E2E.
 *
 * Covers what the instrument is for: a reviewer opens the app with `?lang=pseudo`
 * and can tell, at a glance and without reading any language, which copy on
 * screen went through the catalog and which never got wrapped. The first is
 * marked; the second is still plain.
 *
 * Implementation under test:
 *   - packages/app/src/lib/dev-pseudo-locale.ts
 *   - packages/app/src/lib/use-apply-config-language.ts (the handover)
 *
 * The jsdom tier next to those modules already pins the catalog swap. What only
 * a browser can show is that the request survives a real boot — the parameter
 * reaching a hash-routed app, the effect running before anything is on screen,
 * and the marked strings actually rendering.
 */

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

/**
 * The pseudolocalized form of an English message, read out of the real
 * catalogs. Written down here instead, it would rot the first time Lingui
 * changed the transform — and it would stop being evidence, since the
 * expectation would no longer come from the thing under test.
 */
function markedForm(english: string): string {
  const id = Object.keys(EN).find((key) => EN[key]?.[0] === english);
  if (id === undefined) throw new Error(`"${english}" is not a message in the en catalog`);

  const marked = PSEUDO[id]?.[0];
  if (typeof marked !== 'string' || marked === english) {
    throw new Error(`the pseudolocale leaves "${english}" unmarked`);
  }
  return marked;
}

/** A sidebar-toolbar label: catalog-backed, and on screen from the first frame. */
const WRAPPED = 'New file';

/** `index.html` writes this and nothing rewrites it, so it never sees a catalog. */
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

    // The two classes side by side: an unwrapped string is still plain English
    // on the same screen, which is what makes a sweep possible.
    await expect(page).toHaveTitle(UNWRAPPED_TITLE);
  });

  test('an ordinary load is unmarked, so the marking above is the parameter talking', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: WRAPPED, exact: true })).toBeVisible();
  });
});
