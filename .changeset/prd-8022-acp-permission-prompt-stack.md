---
"@inkeep/open-knowledge": patch
---

ACP permission prompts with three or more options now stack vertically as full-width buttons — primary Allow up top, escalating grants and refusals below — instead of hiding the extras behind an overflow chevron. Prompts with one or two options keep the classic Deny-left / Allow-right row. Fixes the case where a 2-allow / 0-reject shape would silently drop its escalating grant, and always renders a refusal control (even when the agent offers none).
