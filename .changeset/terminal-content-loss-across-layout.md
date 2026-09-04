---
"@inkeep/open-knowledge": patch
---

Terminal content no longer disappears when the terminal changes shape around it.

Switching to another terminal tab, reordering tabs, or moving the terminal between the bottom dock and the right column could wipe what was on screen. On Windows the symptom was stark: a command you had just run, and its output, would be replaced by a repeated shell prompt, or older scrollback would vanish while the newest lines survived.

The terminal sizes its grid to fit the box it is drawn in. Hiding a tab, or reparenting the panel mid-move, leaves that box with no size for a moment, and the sizing pass had no way to tell "this box is zero because nothing is drawn right now" from "this box is genuinely tiny". It read a missing size as a real one and fitted the terminal to a grid roughly eleven columns by five rows, then handed that grid to the shell. On Windows the shell owns its screen buffer and repaints it on every resize, so collapsing to a sliver and back destroyed the content in between.

The terminal now sizes itself only from a box that is actually being drawn, and only the sizing pass that measured that box tells the shell about it. A resize that arrives while the terminal is hidden or mid-move is ignored, and the real size is picked up as soon as it is on screen again, so tab switches, reorders, and moves leave the buffer and the running shell untouched.

The same rule covers the terminals that come back when you reload the window. They are restored all at once, but only the tab you are looking at has a size yet, so the ones still waiting their turn are no longer told a size that was never measured. Each is told its real size when it is shown.
