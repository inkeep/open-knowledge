// FIXTURE — drives `no-unwrapped-user-facing-string.test.ts` via shell-out to
// `biome check`. Not part of the main lint (lives outside the lint command's
// path list).
//
// Positive cases (deliberate violations — plugin must fire) paired with
// negative cases (already-wrapped copy, and the non-prose token shapes this
// codebase legitimately writes raw). Exact-equality `toBe(N)` in the test
// catches both a weakened pattern (count drops) and a widened one (a negative
// starts firing, count rises).

// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const toast: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const t: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const Trans: any;
// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const MenubarShortcut: any;

// === Positive cases — must fire ===

// (1) A bare string literal reaching a toast is user-facing copy. Single-word
//     copy fires here too: a toast argument is unambiguously user-facing, so
//     the prose heuristic the JSX branches need would only weaken this one.
export function Positive1() {
  toast.error('Could not construct share URL');
  toast.success('Saved');
}

// (2) Prose as a JSX text child.
export function Positive2() {
  return <span>No documents match your search</span>;
}

// (3) Prose as a JSX text child of a nested element — the text node, not the
//     element, is what the rule spans.
export function Positive3() {
  return (
    <div className="banner">
      <p>Couldn&apos;t load conflicts. Reload to retry.</p>
    </div>
  );
}

// (4) Copy carried by an accessibility or hint attribute. A screen-reader name
//     is user-facing even though it never renders as text.
export function Positive4() {
  return (
    <div>
      <div aria-label="Close the dialog" />
      <input placeholder="Search your documents" />
      <img alt="A diagram of the sync flow" src="/x.png" />
      <div title="Open in a new window" />
    </div>
  );
}

// (5) The same copy in object position. A menu item's `label`, a picker
//     entry's `title`, a preview panel's `description`, an image's `alt`,
//     and a quoted `'aria-label'` key all render the words the attribute
//     forms render.
export function Positive5() {
  return [
    { label: 'Delete table', icon: null },
    { title: 'Heads up' },
    { description: 'Link to a page or external URL' },
    { alt: 'Sample image' },
    { placeholder: 'Search your documents' },
    { 'aria-label': 'Close the dialog' },
  ];
}

// (6) Nested one level down — the rule spans the value wherever the object
//     sits, not just at the top of a literal.
export function Positive6() {
  return { preview: { description: 'Notion-style inline row for a file' } };
}

// === Negative cases — must NOT fire ===

// (1) The canonical wrapped forms: `<Trans>` children and the `t` macro.
export function Negative1() {
  return (
    <div>
      <Trans>Inside a Trans element</Trans>
      <span>{t`A wrapped macro string`}</span>
    </div>
  );
}

// (2) `<Trans>` text nested below intervening markup. Proves the exclusion
//     walks ancestors rather than matching only a direct child.
export function Negative2() {
  return (
    <Trans>
      A multi line body <strong>with nested markup</strong> and more words
    </Trans>
  );
}

// (3) Keyboard-shortcut tokens, code identifiers, file paths and brand marks.
//     None is prose: the rule requires two letter-words separated by
//     whitespace, so a single token — or tokens joined by punctuation — is not
//     a candidate. This is the shape the codebase's raw JSX text actually has.
export function Negative3() {
  return (
    <div>
      <MenubarShortcut>Ctrl+Shift+N</MenubarShortcut>
      <code>open-knowledge</code>
      <span>notes / release-plan.md</span>
      <h1>OpenKnowledge</h1>
    </div>
  );
}

// (4) Brand proper nouns naming an icon. `<Brand> icon` is the accessible name
//     of a third-party mark; translating it would rename the product.
export function Negative4() {
  return (
    <svg role="img">
      <title>Claude icon</title>
      <title>GitHub Copilot icon</title>
    </svg>
  );
}

// (5) A toast whose argument is already wrapped, and one whose argument is a
//     variable — neither is a literal the rule can judge.
export function Negative5(message: string) {
  toast.error(t`A wrapped toast`);
  toast.error(message);
}

// (6) A wrapped attribute, and the format-token placeholders that show an input
//     shape rather than address the reader. Those are example values — a
//     translated `my-knowledge-base` would stop being a valid example — and
//     they are single tokens, so the same prose test that gates JSX text
//     excludes them without a bespoke carve-out.
export function Negative6() {
  return (
    <div>
      <div aria-label={t`Close the dialog`} />
      <input placeholder="my-knowledge-base" />
      <input placeholder="ghp_" />
      <input placeholder="references/notes.md" />
      <span title="markdownlint" />
      <div aria-label="Claude icon" />
    </div>
  );
}

// (7) Object properties whose value is already a macro, and the token shapes
//     the same prose test excludes in attribute position. `Save` is one word,
//     `Heading 1` has no letter–space–letter run, and `Claude icon` is a
//     third-party mark.
export function Negative7() {
  return [
    { label: t`Delete table` },
    { title: t`Heads up` },
    { label: 'Save', title: 'Heading 1' },
    { alt: 'Claude icon', description: 'markdownlint' },
    { placeholder: 'my-knowledge-base', title: 'notes / release-plan.md' },
  ];
}

// (8) Property names the rule deliberately does not scope. `className` and
//     `data-testid` carry no copy, and widening to every string-valued
//     property is the false-positive rate the name scope exists to bound.
export function Negative8() {
  return { className: 'flex items-center gap-2', 'data-testid': 'delete target row' };
}

// (9) TypeScript member positions. A string-literal union in a `type` or
//     `interface` declares a value domain, not copy — the pattern binds to
//     object-literal pairs, so these are structurally out of reach rather
//     than filtered out.
export type NegativeAlign = { label: 'left side' | 'right side' };
export interface NegativeShape {
  title: 'a fixed title';
}
