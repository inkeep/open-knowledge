---
"@inkeep/open-knowledge": patch
---

A frozen table header no longer drops out of its pinned position for one frame when its freeze range is recomputed. The header cell's pin is driven by scroll-driven Web Animations, and the extension replaces those animations whenever the freeze key changes. A replacement was play-pending on the frame it was created: `currentTime` was `null`, its effect was not in effect, and nothing else set the cell's transform, so the computed transform was `none` for that frame and the header could fall as much as roughly 700 px before snapping back.

Each replacement now has its start time assigned when it is created, which resolves its pending play task, so it is in effect on the frame it replaces its predecessor and the header keeps the mapped position throughout. A browser that rejects the assignment keeps the previous behaviour rather than losing the freeze.
