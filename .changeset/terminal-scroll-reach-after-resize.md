---
"@inkeep/open-knowledge": patch
---

Scrolling back through terminal history no longer dead-ends after the panel changes size. Moving the terminal between its bottom dock and the right column while scrolled up left the view unable to go any further up, by wheel or by keyboard, and it stayed that way, because the resize left the scrollbar and the rows pointing at different lines. The lines above were never lost, but the only way back to them was scrolling all the way down and starting again. The panel now puts the two back in agreement whenever the grid resizes under a scrolled-back view.

Resizing the terminal still moves your place in the history: it keeps the most recent visible line on screen, so a tall panel becoming a short one leaves you further down the buffer than you were. That part is unchanged.

One thing is new, and it is the trade this makes: if the terminal resizes while a scroll of yours is still gliding to a stop, that glide now stops where it is instead of finishing. Reaching the history again is worth more than the last few lines of momentum, but it is a change you can notice.
