/**
 * Shared type for the ARIA props that Radix `Slot` forwards from a wrapping
 * `<FormControl>` onto the rendered child. The shadcn `<FormControl>` is a
 * Radix Slot — it merges these three props onto its single child element so
 * that `<FormLabel htmlFor>` / `<FormMessage>` / a11y assistive technology
 * all line up.
 *
 * Used by every "control body" component the Settings pane renders inside a
 * `<FormControl>` slot (`StringControlBody`, `NumberControlBody`,
 * `BooleanControlBody`, `EnumToggleControlBody`, `StringArrayControlBody`,
 * `FieldControlBody`, FoldersSection's `TagsField`). Component props extend
 * this shape via `& SlotForwardedProps`; the body spreads `...slotForwarded`
 * onto the inner DOM element BEFORE its own explicit `ref={ctl.ref}` so the
 * Controller's ref isn't clobbered.
 */
export type SlotForwardedProps = {
  id?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
};
