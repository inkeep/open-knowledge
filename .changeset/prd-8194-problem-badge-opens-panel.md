---
"@inkeep/open-knowledge": patch
---

The problem count on a file-explorer row is now a control instead of a label. Clicking it, or focusing it and pressing Enter or Space, opens that file and shows the Problems panel listing its problems, expanding the right rail if it was collapsed and switching a panel left in project scope back to the clicked file. Keyboard activation moves focus into the panel, while pointer activation preserves pointer focus. The badge already told you to open the Problems panel for details, and now it takes you there rather than leaving you to find the tab yourself. Tabbing through the file explorer now stops on the count of each row that has problems, which is how the badge becomes reachable without a pointer. It keeps the accessible name and tooltip it always had, and a click carrying cmd, ctrl, shift, or alt still belongs to the tree, so multi-select on a badged row is unchanged.
