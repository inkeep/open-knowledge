/**
 * Tier-3 tests for the composer's `/` slash-command surface end to end through
 * `ComposerMentionInput`: host gating (no corpus prop → `/` stays inert), the
 * token decoration's recognized/unresolved states, the hint line's three-way
 * copy, live command-list updates re-resolving both, the picker's suggestion
 * lifecycle (message-start trigger, keyboard selection), and the
 * one-transaction insertion pin (precedent #58).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { act, createRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ComposerMentionInput, type ComposerMentionInputHandle } from '../ComposerMentionInput';
import {
  composerSlashSuggestionKey,
  getSlashCommands,
  type SlashCommandItem,
} from './composer-slash-command';

const COMMANDS: SlashCommandItem[] = [
  { name: 'review', description: 'Review the current diff' },
  { name: 'create_plan', description: 'Draft an implementation plan' },
  {
    name: 'debug',
    description: 'Root-cause a failure',
    input: { hint: '[error message | failing test]' },
  },
];

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The editor's async mount emits act() warnings under jsdom; real failures
  // still surface as missing-element assertion failures.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  // Suggestion popups portal to document.body and can outlive an unmounted
  // editor; clear them so the next test's queries start clean.
  for (const node of document.querySelectorAll('[data-suggestion-popup]')) node.remove();
  consoleErrorSpy.mockRestore();
});

/** Reach the live editor from the rendered textbox — TipTap's EditorContent
 *  tags the contenteditable host node with the instance. */
function getComposerEditor(box: HTMLElement): Editor {
  return (box as unknown as { editor: Editor }).editor;
}

function renderComposer(props?: {
  slashCommands?: SlashCommandItem[] | null;
  onSubmit?: () => void;
}) {
  const ref = createRef<ComposerMentionInputHandle>();
  const utils = render(
    <ComposerMentionInput
      ref={ref}
      ariaLabel="Message Agent"
      onEmptyChange={() => {}}
      onSubmit={props?.onSubmit ?? (() => {})}
      slashCommands={props && 'slashCommands' in props ? props.slashCommands : undefined}
    />,
  );
  const box = screen.getByRole('textbox', { name: 'Message Agent' });
  return { ref, box, editor: getComposerEditor(box), ...utils };
}

/** Deliver a key to the slash Suggestion plugin's own `handleKeyDown` — the
 *  same entry point ProseMirror's keydown dispatch uses — so the production
 *  `render().onKeyDown` runs against the live picker state. */
function pressKeyOnSlashSuggestion(editor: Editor, key: string): boolean {
  const plugin = composerSlashSuggestionKey.get(editor.state);
  const handleKeyDown = plugin?.props.handleKeyDown;
  if (!plugin || !handleKeyDown) return false;
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  return handleKeyDown.call(plugin, editor.view, event) === true;
}

/** The suggestion `items()` resolves through the plugin's own microtask
 *  plumbing even for a sync corpus — poll a macrotask tick until the picker
 *  answers the key. */
async function pressKeyOnceItemsLoad(editor: Editor, key: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (pressKeyOnSlashSuggestion(editor, key)) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

describe('host gating — surfaces without a corpus prop', () => {
  test('omitting slashCommands mounts no slash plugin, no decoration, no hint', () => {
    const { ref, box, editor } = renderComposer();
    expect(composerSlashSuggestionKey.get(editor.state)).toBeUndefined();
    expect(getSlashCommands(editor)).toBeNull();
    act(() => ref.current?.setText('/review the diff'));
    expect(box.querySelector('.composer-slash-token')).toBeNull();
    expect(screen.queryByTestId('composer-slash-hint')).toBeNull();
  });
});

describe('token decoration + hint line', () => {
  test('a recognized command with arguments decorates as known — no ghost, no hint line', () => {
    const { ref, box } = renderComposer({ slashCommands: COMMANDS });
    act(() => ref.current?.setText('/review the diff'));
    const token = box.querySelector('.composer-slash-token-known');
    expect(token).not.toBeNull();
    expect(token?.textContent).toBe('/review');
    // Arguments are typed: the ghost is gone and the under-field region stays
    // empty — a recognized command never renders a persistent line below.
    expect(box.querySelector('.composer-slash-ghost')).toBeNull();
    expect(screen.getByTestId('composer-slash-hint').textContent).toBe('');
  });

  test('a bare recognized command shows its description as in-field ghost text', () => {
    const { ref, box } = renderComposer({ slashCommands: COMMANDS });
    act(() => ref.current?.setText('/review'));
    const ghost = box.querySelector('.composer-slash-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe('— Review the current diff');
    // Inert scaffolding: hidden from AT (the region below covers warnings)
    // and never a pointer target.
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('composer-slash-hint').textContent).toBe('');
  });

  test("the ghost prefers the command's argument hint and vanishes once arguments arrive", () => {
    const { ref, box } = renderComposer({ slashCommands: COMMANDS });
    act(() => ref.current?.setText('/debug '));
    expect(box.querySelector('.composer-slash-ghost')?.textContent).toBe(
      '[error message | failing test]',
    );
    act(() => ref.current?.setText('/debug the flaky boot test'));
    expect(box.querySelector('.composer-slash-ghost')).toBeNull();
    expect(box.querySelector('.composer-slash-token-known')).not.toBeNull();
  });

  test('an unrecognized command decorates as unresolved and says so before submission', () => {
    const { ref, box } = renderComposer({ slashCommands: COMMANDS });
    act(() => ref.current?.setText('/tasks'));
    const token = box.querySelector('.composer-slash-token-unknown');
    expect(token).not.toBeNull();
    expect(token?.textContent).toBe('/tasks');
    expect(screen.getByTestId('composer-slash-hint').textContent).toContain(
      "isn't a command this agent offers",
    );
  });

  test('an advertised-empty corpus says the agent has no commands at all', () => {
    const { ref } = renderComposer({ slashCommands: [] });
    act(() => ref.current?.setText('/tasks'));
    expect(screen.getByTestId('composer-slash-hint').textContent).toContain(
      "doesn't offer slash commands",
    );
  });

  test('a null corpus (not yet advertised) makes no claim either way', () => {
    const { ref, box } = renderComposer({ slashCommands: null });
    act(() => ref.current?.setText('/review'));
    expect(box.querySelector('.composer-slash-token')).toBeNull();
    // The live region is pre-registered (mounted empty) so its FIRST real
    // announcement isn't dropped — no-claim renders as empty, not absent.
    expect(screen.getByTestId('composer-slash-hint').textContent).toBe('');
  });

  test('a slash mid-message never decorates — commands live at message start', () => {
    const { ref, box } = renderComposer({ slashCommands: COMMANDS });
    act(() => ref.current?.setText('use /review please'));
    expect(box.querySelector('.composer-slash-token')).toBeNull();
    expect(screen.getByTestId('composer-slash-hint').textContent).toBe('');
  });

  test('a slash after a leading @-mention chip is prose, not a command', () => {
    // An atomic chip contributes nothing to textContent, so a naive
    // "first line text" read would see `[chip]/review` as a leading /review —
    // and its decoration range would land on the chip. The token must come
    // from a leading TEXT node only.
    const ref = createRef<ComposerMentionInputHandle>();
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Message Agent"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        slashCommands={COMMANDS}
        initialDoc={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'composerMention', attrs: { path: 'notes.md', label: 'Notes' } },
                { type: 'text', text: '/review' },
              ],
            },
          ],
        }}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Message Agent' });
    expect(box.querySelector('.composer-slash-token')).toBeNull();
    expect(screen.getByTestId('composer-slash-hint').textContent).toBe('');
  });

  test('a live command-list update re-resolves the token and hint in place', () => {
    const { ref, box, rerender } = renderComposer({ slashCommands: null });
    act(() => ref.current?.setText('/review the diff'));
    expect(box.querySelector('.composer-slash-token')).toBeNull();
    // The agent's `available_commands_update` arrives mid-draft.
    rerender(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Message Agent"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        slashCommands={COMMANDS}
      />,
    );
    expect(box.querySelector('.composer-slash-token-known')).not.toBeNull();
    // Arguments are present in this draft, so recognition shows as the pill
    // alone — no ghost, empty region.
    expect(screen.getByTestId('composer-slash-hint').textContent).toBe('');
  });
});

describe('picker lifecycle', () => {
  test('typing / at message start opens the picker; Enter inserts a pill in ONE transaction', async () => {
    const { editor, ref, box } = renderComposer({ slashCommands: COMMANDS });
    editor.commands.focus('end');
    editor.commands.insertContent('/rev');

    let docChangingCount = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) docChangingCount += 1;
    });

    // Precondition: the picker became selectable (menu is live).
    expect(await pressKeyOnceItemsLoad(editor, 'Enter')).toBe(true);
    // The selection replaced the `/rev` range with an ATOMIC pill node + a
    // trailing space, as exactly one doc-changing transaction (precedent #58 —
    // a split delete+insert can remap onto adjacent nodes and destroy them).
    expect(docChangingCount).toBe(1);
    const lead = editor.state.doc.firstChild?.firstChild;
    expect(lead?.type.name).toBe('composerCommand');
    expect(lead?.attrs.name).toBe('review');
    // Atomic: one unit for arrows/backspace, no caret positions inside.
    expect(lead?.isAtom).toBe(true);
    // The pill renders as the recognized token and serializes back to the
    // invocation text the agent's prefix-based dispatch expects.
    expect(box.querySelector('[data-composer-command="review"]')?.textContent).toBe('/review');
    expect(ref.current?.getContent().instruction).toBe('/review');
  });

  test('picking with the caret mid-token replaces the WHOLE token — no tail junk', async () => {
    const { editor, ref } = renderComposer({ slashCommands: COMMANDS });
    editor.commands.focus('end');
    editor.commands.insertContent('/create_plan');
    // Park the caret inside the typed token (`/cr|eate_plan`) and re-open the
    // picker there. Selecting must consume the token's tail too — deleting
    // only up to the caret would leave `eate_plan` as junk after the pill.
    editor.commands.setTextSelection(4);
    expect(await pressKeyOnceItemsLoad(editor, 'Enter')).toBe(true);
    const { instruction } = ref.current?.getContent() ?? { instruction: '' };
    expect(instruction).toBe('/create_plan');
    expect(editor.state.doc.textContent).not.toContain('eate_plan');
  });

  test('a picked bare pill shows the ghost from its own attrs; typing arguments clears it', async () => {
    const { editor, box } = renderComposer({ slashCommands: COMMANDS });
    editor.commands.focus('end');
    editor.commands.insertContent('/deb');
    expect(await pressKeyOnceItemsLoad(editor, 'Enter')).toBe(true);
    // Bare pill (+ the picker's trailing space): the argument hint shows.
    expect(box.querySelector('.composer-slash-ghost')?.textContent).toBe(
      '[error message | failing test]',
    );
    editor.commands.insertContent('the flaky boot');
    expect(box.querySelector('.composer-slash-ghost')).toBeNull();
  });

  test('the menu lists advertised commands and arrow keys move the selection', async () => {
    const { editor } = renderComposer({ slashCommands: COMMANDS });
    editor.commands.focus('end');
    editor.commands.insertContent('/');

    expect(await pressKeyOnceItemsLoad(editor, 'ArrowDown')).toBe(true);
    const menu = screen.getByTestId('composer-slash-menu');
    expect(menu.textContent).toContain('/review');
    expect(menu.textContent).toContain('/create_plan');
    // ArrowDown moved the highlight off row 0 onto row 1.
    expect(
      screen.getByTestId('composer-slash-option-create_plan').getAttribute('aria-selected'),
    ).toBe('true');
  });

  test('Enter while the picker is open never submits the prompt', async () => {
    const onSubmit = vi.fn(() => {});
    const { editor, box } = renderComposer({ slashCommands: COMMANDS, onSubmit });
    editor.commands.focus('end');
    editor.commands.insertContent('/rev');
    // Wait for the picker to become live, then route Enter through the
    // component's own keydown path (the submit guard under test).
    await pressKeyOnceItemsLoad(editor, 'ArrowDown');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Enter over an EMPTY picker submits the prompt — never splits the paragraph', async () => {
    // The suggestion plugin's `active` flag is regex-derived and stays true
    // over an empty result list; a blanket defer would fall through to
    // TipTap's core splitBlock and reward "press Enter to send" with a blank
    // line. The pickers publish their selectable count so the guard defers
    // only when Enter has something to commit.
    const onSubmit = vi.fn(() => {});
    const { editor, box } = renderComposer({ slashCommands: COMMANDS, onSubmit });
    editor.commands.focus('end');
    editor.commands.insertContent('/zzz');
    // Let the picker open and resolve its (empty) item list.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(composerSlashSuggestionKey.getState(editor.state)?.active).toBe(true);
    expect(screen.getByTestId('composer-slash-menu').textContent).toContain('No matching commands');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // The document was not mutated by a fallthrough splitBlock.
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe('/zzz');
  });

  test('Escape while the picker is open dismisses it — never fires onEscape', async () => {
    // The agent-thread composer wires onEscape to turn cancellation; an
    // Escape meant to close the picker must not reach it.
    const onEscape = vi.fn(() => {});
    const ref = createRef<ComposerMentionInputHandle>();
    render(
      <ComposerMentionInput
        ref={ref}
        ariaLabel="Message Agent"
        onEmptyChange={() => {}}
        onSubmit={() => {}}
        onEscape={onEscape}
        slashCommands={COMMANDS}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Message Agent' });
    const editor = getComposerEditor(box);
    editor.commands.focus('end');
    editor.commands.insertContent('/rev');
    await pressKeyOnceItemsLoad(editor, 'ArrowDown');
    expect(composerSlashSuggestionKey.getState(editor.state)?.active).toBe(true);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled();
  });

  test('a slash mid-text does not open the picker', async () => {
    const { editor } = renderComposer({ slashCommands: COMMANDS });
    editor.commands.focus('end');
    editor.commands.insertContent('see /rev');
    // Give the plugin its microtask room, then confirm it never went live.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(composerSlashSuggestionKey.getState(editor.state)?.active).toBeFalsy();
    expect(screen.queryByTestId('composer-slash-menu')).toBeNull();
  });
});
