---
"@inkeep/open-knowledge": patch
---

OK Desktop can now open a single markdown file without setting up a project. The single-file editing session that `ok <file>` already provides is now reachable from the app itself: **File → Open file… (⇧⌘O)**, the Cmd+K palette, and the Project Navigator, each opening a native `.md`/`.mdx` picker. Loose files also open via Finder's **Open With → OpenKnowledge**. These flows open the file in a temporary session and never write a `.ok` folder into its directory, so previewing one file no longer risks turning its parent folder into a project. A picked file that already lives inside a project opens that project instead.
