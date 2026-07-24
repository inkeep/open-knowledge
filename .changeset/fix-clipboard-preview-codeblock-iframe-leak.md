---
"@inkeep/open-knowledge": patch
---

Fix copying a rendered `html preview` code block pasting broken markup into other apps. Selecting and copying a preview-active code block previously placed the preview's internal sandboxed iframe (several KB of security-policy, theme, and bootstrap markup) plus resize-handle chrome into the clipboard, so pasting into Gmail, Notion, Slack, or Docs produced bloated, non-rendering junk. The clipboard now receives the clean fenced code source instead, matching how rendered math and Mermaid diagrams already copy.
