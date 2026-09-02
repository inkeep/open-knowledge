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
    const { popup } = createSuggestionPopup(() => null, 'composer-mention');
    expect(popup.hasAttribute('data-suggestion-clipped')).toBe(false);
  });

  test('carries its label so the stylesheet can scope to suggestion popups', () => {
    const { popup } = createSuggestionPopup(() => null, 'tag-suggestion', {
      clipToEditorPane: true,
    });
    expect(popup.dataset.suggestionPopup).toBe('tag-suggestion');
  });

  test('stamps the marker BEFORE inserting the popup, so no frame paints uncapped', () => {
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
