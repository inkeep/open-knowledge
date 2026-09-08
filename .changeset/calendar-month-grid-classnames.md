---
"@inkeep/open-knowledge": patch
---

The calendar's month grid now receives its intended layout classes. react-day-picker v9 renamed the `table` slot to `month_grid`, so the `w-full border-collapse` this component had been passing under the old key was silently dropped for the whole v9 line. The classes now reach the grid, and they are merged with the library's own defaults rather than replacing them, matching the other slots in the same object.

The class list on the grid gains exactly `w-full border-collapse`. `rdp-month_grid` is not added by this change: v9 merges `classNames` over `getDefaultClassNames()` per key, so a slot keeps its default for any key the object does not override, and `table` was never one of its keys. Both added utilities are no-ops in this layout, so nothing should move visually. Tailwind's preflight already sets `border-collapse: collapse` on every `table`, and the grid is a flex item of the `flex w-full flex-col` month slot, so it already stretched to full width. The class list on the element still changes, which is why this carries a note rather than passing silently.
