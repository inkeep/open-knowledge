---
"@inkeep/open-knowledge": patch
---

Two markdown fidelity corrections. The editor no longer writes a redundant backslash into stored source when prose contains interior punctuation like `1)x`, `a@x`, `a{x`, `a![x]`, or an unclosed `a![x` — those characters now round-trip as the literal text you typed. And pasting a list item so it holds a nested list as its first block (common when rearranging to-do lists) no longer emits garbled bytes: the item and its nested list now serialize to a form that re-parses to the same structure, instead of leaking a stray `- [ ]` marker into the item text or silently re-indenting the trailing content.
