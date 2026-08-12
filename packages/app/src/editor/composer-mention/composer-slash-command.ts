/**
 * The composer's `/` slash-command surface: a typeahead over the commands the
 * host's agent advertised, plus a token decoration that tells the user — before
 * submission — whether the leading `/name` they typed is a command the agent
 * recognizes.
 *
 * Deliberately decoration-based, not a chip node like `composerMention`: the
 * command corpus is per-host (only the agent-thread composer has one) and a
 * host-gated schema node would fork the composer schema between surfaces —
 * the shared draft store would then drop chip-bearing drafts on the surfaces
 * whose schema lacks the node. Decorations style the text without touching the
 * document, so one schema serves every surface and serialization is untouched:
 * the instruction already carries `/name args` as plain text, which is exactly
 * what an ACP agent expects to receive.
 *
 * Command-list semantics mirror `ThreadInfo.availableCommands`: `null` means
 * the agent hasn't advertised yet ("not yet known" — the UI stays neutral),
 * `[]` means the agent said it has zero commands (an honest "none"), and the
 * list is live — the host swaps the extension's storage via `setSlashCommands`
 * when an `available_commands_update` arrives mid-session.
 */

import { type Editor, Extension, mergeAttributes, Node } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { PluginKey, Plugin as PmPlugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import {
  clearSuggestionSelectableCount,
  createSuggestionPopup,
  destroySuggestionPopup,
  type SuggestionPositionState,
  setSuggestionSelectableCount,
} from '../extensions/suggestion-floating-ui';
import { ComposerSlashMenu } from './ComposerSlashMenu';

/** One advertised command, trimmed to what the composer renders. Structurally
 *  satisfied by the SDK's `AvailableCommand`, so hosts pass the advertised
 *  list straight through. */
export interface SlashCommandItem {
  readonly name: string;
  readonly description: string;
  /** ACP's unstructured-input hint — "a hint to display when the input hasn't
   *  been provided yet" (e.g. Claude's `[error message | failing test]`).
   *  Preferred over `description` for the in-field ghost text. */
  readonly input?: { readonly hint: string } | null;
}

export const composerSlashSuggestionKey = new PluginKey('composerSlashSuggestion');

/**
 * A command PICKED from the `/` menu, as an atomic pill — the caret can never
 * land inside it, one arrow press crosses it whole, backspace removes it
 * whole, and re-picking replaces it wholesale. A command the user merely
 * TYPES stays plain text (styled by the token decoration): promotion to a
 * pill is the picker's act of commitment, exactly the terminal-CLI split.
 *
 * Registered in the shared composer schema for EVERY surface (see
 * `composerMentionExtensions`) even though only slash-enabled hosts can
 * create one — a host-gated schema node would make the shared draft store
 * drop pill-bearing drafts on surfaces whose schema lacked it.
 *
 * `description` / `hint` ride as attrs so the in-field ghost renders from
 * the pill itself — the advertised list can churn after the pick without
 * un-documenting a command the user already committed to.
 */
export const ComposerCommand = Node.create({
  name: 'composerCommand',
  group: 'inline',
  inline: true,
  atom: true,
  // Non-selectable so horizontal arrow movement hops STRAIGHT across the
  // pill — selectable atoms take a NodeSelection layover (caret vanishes,
  // node highlights) between the two sides. Backspace still deletes the
  // atom whole.
  selectable: false,

  addAttributes() {
    return {
      name: { default: '' },
      description: { default: '' },
      hint: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-command]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = String(node.attrs.name ?? '');
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-command': name,
        // The picked pill wears the same recognized-token styling the typed
        // form gets from the decoration — one visual system.
        class: 'composer-slash-token composer-slash-token-known',
      }),
      `/${name}`,
    ];
  },

  renderText({ node }) {
    return `/${node.attrs.name}`;
  },
});

const slashDecorationKey = new PluginKey<DecorationSet>('composerSlashToken');

const EXTENSION_NAME = 'composerSlashCommand';

interface SlashCommandOptions {
  /** Mount-time seed for {@link SlashCommandStorage.commands} — the corpus the
   *  host holds when the editor is created. */
  commands: SlashCommandItem[] | null;
}

interface SlashCommandStorage {
  /** The LIVE advertised-command list. Storage, not options, is the mutable
   *  channel: TipTap's `extension.options` getter returns a fresh copy on
   *  every access, so an options write lands on a throwaway object — while
   *  `editor.storage[name]` is the one per-editor object both the plugins and
   *  the host share by reference. Updated via {@link setSlashCommands}. */
  commands: SlashCommandItem[] | null;
}

function slashStorage(editor: Editor): SlashCommandStorage | undefined {
  return (editor.storage as unknown as Partial<Record<string, SlashCommandStorage>>)[
    EXTENSION_NAME
  ];
}

/** The live advertised-command list. Null when the editor has no slash
 *  extension (surfaces without a `/` affordance) or nothing advertised yet. */
export function getSlashCommands(editor: Editor): SlashCommandItem[] | null {
  return slashStorage(editor)?.commands ?? null;
}

/**
 * Re-point the live command list (an `available_commands_update` arrived).
 * Returns true when the stored REFERENCE changed — sufficient because every
 * producer replaces the array wholesale (`ThreadInfo.availableCommands` is
 * swapped per update, never mutated in place); an in-place mutation of the
 * same array would go undetected by design. The caller then owes the editor
 * a repaint transaction: decorations only recompute on a transaction, and a
 * list swap dispatches none of its own. False when the editor has no slash
 * extension or the reference is already current.
 */
export function setSlashCommands(editor: Editor, commands: SlashCommandItem[] | null): boolean {
  const storage = slashStorage(editor);
  if (storage === undefined || storage.commands === commands) return false;
  storage.commands = commands;
  return true;
}

/**
 * Rank the advertised commands against the picker query: name-prefix matches
 * first (the muscle-memory path — typing `/rev` should surface `/review` at
 * the top), then name-substring, then description-substring. Case-insensitive;
 * relative order within a tier stays the agent's advertised order.
 */
export function filterSlashCommands(
  commands: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...commands];
  const prefix: SlashCommandItem[] = [];
  const nameSub: SlashCommandItem[] = [];
  const descSub: SlashCommandItem[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (name.includes(q)) nameSub.push(command);
    else if (command.description.toLowerCase().includes(q)) descSub.push(command);
  }
  return [...prefix, ...nameSub, ...descSub];
}

/** The leading `/name` token of a message, or null when the text doesn't open
 *  with one. `text` is the first paragraph's text; the token ends at the first
 *  whitespace (`\S+` deliberately admits punctuation — `/review,` parses as
 *  the token `review,`, which then simply fails recognition, exactly how the
 *  agent's own prefix-based dispatch would read it). A bare `/` is not a
 *  token. */
export function leadingSlashToken(text: string): { name: string; length: number } | null {
  const match = /^\/(\S+)/.exec(text);
  if (match === null) return null;
  return { name: match[1] ?? '', length: match[0].length };
}

/**
 * What the composer should say about the draft's leading slash token, resolved
 * against the live command list. Null when there is no leading token — or when
 * the list hasn't arrived yet (`commands === null`): "not yet known" must not
 * render as "unsupported".
 */
export type SlashTokenHint =
  | { kind: 'known'; name: string; description: string }
  | { kind: 'unknown'; name: string; agentHasCommands: boolean };

export function resolveSlashTokenHint(
  firstLineText: string,
  commands: readonly SlashCommandItem[] | null,
): SlashTokenHint | null {
  const token = leadingSlashToken(firstLineText);
  if (token === null || commands === null) return null;
  const command = commands.find((c) => c.name === token.name);
  if (command !== undefined) {
    return { kind: 'known', name: command.name, description: command.description };
  }
  return { kind: 'unknown', name: token.name, agentHasCommands: commands.length > 0 };
}

/**
 * The text the message actually OPENS with: the first paragraph's leading text
 * node, or '' when the paragraph opens with anything else. Deliberately not
 * `textContent` — an atomic `@`-mention chip contributes nothing to
 * `textContent`, so a draft shaped `[chip]/review` would read as a leading
 * `/review` that is not at message start (and its decoration range would land
 * on the chip). Agents parse commands at message start only, so a token after
 * a chip is prose either way.
 */
export function composerFirstLineText(editor: Editor): string {
  return leadingTextOfBlock(editor.state.doc.firstChild);
}

function leadingTextOfBlock(block: { firstChild: PmNode | null } | null): string {
  const inline = block?.firstChild ?? null;
  return inline?.isText ? (inline.text ?? '') : '';
}

/**
 * Decoration classes for the leading token. Both states pair a shape cue with
 * the color so the distinction never rides color alone: recognized gets a
 * filled pill, unrecognized a dashed underline (see globals.css).
 *
 * A recognized command with NOTHING typed after it additionally gets in-field
 * ghost text (the terminal-CLI idiom): the command's argument hint — ACP's
 * `input.hint`, else its description — rendered as an inert widget after the
 * caret, gone the moment the user types an argument. This replaces any
 * under-field line for the recognized case; only the unrecognized warning
 * renders below the field.
 */
function slashTokenDecorations(
  doc: Editor['state']['doc'],
  commands: SlashCommandItem[] | null,
): DecorationSet {
  const paragraph = doc.firstChild;
  const leadInline = paragraph?.firstChild ?? null;

  // A PICKED pill leads the draft: the node styles itself, so only the
  // argument-hint ghost applies — from the pill's own attrs, so a later
  // corpus churn can't un-document a command already committed to.
  if (leadInline !== null && leadInline.type.name === 'composerCommand') {
    if (!draftIsBarePill(doc)) return DecorationSet.empty;
    const hint = String(leadInline.attrs.hint ?? '');
    const description = String(leadInline.attrs.description ?? '');
    const ghostText = hint !== '' ? hint : description !== '' ? `— ${description}` : '';
    if (ghostText === '') return DecorationSet.empty;
    return DecorationSet.create(doc, [
      ghostWidget(1 + (paragraph?.content.size ?? 0), ghostText, String(leadInline.attrs.name)),
    ]);
  }

  if (commands === null) return DecorationSet.empty;
  const token = leadingSlashToken(leadingTextOfBlock(doc.firstChild));
  if (token === null) return DecorationSet.empty;
  const command = commands.find((c) => c.name === token.name);
  // The first block's content starts at doc position 1, and the token comes
  // from its leading TEXT node (leadingTextOfBlock), so [1, 1 + token length)
  // always lies inside that text node — never across a chip.
  const decorations: Decoration[] = [
    Decoration.inline(1, 1 + token.length, {
      class:
        command !== undefined
          ? 'composer-slash-token composer-slash-token-known'
          : 'composer-slash-token composer-slash-token-unknown',
    }),
  ];
  if (command !== undefined && draftIsBareCommand(doc, token.length)) {
    const ghostText =
      command.input?.hint != null && command.input.hint !== ''
        ? command.input.hint
        : `— ${command.description}`;
    if (command.description !== '' || command.input?.hint) {
      decorations.push(
        ghostWidget(1 + (doc.firstChild?.firstChild?.nodeSize ?? 0), ghostText, command.name),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

function ghostWidget(pos: number, ghostText: string, key: string): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const span = document.createElement('span');
      span.className = 'composer-slash-ghost';
      // Inert scaffolding, not content: never read to AT, never a click
      // target (a click lands in the editor text behind it).
      span.setAttribute('aria-hidden', 'true');
      span.textContent = ghostText;
      return span;
    },
    // After the caret, so typing stays visually ahead of the ghost; a stable
    // key keeps the widget from re-mounting per keystroke.
    { side: 1, key: `slash-ghost:${key}` },
  );
}

/** True when the whole draft is exactly the leading `/command` (plus at most
 *  one trailing space): one paragraph, one text node, nothing else typed —
 *  the only state where the argument-hint ghost belongs. */
function draftIsBareCommand(doc: Editor['state']['doc'], tokenLength: number): boolean {
  if (doc.childCount !== 1) return false;
  const paragraph = doc.firstChild;
  if (paragraph === null || paragraph.childCount !== 1) return false;
  const inline = paragraph.firstChild;
  if (inline === null || !inline.isText) return false;
  const text = inline.text ?? '';
  return text.length <= tokenLength + 1 && (text.length === tokenLength || text.endsWith(' '));
}

/** The pill twin of {@link draftIsBareCommand}: one paragraph whose content is
 *  the pill alone, or the pill plus whitespace-only text (the picker inserts a
 *  trailing space) — nothing else typed yet. */
function draftIsBarePill(doc: Editor['state']['doc']): boolean {
  if (doc.childCount !== 1) return false;
  const paragraph = doc.firstChild;
  if (paragraph === null) return false;
  if (paragraph.childCount === 1) return true;
  if (paragraph.childCount !== 2) return false;
  const second = paragraph.child(1);
  return second.isText && /^\s*$/.test(second.text ?? '');
}

/**
 * The `/` typeahead + token-state extension. Included in the composer's
 * extension list only when the host supplies a command corpus (the agent-thread
 * composer); every other surface omits it and `/` stays inert text.
 */
export const ComposerSlashCommand = Extension.create<SlashCommandOptions, SlashCommandStorage>({
  name: EXTENSION_NAME,

  addOptions() {
    return { commands: null };
  },

  addStorage() {
    // Seed the live (mutable) storage from the mount-time configured corpus;
    // later updates land through `setSlashCommands`.
    return { commands: this.options.commands };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    // Read through the shared storage object on EVERY call — the host swaps
    // `storage.commands` when `available_commands_update` arrives, and a
    // captured copy would pin the picker to the mount-time list.
    const liveCommands = (): SlashCommandItem[] | null => storage.commands ?? null;

    const tokenPlugin = new PmPlugin<DecorationSet>({
      key: slashDecorationKey,
      state: {
        init: (_config, state) => slashTokenDecorations(state.doc, liveCommands()),
        // Recomputed on every transaction, not just `docChanged`: a command-list
        // update reaches the editor as an empty repaint transaction (the same
        // mechanism the locale repaint uses), and the token's state can flip
        // without the document changing. The computation only reads the first
        // block's leading text, so it's cheap enough to run unconditionally.
        apply: (tr) => slashTokenDecorations(tr.doc, liveCommands()),
      },
      props: {
        decorations(state) {
          return this.getState(state);
        },
      },
    });

    const suggestion = Suggestion<SlashCommandItem>({
      editor: this.editor,
      pluginKey: composerSlashSuggestionKey,
      char: '/',
      // Message start only: agents parse commands at the head of the prompt,
      // so a `/` anywhere else is prose (paths, "and/or") and must not pop the
      // picker. `startOfLine` prunes mid-line matches cheaply; the `allow`
      // check pins the match to the FIRST block (position 1 is the first text
      // position of the first paragraph).
      startOfLine: true,
      allow: ({ range }) => range.from === 1,

      items: ({ query }) => {
        const commands = liveCommands();
        if (commands === null || commands.length === 0) return [];
        return filterSlashCommands(commands, query);
      },

      command: ({ editor, range, props: item }) => {
        // Replace the ENTIRE leading token, not just the matched range: with
        // the caret mid-token (`/ana|lyze`) the suggestion range ends at the
        // caret, and deleting only that much would leave the token's tail
        // (`lyze`) as junk after the inserted pill.
        const leading = editor.state.doc.firstChild?.firstChild ?? null;
        const tokenLength = leading?.isText
          ? (leadingSlashToken(leading.text ?? '')?.length ?? 0)
          : 0;
        try {
          // Picking promotes the command to an atomic pill (serializes back
          // to `/name` via renderText); the trailing space ends the
          // suggestion match and leaves the caret ready for arguments. One
          // chain — one transaction (precedent #58).
          editor
            .chain()
            .focus()
            .deleteRange({ from: range.from, to: Math.max(range.to, 1 + tokenLength) })
            .insertContent([
              {
                type: 'composerCommand',
                attrs: {
                  name: item.name,
                  description: item.description,
                  hint: item.input?.hint ?? '',
                },
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        } catch (err) {
          // TipTap chains are atomic, so a partial insert cannot occur;
          // surface the failure for diagnostics and let the user retry.
          console.error('[composer-slash-command] insert failed', { item, range }, err);
        }
      },

      render: () => {
        let renderer: ReactRenderer<typeof ComposerSlashMenu> | null = null;
        let currentProps: SuggestionProps<SlashCommandItem> | null = null;
        let selectedIndex = 0;
        const posState: SuggestionPositionState = { popup: null, stopAutoUpdate: null };
        let doPosition: (() => void) | null = null;
        // The view the count was published against, held for onExit —
        // `currentProps` is nulled before the clear could read it.
        let publishedView: object | null = null;

        const onSelect = (item: SlashCommandItem) => {
          currentProps?.command(item);
        };

        // Tell the composer's Enter guard whether this picker has anything to
        // commit — over an empty list (unknown command, advertised-none corpus)
        // Enter must submit the prompt, not sit on a popup that can't act.
        const publishSelectableCount = (props: SuggestionProps<SlashCommandItem>) => {
          publishedView = props.editor.view;
          setSuggestionSelectableCount(publishedView, (props.items ?? []).length);
        };

        const computeMenuProps = (props: SuggestionProps<SlashCommandItem>) => ({
          items: props.items ?? [],
          query: props.query ?? '',
          selectedIndex,
          onSelect,
          // Distinguishes the two empty corpora for the menu's copy: null =
          // nothing advertised yet, [] = the agent said "none".
          commandsKnown: liveCommands() !== null,
        });

        const rerender = () => {
          if (!renderer || !currentProps) return;
          renderer.updateProps(computeMenuProps(currentProps));
        };

        return {
          onBeforeStart(props: SuggestionProps<SlashCommandItem>) {
            currentProps = props;
            selectedIndex = 0;
            publishSelectableCount(props);
            const result = createSuggestionPopup(() => currentProps, 'composer-slash');
            posState.popup = result.popup;
            doPosition = result.doPosition;
            renderer = new ReactRenderer(ComposerSlashMenu, {
              props: computeMenuProps(props),
              editor: props.editor,
            });
            result.popup.appendChild(renderer.element);
            posState.stopAutoUpdate = result.startAutoUpdate();
            // Sync menu — content is final by the time the popup positions.
            result.reveal();
          },

          onStart(props: SuggestionProps<SlashCommandItem>) {
            currentProps = props;
            selectedIndex = 0;
            publishSelectableCount(props);
            rerender();
          },

          onUpdate(props: SuggestionProps<SlashCommandItem>) {
            currentProps = props;
            selectedIndex = Math.min(selectedIndex, Math.max(0, props.items.length - 1));
            publishSelectableCount(props);
            rerender();
            doPosition?.();
          },

          onKeyDown({ event }: SuggestionKeyDownProps) {
            if (!currentProps) return false;
            const items = currentProps.items;
            if (event.key === 'ArrowDown') {
              if (items.length === 0) return false;
              selectedIndex = (selectedIndex + 1) % items.length;
              rerender();
              return true;
            }
            if (event.key === 'ArrowUp') {
              if (items.length === 0) return false;
              selectedIndex = (selectedIndex - 1 + items.length) % items.length;
              rerender();
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = items[selectedIndex];
              if (!item) return false;
              currentProps.command(item);
              return true;
            }
            return false;
          },

          onExit() {
            destroySuggestionPopup(posState);
            doPosition = null;
            renderer?.destroy();
            renderer = null;
            currentProps = null;
            selectedIndex = 0;
            if (publishedView !== null) {
              clearSuggestionSelectableCount(publishedView);
              publishedView = null;
            }
          },
        };
      },
    });

    return [tokenPlugin, suggestion];
  },
});
