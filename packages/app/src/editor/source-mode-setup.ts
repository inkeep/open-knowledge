/**
 * CodeMirror extension bundle for the collaborative source editor.
 *
 * This is `codemirror`'s `basicSetup` with CodeMirror's own undo history
 * (`history()` + `historyKeymap`) deliberately omitted. The source editor binds
 * to a shared `Y.Text` via `y-codemirror.next`, whose `Y.UndoManager` tracks
 * only the local sync origin — remote peers and agent writes arrive under other
 * origins and are excluded. CodeMirror's native history is origin-blind: it
 * captures the transactions `y-codemirror` dispatches to reflect remote/agent
 * changes into the buffer, so a native undo can revert content the user never
 * wrote. The source editor therefore runs a single undo authority — the
 * origin-aware `Y.UndoManager`, driven by `yUndoManagerKeymap` at the call site.
 *
 * Everything else mirrors `basicSetup` verbatim; keep this in sync with the
 * `codemirror` package's `basicSetup` when that dependency is bumped.
 */

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';

export const sourceModeSetup: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];
