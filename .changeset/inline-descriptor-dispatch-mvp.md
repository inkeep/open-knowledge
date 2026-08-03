---
'@inkeep/open-knowledge-core': minor
'@inkeep/open-knowledge-app': minor
---

Inline JSX components now render as real widgets. Write `<Callout type="warning" title="heads up" />` in the middle of a sentence and it renders live instead of showing source text — click it to edit its properties in a popover, and the markdown on disk updates cleanly. Paired bodies (`<Callout>text</Callout>`) render too, and unregistered component names keep showing as plain source.
