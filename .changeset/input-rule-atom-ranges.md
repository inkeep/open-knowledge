---
"@inkeep/open-knowledge": patch
---

Typing a markdown shortcut around an image, wiki link, tag, inline math, footnote reference, or inline JSX no longer breaks the editor. Closing a shortcut whose text spanned one of these — typing the last `*` of `**see ![img](a.png) here**`, for example — computed a replacement range that was five positions too wide per object, so the keystroke either threw and was lost, or, in a longer paragraph, silently rewrote the wrong span and ate the text in front of it. Inline JSX was skewed by an amount that grew with its own length, so a short one could work and a realistic one could not. Every inline object now reports its width to the shortcut matcher as the single position it actually occupies, which fixes the range for every shortcut rather than any one of them.
