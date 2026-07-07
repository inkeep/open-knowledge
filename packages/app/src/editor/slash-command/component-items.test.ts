/**
 * `getComponentItems()` returns the slash-menu entries: descriptor-driven
 * canonicals filtered by `SLASH_HIDDEN_CANONICALS`, plus a hand-written
 * "custom block" set for canonicals whose user-facing insert path is NOT
 * the JSX-form descriptor default. Today: `File` is hidden from the
 * descriptor pass and inserted via a custom entry that opens the OS file
 * picker and runs `uploadAndInsert` (same path as drag-drop). The
 * canonical set offered as JSX inserts: Callout, Image, Video, Audio,
 * Accordion, Math, Mermaid, Pdf — eight canonicals (File is a slash-hidden
 * canonical surfaced via the custom entry).
 *
 * Compat descriptors (CommonMarkImage, GFMCallout, HtmlDetailsAccordion,
 * WikiEmbed*, DollarMath, MathFence, MermaidFence) are read-only and
 * never offered for fresh insertion.
 *
 * `getInlineComponentItems()` covers inline-only PM atoms that aren't in
 * the descriptor registry (the registry stays block-only).
 * Inline atoms map directly to PM nodes via the `mdxJsxTextElement`
 * short-circuit in `markdown/index.ts`; their slash entries are hand-
 * authored here. Entries: `Link` (lands a placeholder `link` mark +
 * auto-opens its target editor) and `Tag` (insertion-only — the NodeView's
 * auto-focused placeholder input handles the rest, no popover plumbing).
 */

import { describe, expect, spyOn, test } from 'bun:test';
import {
  builtInComponents,
  getAgentCanonicalDescriptors,
  getCanonicalDescriptors,
} from '@inkeep/open-knowledge-core';
import {
  _resetPendingLinkEditForTest,
  consumePendingLinkEdit,
} from '../extensions/link-edit-autoopen';
import { markIdentityKey } from '../extensions/mark-identity';
import {
  createChildNode,
  getComponentItems,
  getInlineComponentItems,
  SLASH_HIDDEN_CANONICALS,
} from './component-items';

describe('getComponentItems (slash menu)', () => {
  test('returns descriptor-driven canonicals + the custom File entry', () => {
    const items = getComponentItems();
    const labels = items.map((i) => i.label).sort();
    // `Tab` is canonical but explicitly hidden via `SLASH_HIDDEN_CANONICALS`
    // (only meaningful nested inside `<Tabs>`).
    expect(labels).toEqual(
      [
        'Accordion',
        'Audio',
        'Callout',
        'Embed',
        'File',
        'Image',
        'Math',
        'Mermaid',
        'Mirror',
        'Mirror Source',
        'PDF',
        'Tabs',
        'Video',
      ].sort(),
    );
  });

  test('File entry is the custom upload-picker variant, NOT the descriptor JSX-insert', () => {
    const items = getComponentItems();
    const file = items.find((i) => i.label === 'File');
    expect(file).toBeDefined();
    // The descriptor-driven entries name themselves `component-${desc.name}`
    // and use `createInsertCommand` which inserts a jsxComponent with
    // declared default props. The custom File entry shares the same
    // `component-File` name (so dedup against descriptor IDs works) but
    // its command opens a file picker — no synchronous PM insert at
    // slash-select time.
    expect(file?.name).toBe('component-File');
    expect(file?.icon).toBeDefined();
    expect(file?.command).toBeFunction();
  });

  test('every entry exposes the SlashCommandItem contract', () => {
    const items = getComponentItems();
    for (const item of items) {
      expect(item.name).toMatch(/^component-/);
      expect(item.label).toBeString();
      expect(item.icon).toBeDefined();
      expect(item.category).toBeString();
      expect(item.command).toBeFunction();
    }
  });

  test('compat descriptors are absent — fresh inserts are canonical-only', () => {
    const items = getComponentItems();
    // The compat descriptors' names: 'CommonMarkImage', 'GFMCallout',
    // 'HtmlDetailsAccordion'. None should appear (filter is `surface ===
    // 'canonical'`).
    for (const compatName of ['CommonMarkImage', 'GFMCallout', 'HtmlDetailsAccordion']) {
      expect(items.some((i) => i.name === `component-${compatName}`)).toBe(false);
    }
  });

  // The slash-menu preview aside (SlashCommandMenu) renders preview.description
  // in a w-64 box that line-clamps to 3 lines (~3 x ~40 chars). line-clamp-3 is
  // the hard visual guarantee; this is the authoring guardrail that keeps the
  // PREVIEW_CONFIG copy short enough that the clamp never has to truncate.
  test('every component preview description fits the slash aside 3-line budget (<= 120 chars)', () => {
    const MAX_PREVIEW_DESCRIPTION_LENGTH = 120;
    const descriptions = getComponentItems()
      .map((i) => i.preview?.description)
      .filter((d): d is string => typeof d === 'string');
    // Guard against a false green if resolution ever stops yielding strings.
    expect(descriptions.length).toBeGreaterThan(0);
    const tooLong = descriptions
      .filter((d) => d.length > MAX_PREVIEW_DESCRIPTION_LENGTH)
      .map((d) => `${d.length} chars: ${d.slice(0, 50)}`);
    expect(tooLong).toEqual([]);
  });
});

describe('createChildNode — default props on slash insert', () => {
  test('img: only declared defaults are pre-populated, no synthetic 0 / "" / first-enum', () => {
    // The img descriptor declares defaults for `loading: 'lazy'`,
    // `decoding: 'auto'`, `fetchpriority: 'auto'`, and `src: ''` (the empty
    // default is intentional — the placeholder predicate keys off `src === ''`
    // to surface the "Add an image" pill on slash insert; authored markdown
    // `<img />` parses to `src: undefined` and skips the pill).
    //
    // `alt` is REQUIRED but declares NO defaultValue: slash-insert leaves
    // the key absent so the tri-state `needsConfig` predicate fires the
    // chrome-bar gear nudge (key-absence = "author hasn't decided yet";
    // `alt=""` would be the explicit decorative opt-in per WCAG 1.1.1).
    //
    // Everything else (width, height, srcset, sizes, title, crossorigin,
    // referrerpolicy) has no declared default and must stay unset so
    // PropPanel renders empty inputs and the next serialize doesn't emit
    // `<img width={0} crossorigin="anonymous" srcset="" />` to disk.
    const node = createChildNode('img');
    const props = (node.attrs as { props?: Record<string, unknown> }).props ?? {};
    expect(props.loading).toBe('lazy');
    expect(props.decoding).toBe('auto');
    expect(props.fetchpriority).toBe('auto');
    expect(props.src).toBe('');
    // Required-no-defaultValue: key absent so needsConfig fires on insert.
    expect(props).not.toHaveProperty('alt');
    // Unset (no declared default):
    expect(props.width).toBeUndefined();
    expect(props.height).toBeUndefined();
    expect(props.srcset).toBeUndefined();
    expect(props.sizes).toBeUndefined();
    expect(props.title).toBeUndefined();
    expect(props.crossorigin).toBeUndefined();
    expect(props.referrerpolicy).toBeUndefined();
  });

  test('video: src="" (empty default for placeholder) and controls=true (declared); everything else unset', () => {
    const node = createChildNode('video');
    const props = (node.attrs as { props?: Record<string, unknown> }).props ?? {};
    expect(props.controls).toBe(true);
    expect(props.src).toBe('');
    expect(props.poster).toBeUndefined();
    expect(props.width).toBeUndefined();
    expect(props.height).toBeUndefined();
    expect(props.title).toBeUndefined();
  });

  test('audio: src="" (empty default for placeholder) and controls=true (declared); everything else unset', () => {
    const node = createChildNode('audio');
    const props = (node.attrs as { props?: Record<string, unknown> }).props ?? {};
    expect(props.controls).toBe(true);
    expect(props.src).toBe('');
    expect(props.title).toBeUndefined();
  });

  test('Tab: defaultValue label="Tab", empty paragraph body, id unset', () => {
    // The `+ Add Tab` pill in JsxComponentView (and the Tabs slash-command
    // seeding path that drops Tab 1 / Tab 2 starters) both route through
    // `createChildNode('Tab')`. The descriptor's `label` declares
    // `defaultValue: 'Tab'` so the strip pill renders something legible
    // immediately; downstream the user typically rewrites it via the
    // PropPanel (autoFocus is on). `id` has no declared default so the
    // node serializes WITHOUT an `id=""` attribute (which would be
    // round-trip noise).
    const node = createChildNode('Tab');
    expect((node as { type?: string }).type).toBe('jsxComponent');
    expect((node.attrs as { componentName?: string }).componentName).toBe('Tab');
    const props = (node.attrs as { props?: Record<string, unknown> }).props ?? {};
    expect(props.label).toBe('Tab');
    expect(props.id).toBeUndefined();
    // hasChildren container → seeded with a single empty paragraph so PM
    // has a typing target.
    const content = (node as { content?: unknown[] }).content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<{ type: string }>).length).toBe(1);
    expect((content as Array<{ type: string }>)[0].type).toBe('paragraph');
  });

  test('Tabs: id unset by default (no synthetic id="" emitted on roundtrip)', () => {
    const node = createChildNode('Tabs');
    const props = (node.attrs as { props?: Record<string, unknown> }).props ?? {};
    expect(props.id).toBeUndefined();
    // The slash-insert command for Tabs special-cases content to
    // [Tab "Tab 1", Tab "Tab 2"], but the raw `createChildNode('Tabs')`
    // returns the generic single-empty-paragraph default — the seeding
    // happens at the call site (component-items.tsx), not here.
    const content = (node as { content?: unknown[] }).content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<{ type: string }>)[0].type).toBe('paragraph');
  });
});

describe('agent-surface ↔ slash-menu filter parity', () => {
  // Both surfaces start from the broad canonical set (canonical && not
  // wildcard) and apply their own curation rules:
  //   - Slash-menu: subtract `SLASH_HIDDEN_CANONICALS` (`File`, `Tab` today)
  //     because their UX-best authoring path is the OS picker or a parent
  //     container; the descriptor still exists for round-trip render.
  //   - Agent surface: subtract fence-kind canonicals (`MermaidFence` today)
  //     because there is no JSX shape to author — agents write the fence
  //     directly via baseline markdown (```mermaid ... ```).
  //
  // The two filters diverge in both directions today — neither is a strict
  // subset of the other. The invariants below pin each curation against the
  // broad canonical baseline.

  function broadCanonicalSet(): Set<string> {
    return new Set(getCanonicalDescriptors().map((d) => d.name));
  }

  function agentCanonicalSet(): Set<string> {
    return new Set(getAgentCanonicalDescriptors().map((d) => d.name));
  }

  function slashMenuCanonicalSet(): Set<string> {
    return new Set(
      builtInComponents
        .filter(
          (d) =>
            d.surface === 'canonical' && d.name !== '*' && !SLASH_HIDDEN_CANONICALS.has(d.name),
        )
        .map((d) => d.name),
    );
  }

  test('both surfaces are subsets of the broad canonical set', () => {
    const broad = broadCanonicalSet();
    for (const name of agentCanonicalSet()) {
      expect(broad.has(name)).toBe(true);
    }
    for (const name of slashMenuCanonicalSet()) {
      expect(broad.has(name)).toBe(true);
    }
  });

  test('broad set minus agent set === fence-kind names (today: just MermaidFence)', () => {
    const broad = broadCanonicalSet();
    const agent = agentCanonicalSet();
    const divergence = new Set([...broad].filter((name) => !agent.has(name)));
    expect(divergence).toEqual(new Set(['MermaidFence']));
  });

  test('broad set minus slash-menu set === SLASH_HIDDEN_CANONICALS exactly', () => {
    const broad = broadCanonicalSet();
    const slash = slashMenuCanonicalSet();
    const divergence = new Set([...broad].filter((name) => !slash.has(name)));
    expect(divergence).toEqual(new Set(SLASH_HIDDEN_CANONICALS));
  });

  test('intersection covers every canonical NOT in either curation set (11 names today)', () => {
    const agent = agentCanonicalSet();
    const slash = slashMenuCanonicalSet();
    const intersection = new Set([...agent].filter((name) => slash.has(name)));
    expect(intersection.size).toBe(11);
  });

  test('agent surface excludes wildcard descriptor', () => {
    expect(agentCanonicalSet().has('*')).toBe(false);
  });

  test('agent surface excludes every compat descriptor', () => {
    const agent = agentCanonicalSet();
    for (const d of builtInComponents) {
      if (d.surface === 'compat') {
        expect(agent.has(d.name)).toBe(false);
      }
    }
  });
});

describe('getInlineComponentItems — inline-atom slash entries', () => {
  test('returns Link and Tag entries with unique names', () => {
    const items = getInlineComponentItems();
    expect(items.length).toBe(2);
    const names = items.map((item) => item.name);
    expect(names).toEqual(['link', 'component-Tag']);
    // Names must be unique across the menu (the slash extension warns on
    // collisions and renders both).
    expect(new Set(names).size).toBe(names.length);
  });

  test('returns the Tag entry with the SlashCommandItem contract', () => {
    const tag = getInlineComponentItems().find((item) => item.name === 'component-Tag');
    expect(tag).toBeDefined();
    if (!tag) return;
    expect(tag.label).toBe('Tag');
    expect(tag.category).toBe('content');
    expect(tag.icon).toBeDefined();
    expect(tag.command).toBeFunction();
    expect(tag.aliases).toContain('hashtag');
    expect(tag.aliases).toContain('#');
  });

  test('Link entry lands an empty placeholder link mark and no-ops auto-open without the identity plugin', () => {
    const link = getInlineComponentItems().find((item) => item.name === 'link');
    expect(link).toBeDefined();
    if (!link) return;
    expect(link.label).toBe('Link');
    expect(link.category).toBe('insert');
    expect(link.aliases).toContain('url');
    expect(link.aliases).toContain('external');
    expect(link.aliases).toContain('page');
    expect(link.aliases).toContain('wiki');

    let insertedContent: { type?: string; text?: string; marks?: unknown[] } | undefined;
    let rafScheduled = false;
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => {
      rafScheduled = true;
      return 0;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      const editor = {
        // No markIdentity plugin in this mock → getState() returns undefined,
        // so the command inserts the chip then returns before scheduling rAF.
        state: { selection: { from: 1 } },
        chain: () => ({
          focus: () => ({
            insertContent: (content: typeof insertedContent) => ({
              run: () => {
                insertedContent = content;
              },
            }),
          }),
        }),
      };
      link.command(editor as never);
      expect(insertedContent?.type).toBe('text');
      expect(insertedContent?.text).toBe('link');
      expect(insertedContent?.marks).toEqual([{ type: 'link', attrs: { href: '' } }]);
      // Graceful degradation: with no mark-identity state there's no id to
      // activate, so the auto-open path (rAF → setActiveNode) is skipped.
      expect(rafScheduled).toBe(false);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });

  test('Link entry flags the inserted mark and schedules auto-open when mark-identity resolves it', () => {
    const link = getInlineComponentItems().find((item) => item.name === 'link');
    expect(link).toBeDefined();
    if (!link) return;

    // Stub the mark-identity plugin state so findLinkMarkIdAt resolves the
    // freshly inserted link mark (spanning the insert position) to a stable
    // id — exercising the production happy path without a live PM view.
    const getStateSpy = spyOn(markIdentityKey, 'getState').mockReturnValue({
      byId: new Map([['m7', { id: 'm7', markType: 'link', from: 1, to: 5, attrs: { href: '' } }]]),
      counter: 7,
    } as never);

    // Capture rAF without invoking it: the deferred getInteractionLayer →
    // setActiveNode is an integration concern (needs a live editor view),
    // out of scope for this unit. We assert only that it was scheduled.
    let rafScheduled = false;
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => {
      rafScheduled = true;
      return 0;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      const editor = {
        state: { selection: { from: 1 } },
        chain: () => ({
          focus: () => ({
            insertContent: () => ({ run: () => {} }),
          }),
        }),
      };
      link.command(editor as never);

      // findLinkMarkIdAt resolved 'm7' and the command flagged it for
      // auto-edit — consume confirms the flag is present (and drains it).
      expect(consumePendingLinkEdit('m7')).toBe(true);
      // The prop-panel activation was scheduled for the next frame.
      expect(rafScheduled).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      getStateSpy.mockRestore();
      _resetPendingLinkEditForTest();
    }
  });

  test('command inserts an empty `tag` atom WITHOUT leading focus() (NodeView grabs focus)', () => {
    // Post-popover redesign: the slash command is now a one-liner —
    // insert an empty atom and let the NodeView's rAF-deferred mount
    // effect pull focus into the placeholder's inline input on the
    // next frame. Crucially: NO leading `chain().focus()` here —
    // explicit editor-focus would race with the rAF and leave the
    // cursor past the atom instead of inside the input.
    let chainFocusCalled = false;
    let inserted = false;
    let insertedValue: string | undefined;
    const editor = {
      chain: () => ({
        focus: () => {
          chainFocusCalled = true;
          return {
            insertTag: (value: string) => ({
              run: () => {
                inserted = true;
                insertedValue = value;
              },
            }),
          };
        },
        insertTag: (value: string) => ({
          run: () => {
            inserted = true;
            insertedValue = value;
          },
        }),
      }),
    };
    const tag = getInlineComponentItems().find((item) => item.name === 'component-Tag');
    if (!tag) throw new Error('Tag entry missing');
    tag.command(editor as never);
    expect(inserted).toBe(true);
    expect(insertedValue).toBe('');
    // Pin the no-leading-focus invariant: the slash command must NOT
    // call `chain().focus()` before insertion (focus race regression
    // guard — see `TagView.tsx`'s mount-effect rAF comment).
    expect(chainFocusCalled).toBe(false);
  });
});
