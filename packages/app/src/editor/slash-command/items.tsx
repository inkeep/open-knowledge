import {
  collectFootnoteIdentifiers,
  findFootnoteDefinitionInsertPos,
  nextFootnoteIdentifier,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Sigma,
  Superscript,
  Table2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { setPendingAutoOpen } from './component-items';

/**
 * A slash command menu item.
 *
 * Items are grouped by category in the menu. The extension handles trigger
 * detection, range deletion, and keyboard navigation — item commands only
 * need to insert/toggle the desired content.
 */
export interface SlashCommandItem {
  /** Unique identifier (used as React key) */
  name: string;

  /** Display label shown in the menu */
  label: string;

  /** Lucide icon component */
  icon: React.ComponentType<{ className?: string }>;

  /**
   * Category key for grouping. Built-in categories: `basic`, `insert`.
   * Downstream consumers can add custom categories by registering labels
   * via `SlashCommand.configure({ categoryLabels: {...} })`.
   */
  category: string;

  /**
   * Command to execute when the item is selected. The extension deletes
   * the trigger range (`/query`) before calling this, so commands can
   * directly insert or toggle content without worrying about cleanup.
   */
  command: (editor: Editor) => void;

  /** Alternative search terms (e.g., `['h1']` for "Heading 1") */
  aliases?: string[];

  /**
   * Optional description for future UI enhancements (not currently displayed).
   * Reserved for tooltips or expanded menu views.
   */
  description?: string;

  /**
   * Optional hover preview shown alongside the menu when this item is selected
   * (via mouse hover or keyboard navigation). Items without a preview cause the
   * side panel to disappear.
   */
  preview?: {
    description: string;
    render: () => ReactNode;
  };
}

/**
 * Built-in slash command items — headings, lists, quote, code, table, separator.
 * Organized into two categories: `basic` (formatting blocks) and `insert` (special blocks).
 *
 * A function (not a module-level const) so the `t`-macro labels and preview
 * descriptions re-resolve in the active locale each time the slash menu opens.
 */
export function getSlashCommandItems(): SlashCommandItem[] {
  return [
    // Basic blocks
    {
      name: 'heading1',
      label: t`Heading 1`,
      icon: Heading1,
      category: 'basic',
      command: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      aliases: ['h1'],
      preview: {
        description: t`Big section heading.`,
        render: () => (
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans>Heading 1</Trans>
          </h1>
        ),
      },
    },
    {
      name: 'heading2',
      label: t`Heading 2`,
      icon: Heading2,
      category: 'basic',
      command: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      aliases: ['h2'],
      preview: {
        description: t`Medium section heading.`,
        render: () => (
          <h2 className="text-xl font-semibold tracking-tight">
            <Trans>Heading 2</Trans>
          </h2>
        ),
      },
    },
    {
      name: 'heading3',
      label: t`Heading 3`,
      icon: Heading3,
      category: 'basic',
      command: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      aliases: ['h3'],
      preview: {
        description: t`Small section heading.`,
        render: () => (
          <h3 className="text-base font-semibold tracking-tight">
            <Trans>Heading 3</Trans>
          </h3>
        ),
      },
    },
    {
      name: 'bulletList',
      label: t`Bullet List`,
      icon: List,
      category: 'basic',
      command: (editor) => editor.chain().focus().toggleBulletList().run(),
      aliases: ['ul', 'unordered'],
      preview: {
        description: t`Unordered list of items.`,
        render: () => (
          <ul className="list-disc pl-5 text-sm leading-7">
            <li>
              <Trans>First item</Trans>
            </li>
            <li>
              <Trans>Second item</Trans>
            </li>
          </ul>
        ),
      },
    },
    {
      name: 'orderedList',
      label: t`Ordered List`,
      icon: ListOrdered,
      category: 'basic',
      command: (editor) => editor.chain().focus().toggleOrderedList().run(),
      aliases: ['ol', 'numbered'],
      preview: {
        description: t`Numbered list of items.`,
        render: () => (
          <ol className="list-decimal pl-5 text-sm leading-7">
            <li>
              <Trans>First item</Trans>
            </li>
            <li>
              <Trans>Second item</Trans>
            </li>
          </ol>
        ),
      },
    },
    {
      name: 'taskList',
      label: t`Task List`,
      icon: ListTodo,
      category: 'basic',
      command: (editor) => editor.chain().focus().toggleTaskList().run(),
      aliases: ['todo', 'checklist', 'checkbox'],
      preview: {
        description: t`Checklist with checkboxes.`,
        render: () => (
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-center gap-2">
              <input type="checkbox" checked readOnly className="size-3.5" />
              <span className="text-muted-foreground line-through">
                <Trans>Done</Trans>
              </span>
            </li>
            <li className="flex items-center gap-2">
              <input type="checkbox" readOnly className="size-3.5" />
              <span>
                <Trans>To do</Trans>
              </span>
            </li>
          </ul>
        ),
      },
    },
    {
      name: 'blockquote',
      label: t`Quote`,
      icon: Quote,
      category: 'basic',
      command: (editor) => editor.chain().focus().toggleBlockquote().run(),
      aliases: ['quote'],
      preview: {
        description: t`Indented blockquote for citations.`,
        render: () => (
          <blockquote className="border-l-2 border-muted-foreground/40 pl-3 text-sm italic text-muted-foreground">
            <Trans>A pull quote stands out from the surrounding text.</Trans>
          </blockquote>
        ),
      },
    },
    {
      name: 'codeBlock',
      label: t`Code Block`,
      icon: Code2,
      category: 'basic',
      // Default to JavaScript at creation so syntax highlighting fires on
      // the first character. The default lives here (and on the sibling
      // bare-backticks input rule + BlockTypeSelector) rather than as a
      // schema default — the y-tiptap bridge would otherwise migrate
      // parsed-from-disk bare fences. See `extensions/code-block.ts`'s
      // top-of-file comment for the bridge mechanics.
      command: (editor) => editor.chain().focus().toggleCodeBlock({ language: 'js' }).run(),
      aliases: ['code', 'fence'],
      preview: {
        description: t`Fenced code block with monospace text.`,
        render: () => (
          <pre className="rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-5">
            <code>{'const greeting = "Hello";\nconsole.log(greeting);'}</code>
          </pre>
        ),
      },
    },
    // Insert blocks
    {
      name: 'table',
      label: t`Table`,
      icon: Table2,
      category: 'insert',
      command: (editor) =>
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      aliases: ['grid'],
      preview: {
        description: t`Grid of rows and columns with a header row.`,
        // Cell values (Ada / Engineer / Grace / Admiral) are an illustrative
        // sample dataset, left as-is; only the column headers are wrapped.
        render: () => (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">
                  <Trans>Name</Trans>
                </th>
                <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">
                  <Trans>Role</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-border px-2 py-1">Ada</td>
                <td className="border border-border px-2 py-1">Engineer</td>
              </tr>
              <tr>
                <td className="border border-border px-2 py-1">Grace</td>
                <td className="border border-border px-2 py-1">Admiral</td>
              </tr>
            </tbody>
          </table>
        ),
      },
    },
    {
      name: 'separator',
      label: t`Separator`,
      icon: Minus,
      category: 'insert',
      command: (editor) => editor.chain().focus().setHorizontalRule().run(),
      aliases: ['hr', 'divider', 'rule'],
      preview: {
        description: t`Horizontal rule that divides sections.`,
        render: () => (
          <div className="w-full">
            <p className="mb-2 text-xs text-muted-foreground">
              <Trans>Above</Trans>
            </p>
            <hr className="border-border" />
            <p className="mt-2 text-xs text-muted-foreground">
              <Trans>Below</Trans>
            </p>
          </div>
        ),
      },
    },
    {
      // Footnote — inserts an inline `[^N]` reference at the cursor AND
      // appends a matching definition stub at the end of the doc. The
      // identifier auto-increments based on existing footnoteDefinition
      // nodes (so the second `/footnote` insert produces `[^2]`, etc.).
      // Authors can rename the identifier afterward via source-mode edit;
      // mdast pairs reference→definition by `identifier` regardless.
      name: 'footnote',
      label: t`Footnote`,
      // Footnote references render as `<sup>` (superscript), so the menu
      // icon should match the rendering — `Subscript` would point the
      // wrong direction.
      icon: Superscript,
      category: 'insert',
      command: (editor) => {
        // Identifier allocation: max existing integer identifier + 1.
        // Shared with the bubble-menu Footnote entry (see
        // `bubble-menu/FootnoteBubbleButton.tsx`) — both surfaces collect
        // identifiers via the same `collectFootnoteIdentifiers` walker and
        // pick the next ID via the same `nextFootnoteIdentifier` rule, so
        // they produce the same auto-numbering sequence. Non-integer
        // existing IDs (e.g. `[^note]`) are ignored.
        const next = nextFootnoteIdentifier(collectFootnoteIdentifiers(editor.state.doc));
        // Single chain so a single Ctrl+Z undoes both insertions atomically.
        // Targeting: insert AFTER any existing `footnoteDefinition` blocks
        // via the shared helper. Without this, each `/footnote` invocation
        // appends at doc end, which leaves PM's auto-trailing-paragraph
        // tucked BETWEEN every pair of consecutive footnote asides —
        // visible as a blank gap in WYSIWYG AND emitted as blank lines in
        // the serialized markdown. The reference is an inline atom
        // (nodeSize = 1), so step 2 shifts the helper's pre-chain anchor
        // by +1.
        const insertAt = findFootnoteDefinitionInsertPos(editor.state.doc) + 1;
        editor
          .chain()
          .focus()
          .insertFootnoteReference(next)
          .insertContentAt(insertAt, {
            type: 'footnoteDefinition',
            attrs: { identifier: next, label: next },
            content: [{ type: 'paragraph' }],
          })
          .run();
      },
      // `'footnote'` is redundant (filterItems matches `name` already);
      // `'note'` collides with Comment, which is defined
      // first so `/note` would land on Comment by default.
      aliases: ['fn', 'ref', '[^'],
      preview: {
        description: t`Insert a footnote reference + matching definition stub.`,
        render: () => (
          <p className="text-sm leading-6">
            <Trans>
              A line with a footnote
              <sup className="footnote-ref">
                <a className="footnote-ref-link" href="#fn-1">
                  [1]
                </a>
              </sup>{' '}
              and a definition shown below.
            </Trans>
          </p>
        ),
      },
    },
    {
      // Inline math goes in the static list (not the descriptor-driven
      // `getComponentItems`) because `mathInline` is a PM atom node, not a
      // registered descriptor — it bypasses the registry to avoid lifting
      // the jsxInline-render-less guarantee.
      //
      // Insert + auto-select + auto-open the inline-math editor popover
      // (the same shape as block descriptors get from focusInsertedComponent
      // in component-items.ts): `setPendingAutoOpen` flags the inserted
      // position; on the next animation frame we set NodeSelection on the
      // atom, which triggers MathInlineView's selected→popover effect and
      // drains the auto-open flag. PopoverContent's `onOpenAutoFocus` then
      // hands focus to the autoFocus-marked `formula` input inside
      // PropPanel.
      name: 'inlineMath',
      label: t`Inline Math`,
      icon: Sigma,
      category: 'insert',
      command: (editor) => {
        const insertPos = editor.state.selection.from;
        editor.chain().focus().insertMathInline('').run();
        setPendingAutoOpen(insertPos);
        requestAnimationFrame(() => {
          editor.commands.setNodeSelection(insertPos);
        });
      },
      aliases: ['math', 'latex', 'equation', 'formula', 'katex', 'inlinemath'],
      preview: {
        description: t`Inline LaTeX math rendered with KaTeX.`,
        // Hand-built KaTeX-shaped sample so the preview render stays
        // synchronous — loading KaTeX here would block the slash menu's
        // first-paint cost on a heavy library that's only needed when an
        // actual math node is on screen.
        render: () => (
          <p className="text-sm leading-7">
            <Trans>
              The formula{' '}
              <span className="rounded bg-muted px-1.5 py-0.5 font-serif italic">
                c = √(a² + b²)
              </span>{' '}
              renders inline.
            </Trans>
          </p>
        ),
      },
    },
  ];
}

/**
 * Filter items by search query. Matches against label, name, and aliases.
 * Used by the slash command extension; exported for reuse by custom menus
 * (e.g., block-editor-ux "+" button).
 */
export function filterItems(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  if (!query) return items;
  const lower = query.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(lower) ||
      item.name.toLowerCase().includes(lower) ||
      item.aliases?.some((a) => a.toLowerCase().includes(lower)),
  );
}
