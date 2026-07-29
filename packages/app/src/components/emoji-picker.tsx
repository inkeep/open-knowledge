// biome-ignore-all lint/plugin/no-raw-html-interactive-element: frimousse's `EmojiPicker.List` overrides spread the library's own props (active-state data attrs, virtualised-grid wiring) onto a plain element; shadcn Button's variant styling would fight the picker grid. Moved verbatim from PageHeaderWidgets.tsx, which carries the same file-level posture.

/**
 * Frimousse-backed emoji picker, themed to match OK's shadcn surface
 * (popover bg, accent on hover, ring on focus). Shared by the page-icon
 * frontmatter widget and the slash-menu Emoji insertion popover — one
 * themed surface so the two pickers can't drift apart visually.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { EmojiPicker, type EmojiPickerListComponents } from 'frimousse';

/**
 * Themed component overrides for `EmojiPicker.List` — extracted to a
 * module-level constant so React Compiler can hoist the object literal
 * once (the picker re-renders on every keystroke; an inline object
 * would create a new identity each pass and force the virtualised
 * list to remount its rows).
 */
const EMOJI_LIST_COMPONENTS: EmojiPickerListComponents = {
  CategoryHeader: ({ category, ...props }) => (
    <div
      {...props}
      className="bg-popover px-3 pt-3 pb-1.5 font-medium text-muted-foreground text-xs"
    >
      {category.label}
    </div>
  ),
  Row: ({ children, ...props }) => (
    <div {...props} className="scroll-my-1.5 px-1.5">
      {children}
    </div>
  ),
  Emoji: ({ emoji, ...props }) => (
    <button
      type="button"
      {...props}
      className="flex size-8 items-center justify-center rounded-md text-lg data-[active]:bg-accent"
    >
      {emoji.emoji}
    </button>
  ),
};

/**
 * Compact (320px) picker constrained vertically so it fits inside a
 * popover without scrolling the page. The `onSelect` callback fires
 * with the rendered emoji string (multi-codepoint sequences already
 * joined by `frimousse`).
 */
export function FrimousseEmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { t } = useLingui();
  return (
    <EmojiPicker.Root
      className="isolate flex h-[326px] w-[320px] flex-col bg-popover text-popover-foreground"
      onEmojiSelect={({ emoji }) => onSelect(emoji)}
    >
      <EmojiPicker.Search
        className="z-10 mx-2 mt-2 rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={t`Search emoji`}
        autoFocus
      />
      <EmojiPicker.Viewport className="relative flex-1 overscroll-contain outline-none">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
          <Trans>Loading</Trans>
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
          <Trans>No emoji found.</Trans>
        </EmojiPicker.Empty>
        <EmojiPicker.List className="select-none pb-1.5" components={EMOJI_LIST_COMPONENTS} />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}
