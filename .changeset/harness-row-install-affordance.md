---
"@inkeep/open-knowledge": patch
---

Keep the install affordance on an agent row whose tool is gone but whose OpenKnowledge files are not.

A row in Agent connections tracks two independent facts: whether the tool itself is on this machine, and whether OpenKnowledge has written its MCP entry and skill files into that tool's config. When the tool was absent but the files were present, the row collapsed both into a single Remove button. The way back in disappeared, and because an absent row also defaults its toggle off, Remove was the only live control left on it.

Install is now the row's main action whenever the tool is missing and OpenKnowledge has a download link for it (**How to set up** otherwise), and cleanup moves beside the hint as a muted underlined link. The hint says which of the two facts each control is about: `Not installed · OpenKnowledge files present`.

This matters most on a tool with two rows. Cursor has one for the CLI and one for the editor, and they share a single set of files. With the CLI off PATH and the editor installed, the CLI row read `Not installed` and offered only to delete the `.cursor/` config the editor was using.

Where one agent has two rows — a CLI and its editor, sharing one setup — the hint and the cleanup link appear only when the sibling row's tool is confirmed absent — if OpenKnowledge cannot tell, it makes no residue claim. With `cursor-agent` off PATH and the Cursor editor installed, the CLI row now reads a plain `Not installed` and leads with Install; cleanup stays on the editor row, where the files are actually in use.

The outline Remove button now appears only on rows whose tool is present.

Files left in the home of a tool that was never installed are out of scope here; this changes what the row offers, not what put them there.
