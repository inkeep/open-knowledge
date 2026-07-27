---
'@inkeep/open-knowledge': patch
---

The macOS uninstall flow now renders as a real part of the app instead of bare system-styled windows. The picker, survey, progress, and confirm/completion/failure screens are a dedicated React surface that loads the same typography, components, and light/dark theme as the editor, so uninstalling looks and behaves like the rest of OpenKnowledge. Screen order and survey timing are unchanged, as is the survey, progress, and notice copy. The picker's copy and selection controls were reworked to fit the new layout: the description now names the project selection, its two Select all / Select none buttons became one tri-state select-all checkbox in the list header, and the footer "N projects selected" count became a selected-of-total fraction beside it (keyboard Cmd/Ctrl+A select-all carries over).
