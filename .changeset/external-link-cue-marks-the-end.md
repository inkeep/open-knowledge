---
"@inkeep/open-knowledge": patch
---

An external link now shows its leaves-the-workspace arrow once, at its end, even while somebody else's caret sits inside it. A peer standing in the middle of a URL used to break the link into pieces on screen and give every piece its own arrow — `http://www. ↗google.com ↗` — until a switch to Markdown source and back cleared them. Two links in the same paragraph still get an arrow each.
