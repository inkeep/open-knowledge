---
"@inkeep/open-knowledge": patch
---

Fixed an error thrown inside every CodeMirror-backed editor when selecting with the mouse. Double-clicking to select a word and triple-clicking to select a line both threw, and so did the handler that starts a drag from a widget. Selecting still looked like it worked, because the browser's own selection took over once the editor's handler failed. That covers source mode, plain-text documents, the Mermaid editor, the text viewer, the raw MDX fallback, and the smaller code inputs in the property panel and preview dialogs. A dependency pin held `@codemirror/state` at a version older than the editor required, so the API those selection paths call was missing at runtime.
