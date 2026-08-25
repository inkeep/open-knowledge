---
"@inkeep/open-knowledge": patch
---

A component the editor does not recognize swaps itself for a raw-source view as soon as you open the document, and two things were reading that swap as though you had typed it.

The block wrapping such a component now keeps the source you wrote. When a component nested inside another one swapped first, the outer block was marked edited, lost its verbatim source, and was rebuilt from scratch with one newline at its opening and closing tags where you had written a blank line. The server wrote that second spelling over yours, which produces the same duplication and truncation described in the entry about typing in source mode, reached a different way. This covers the case where the wrapping block is itself unrecognized. It does not cover the other shape: when the wrapper IS one the editor recognizes, such as a callout, an accordion or a set of tabs, and only the component inside it is unrecognized, the server still rebuilds that wrapper and the duplication above can still happen to it. That case is tracked separately.

Opening any such document in a preview tab no longer makes the tab permanent. A single click on a file you only wanted to read was treated as a commitment, so the tab stopped being reusable and stayed in the strip.
