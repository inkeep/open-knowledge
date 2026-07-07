// FIXTURE — drives `no-unportaled-editor-content.test.ts` via shell-out
// to `biome check`. Not part of the main lint (lives outside the lint
// command's path list).
//
// Three positive cases (deliberate violations — plugin must fire) + three
// negative cases (clean usage that must NOT fire). Exact-equality
// (`toBe(3)`) in the test catches both false-negative regressions (drop
// below 3) and false-positive widenings (above 3).

import { EditorContent, PureEditorContent } from '@tiptap/react';
import { createPortal } from 'react-dom';

// biome-ignore lint/correctness/noExplicitAny: fixture-only — production types unimportant here
declare const editor: any;
declare const portalTarget: HTMLElement;

// === Positive cases — must fire ===

// (1) Bare inline <EditorContent /> (self-closing). Not portaled.
export function Positive1() {
  return <EditorContent editor={editor} />;
}

// (2) Bare inline <EditorContent>...</EditorContent> (paired). Not portaled.
export function Positive2() {
  return <EditorContent editor={editor}>{null}</EditorContent>;
}

// (3) <EditorContent /> nested inside another element. Still not portaled.
export function Positive3() {
  return (
    <div className="wrapper">
      <EditorContent editor={editor} />
    </div>
  );
}

// === Negative cases — must NOT fire ===

// (1) Canonical sanctioned createPortal shape — production uses this at
//     TiptapEditor.tsx. Suppressed inline because the JSX literal
//     itself matches the pattern.
export function Negative1() {
  return createPortal(
    // biome-ignore lint/plugin/no-unportaled-editor-content: canonical portaled site — H6 fix per PRECEDENTS.md #44
    <EditorContent editor={editor} className="tiptap-editor-portal-content h-full" />,
    portalTarget,
  );
}

// (2) <PureEditorContent /> — sibling named export from @tiptap/react. Not
//     subject to the vacuum (it's the inner React class TipTap uses for
//     prototype-level instrumentation), and the rule scopes by JSX element
//     name. Must NOT fire.
export function Negative2() {
  return <PureEditorContent editor={editor} />;
}

// (3) Bare import — no JSX element constructed. The rule scopes to JSX
//     elements, not import statements. Must NOT fire on the import line
//     even though `EditorContent` is named there.
//
//     (The import is at the top of this file. Nothing to render here.)
