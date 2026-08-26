/**
 * DOM-tier guard for the one line the pane-width cap now hangs off.
 *
 * `createSuggestionPopup` stamps `data-suggestion-clipped` on popups opened
 * with `clipToEditorPane`, and a single `globals.css` rule uses that attribute
 * to make their content yield to the wrapper's cap. That replaced a
 * per-component `max-width` on each menu root, so the wiki-link and tag pickers
 * have nothing of their own left to fall back on: drop the attribute and both
 * paint over whatever is docked beside a narrowed editor pane again.
 *
 * The Playwright tier does cover it, but only as a geometry mismatch inside a
 * sharded job. This fails in milliseconds and names the invariant.
 *
 * DOM tier because the assertions are about a real element and the factory
 * appends to `document.body`. Named `.dom.test.ts`, not `.tsx`, because
 * nothing here mounts React — the jsdom config routes both.
 *
 * Invocation: `pnpm run test:dom` from `packages/app/`.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { createSuggestionPopup } from './suggestion-floating-ui';

afterEach(() => {
  for (const popup of document.querySelectorAll('[data-suggestion-popup]')) popup.remove();
});

describe('createSuggestionPopup pane-clip marker', () => {
  test('stamps the marker when the popup is pane-clipped', () => {
    const { popup } = createSuggestionPopup(() => null, 'wiki-link-suggestion', {
      clipToEditorPane: true,
    });
    expect(popup.hasAttribute('data-suggestion-clipped')).toBe(true);
  });

  test('leaves it off a popup that is not pane-clipped', () => {
    // The composer-hosted menus position against the viewport, and capping
    // them to an editor region they do not live in would be wrong.
    const { popup } = createSuggestionPopup(() => null, 'composer-mention');
    expect(popup.hasAttribute('data-suggestion-clipped')).toBe(false);
  });

  test('carries its label so the stylesheet can scope to suggestion popups', () => {
    // The rule is `[data-suggestion-popup][data-suggestion-clipped]`; the
    // marker alone would not match.
    const { popup } = createSuggestionPopup(() => null, 'tag-suggestion', {
      clipToEditorPane: true,
    });
    expect(popup.dataset.suggestionPopup).toBe('tag-suggestion');
  });

  test('stamps the marker BEFORE inserting the popup, so no frame paints uncapped', () => {
    // Read at insertion time, not after the factory returns. Asserting the
    // attribute on the returned element cannot see this ordering at all —
    // moving the dataset write below `appendChild` leaves every
    // after-the-fact assertion green while reintroducing the unclamped frame
    // this exists to prevent.
    const original = document.body.appendChild.bind(document.body);
    let markedAtInsertion: boolean | null = null;
    document.body.appendChild = ((node: Node) => {
      if (node instanceof HTMLElement && node.dataset.suggestionPopup !== undefined) {
        markedAtInsertion = node.hasAttribute('data-suggestion-clipped');
      }
      return original(node);
    }) as typeof document.body.appendChild;
    try {
      createSuggestionPopup(() => null, 'slash-command', { clipToEditorPane: true });
    } finally {
      document.body.appendChild = original;
    }
    expect(markedAtInsertion, 'popup was inserted before it was marked').toBe(true);
  });
});
