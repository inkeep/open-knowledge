---
"@inkeep/open-knowledge": patch
---

Pasting bullet lists from rich-text sources no longer inserts blank lines before nested sections

Copying a tight bullet list from a rendered surface (Google Docs, Notion, Slack, ChatGPT, a web page) and pasting it into the editor used to synthesize blank lines between every item and before each nested sub-list, and swapped the bullet markers to `*`. The HTML-to-markdown conversion now normalizes the rich-editor DOM shape (paragraph-wrapped list items, nested sub-lists) back to a tight list, and mints the editor's canonical `-` bullet marker. List items that genuinely contain multiple blocks (two paragraphs, a paragraph plus a code block) still paste as loose lists so their blocks stay separate.
