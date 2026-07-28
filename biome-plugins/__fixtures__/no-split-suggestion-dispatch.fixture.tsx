/**
 * Fixture for `no-split-suggestion-dispatch.grit` (precedent #58).
 *
 * 3 positive cases (MUST each fire exactly once):
 *   P1 — bare trigger-delete chain dispatch inside a Suggestion config
 *        (`.focus().deleteRange(range).run()` — the pre-fix slash-command shape).
 *   P2 — bare delete chain without `.focus()` (`.deleteRange(range).run()`).
 *   P3 — `commands.deleteRange(range)` immediate dispatch inside a Suggestion
 *        config.
 *
 * 4 negative cases (MUST NOT fire):
 *   N1 — atomic single chain: `.deleteRange(range).insertContent(...).run()`
 *        (the tag/wiki-link/composer-mention shape).
 *   N2 — boundary composition: `.deleteRange(range).command(...).run()`
 *        (the applySlashCommandItem shape).
 *   N3 — delegation to a boundary function (the fixed slash-command shape).
 *   N4 — a bare `deleteRange(...).run()` chain OUTSIDE any Suggestion config
 *        (delete-only surfaces like a chip's remove button are legitimate).
 *
 * The paired test asserts the plugin fires exactly 3 times on this file.
 */

// Minimal stand-ins — the rule matches call shapes, not imports.
declare function Suggestion(config: Record<string, unknown>): unknown;
declare const applySlashCommandItem: (args: Record<string, unknown>) => void;

interface FixtureEditor {
  chain(): FixtureChain;
  commands: { deleteRange(range: FixtureRange): boolean };
}
interface FixtureChain {
  focus(): FixtureChain;
  deleteRange(range: FixtureRange): FixtureChain;
  insertContent(content: unknown): FixtureChain;
  command(fn: (props: unknown) => boolean): FixtureChain;
  run(): boolean;
}
interface FixtureRange {
  from: number;
  to: number;
}
interface FixtureCommandProps {
  editor: FixtureEditor;
  range: FixtureRange;
  props: { command: (editor: FixtureEditor) => void };
}

// P1 — the pre-fix slash-command bug: delete dispatched alone, item dispatches
// its own transaction afterward.
export const positiveSplitWithFocus = Suggestion({
  command: ({ editor, range, props: item }: FixtureCommandProps) => {
    editor.chain().focus().deleteRange(range).run();
    item.command(editor);
  },
});

// P2 — same split without the focus() step.
export const positiveSplitBare = Suggestion({
  command: ({ editor, range, props: item }: FixtureCommandProps) => {
    editor.chain().deleteRange(range).run();
    item.command(editor);
  },
});

// P3 — commands.* form dispatches immediately: a standalone delete transaction.
export const positiveCommandsForm = Suggestion({
  command: ({ editor, range, props: item }: FixtureCommandProps) => {
    editor.commands.deleteRange(range);
    item.command(editor);
  },
});

// N1 — atomic single chain (tag / wiki-link / composer-mention shape).
export const negativeAtomicChain = Suggestion({
  command: ({ editor, range }: FixtureCommandProps) => {
    editor.chain().focus().deleteRange(range).insertContent({ type: 'tag' }).run();
  },
});

// N2 — boundary composition: the item contributes steps via `.command()`.
export const negativeBoundaryComposition = Suggestion({
  command: ({ editor, range, props: item }: FixtureCommandProps) => {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .command(() => {
        item.command(editor);
        return true;
      })
      .run();
  },
});

// N3 — delegation to the sanctioned boundary (the fixed slash-command shape).
export const negativeDelegation = Suggestion({
  command: ({ editor, range, props: item }: FixtureCommandProps) =>
    applySlashCommandItem({ editor, item, range }),
});

// N4 — delete-only dispatch OUTSIDE a Suggestion config (e.g. a mention chip's
// remove button). Legitimate: there is no follow-up insert to split from.
export function negativeOutsideSuggestion(editor: FixtureEditor, range: FixtureRange): void {
  editor.chain().focus().deleteRange(range).run();
}
