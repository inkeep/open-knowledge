import type * as React from 'react';

/**
 * `dir` is deliberately absent: pinning a direction on text the user wrote is
 * exactly the mistake this component exists to prevent, so it is not spellable.
 */
type UserTextProps = Omit<React.ComponentProps<'bdi'>, 'dir'>;

/**
 * Wraps a string the user wrote — a filename, document title, tag, link target,
 * heading — so its writing direction comes from the string itself.
 *
 * The application chrome carries a base direction derived from the interface
 * language, and `dir` inherits. Without this, picking a right-to-left interface
 * language would re-order the user's own Latin filenames, and an Arabic
 * filename would render left-to-right inside an English interface. Neither is
 * ours to decide: OpenKnowledge renders what the user wrote, in the language
 * they wrote it.
 *
 * `<bdi>` is the element for exactly this — it resolves its own direction from
 * its first strong character and isolates that run from the surrounding text,
 * so a folder of mixed-direction names does not adopt whichever name sorted
 * first. Apply it per string, never around a list or a row: one `<bdi>` over a
 * whole container resolves a single direction for everything inside it, which
 * is the bug in a subtler costume.
 *
 * Renders inline, so it substitutes for a `<span>` with no layout consequence.
 */
export function UserText({ children, ...props }: UserTextProps) {
  return <bdi {...props}>{children}</bdi>;
}
