/**
 * Pin the invariant that when source mode is the active surface for a
 * TipTap editor, the three `@tiptap/suggestion`-based extensions (slash
 * `/`, wiki-link `[[`, tag `#`) must NOT activate floating popups —
 * regardless of which transaction origin produced the content change.
 *
 * The popup `<div>` is appended to `document.body` (via
 * `createSuggestionPopup`), bypassing the `.ok-mode-hidden` CSS gate
 * applied to every other floating UI surface. The gate is enforced
 * inside `@tiptap/suggestion`'s `apply()` reducer via each plugin's
 * `allow` predicate, which reads `getEditorSourceMode(editor)` (a
 * per-editor WeakMap; see `editor-mode-context.ts`).
 *
 * A positive-control test pins the complementary assertion (suggestions
 * DO activate in WYSIWYG mode) so an over-broad change to the predicate
 * — e.g. `allow: () => false` — would fail loudly here rather than
 * silently breaking the slash menu in normal editing.
 *
 * Tier: `.dom.test.tsx` (jsdom preload). TipTap's `new Editor({ ... })`
 * requires `document` and `window`; the integration tier substrate
 * deliberately omits jsdom, so Tiptap-mount tests live here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
// `cleanup` is imported to satisfy the dom-test-filename-stop-rule
// contract (every `*.dom.test.tsx` file must value-import from
// `@testing-library/react`). It is invoked in `afterEach` so any
// inadvertent RTL render in a future iteration is torn down between
// tests; the suite itself constructs the Editor directly and does not
// render through RTL.
import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { setEditorSourceMode } from '../../src/editor/extensions/editor-mode-context';
import { sharedExtensions } from '../../src/editor/extensions/shared';

interface SuggestionPluginState {
  active: boolean;
}

/**
 * Find a Suggestion-plugin instance on the editor by its plugin-key name
 * prefix. The three keys (`slashCommand`, `wikiLinkSuggestion`,
 * `tagSuggestion`) are constructed via `new PluginKey('<name>')` which
 * synthesizes a unique suffix (`<name>$` or `<name>$<n>`). We match the
 * prefix because `slashCommandKey` is not exported from
 * `slash-command.ts` and we don't want to widen the production surface
 * just for tests.
 */
function getSuggestionState(editor: Editor, keyPrefix: string): SuggestionPluginState | null {
  const plugin = editor.state.plugins.find((p) => {
    const keyName = (p as { spec?: { key?: { key?: string } } }).spec?.key?.key;
    return typeof keyName === 'string' && keyName.startsWith(keyPrefix);
  });
  if (!plugin) return null;
  const state = plugin.getState(editor.state) as SuggestionPluginState | undefined;
  return state ?? null;
}

function mountEditor(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    content: '<p></p>',
    extensions: sharedExtensions,
    editable: true,
  });
  return { editor, container };
}

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
  // The suggestion popup divs are appended to `document.body` directly,
  // not to the editor's container — destroy() invokes the plugins' view
  // `destroy()` which calls `destroySuggestionPopup()`, but if anything
  // leaked we clean up here so subsequent tests start with an empty body.
  for (const node of Array.from(document.body.children)) {
    if (node !== container) node.remove();
  }
}

/**
 * `editor.commands.insertContent('/')` dispatches a transaction; the
 * Suggestion plugin's `view.update()` callback then fires synchronously
 * and may invoke `onStart`, which mounts a ReactRenderer into a popup
 * `<div>` appended to `document.body`. React 19's `createRoot().render`
 * is concurrent — yield to the microtask queue twice to let the render
 * commit.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Source mode suppresses TipTap suggestion plugins (plugin-state contract)', () => {
  afterEach(() => {
    cleanup();
  });

  test('slash command plugin state is inactive in source mode after typing `/`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, true);
      editor.commands.insertContent('/');
      await flush();
      const state = getSuggestionState(editor, 'slashCommand');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(false);
    } finally {
      teardown(editor, container);
    }
  });

  test('wiki-link suggestion plugin state is inactive in source mode after typing `[[`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, true);
      editor.commands.insertContent('[[');
      await flush();
      const state = getSuggestionState(editor, 'wikiLinkSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(false);
    } finally {
      teardown(editor, container);
    }
  });

  test('tag suggestion plugin state is inactive in source mode after typing `#`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, true);
      // The tagMatcher regex requires a whitespace or atom boundary
      // before `#` (see `tag-suggestion.ts` `tagMatcher`); insert a
      // space first so the trigger position is valid.
      editor.commands.insertContent(' #');
      await flush();
      const state = getSuggestionState(editor, 'tagSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(false);
    } finally {
      teardown(editor, container);
    }
  });
});

describe('Source mode suppresses TipTap suggestion popup DOM (observable contract)', () => {
  afterEach(() => {
    cleanup();
  });

  /**
   * The composite invariant the user sees: no suggestion popup is
   * appended to `document.body` when source mode is active and a trigger
   * character is inserted. Covers all three surfaces in one assertion
   * tier.
   *
   * The popup `<div>` is appended SYNCHRONOUSLY by
   * `createSuggestionPopup` inside `onStart`
   * (`document.body.appendChild(popup)` in
   * `extensions/suggestion-floating-ui.ts`); the React-rendered listbox
   * inside is mounted via ReactRenderer in a queued microtask. To stay
   * robust to React-19 scheduler timing in jsdom, the assertion targets
   * the synchronously-appended popup `<div>` itself — counting children
   * of `document.body` that are NOT the editor container. The popup is
   * the only thing these extensions can append to body, so any extra
   * child is a leak.
   *
   */
  test('no suggestion popup is appended to document.body when source mode is active', async () => {
    const { editor, container } = mountEditor();
    const countLeakedChildren = (): number =>
      Array.from(document.body.children).filter((el) => el !== container).length;
    try {
      setEditorSourceMode(editor, true);

      // Snapshot: only the editor container should be on body at the
      // start. If a future extension adds another body child at mount
      // time, this baseline catches it (so the popup assertion below
      // attributes the +1 correctly to the trigger insert).
      expect(countLeakedChildren()).toBe(0);

      editor.commands.insertContent('/');
      await flush();
      expect(countLeakedChildren()).toBe(0);

      editor.commands.clearContent();
      editor.commands.insertContent('[[');
      await flush();
      expect(countLeakedChildren()).toBe(0);

      editor.commands.clearContent();
      editor.commands.insertContent(' #');
      await flush();
      expect(countLeakedChildren()).toBe(0);

      // Cross-cut on the React-rendered listbox content (in case
      // ReactRenderer commits in a later microtask): no listbox of any
      // kind ever appears on body when source mode is active.
      expect(document.body.querySelectorAll('[role="listbox"]').length).toBe(0);
    } finally {
      teardown(editor, container);
    }
  });
});

describe('WYSIWYG mode activates TipTap suggestion plugins (positive control)', () => {
  afterEach(() => {
    cleanup();
  });

  /**
   * Complement to the suppression tests above. Without this assertion,
   * a regression that broadens the gate to unconditional `allow: () => false`
   * — or omits the WeakMap initialization so every editor defaults to
   * source-mode — would silently break the slash menu in normal editing
   * while leaving every other test in this suite green. Targeting
   * `slashCommand` is sufficient because all three extensions share the
   * same gating path through `getEditorSourceMode`.
   *
   */
  test('slash command plugin state is active in WYSIWYG mode after typing `/`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, false);
      editor.commands.insertContent('/');
      await flush();
      const state = getSuggestionState(editor, 'slashCommand');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });

  /**
   * Wiki-link wiring goes through `configureWikiLinkSuggestion`, not the inline
   * `addProseMirrorPlugins()` slash-command uses. A future refactor that drops
   * the `allow` predicate from that factory wouldn't be caught by the slash
   * positive control alone.
   */
  test('wiki-link suggestion plugin state is active in WYSIWYG mode after typing `[[`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, false);
      editor.commands.insertContent('[[');
      await flush();
      const state = getSuggestionState(editor, 'wikiLinkSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });

  /**
   * Tag wiring goes through `configureTagSuggestion`, same reasoning as the
   * wiki-link positive control above.
   */
  test('tag suggestion plugin state is active in WYSIWYG mode after typing ` #`', async () => {
    const { editor, container } = mountEditor();
    try {
      setEditorSourceMode(editor, false);
      editor.commands.insertContent(' #');
      await flush();
      const state = getSuggestionState(editor, 'tagSuggestion');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });

  /**
   * Pins the `?? false` default in `getEditorSourceMode`. A freshly constructed
   * editor before its `setEditorSourceMode` useEffect fires should still surface
   * the slash menu — otherwise the brief mount-race window would suppress
   * suggestions in normal WYSIWYG.
   */
  test('slash command is active for an editor that has never had setEditorSourceMode called', async () => {
    const { editor, container } = mountEditor();
    try {
      editor.commands.insertContent('/');
      await flush();
      const state = getSuggestionState(editor, 'slashCommand');
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });
});
