---
"@inkeep/open-knowledge": patch
---

Typing or pasting a literal whitespace character reference such as `&#x20;` (space), `&#x9;` (tab), or `&#xA0;` (non-breaking space) into the editor no longer silently turns it into the actual whitespace character. Previously these typed characters were stored unescaped, so on the next reopen or sync every reader saw an invisible space instead of the text you typed. They now survive edit, save, and reopen exactly as written. Spaces the editor itself preserves at bold/italic boundaries are unaffected, and existing files on disk keep their exact bytes.
