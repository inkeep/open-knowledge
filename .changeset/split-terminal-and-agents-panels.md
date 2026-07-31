---
"@inkeep/open-knowledge": minor
---

The terminal and agent conversations are now two separate panels instead of one shared dock. The terminal owns the bottom of the editor and still opens with ⌘J; agent conversations own the right panel and open with ⌘L. Both can be open at once, each keeps its own size, tabs, and reload state, and closing one leaves the other alone — so you no longer have to give up your terminal to see an agent. The dock-position toggle is gone with the split; a terminal that used to sit in the right panel moves to the bottom on first launch, and the right panel keeps the width you had set.

A new tab in the terminal panel opens a plain shell by default — you no longer get dropped into a CLI you never chose. The New button's dropdown still lists every terminal CLI, though, so you can start a tab directly in one; that choice sticks, and the ＋ button, ⌘J, and ⇧⌘J repeat it until you pick Terminal again. The agents panel's New button remains dedicated to in-app agents. Sending a passage to AI — from the selection bubble, a code block's Ask action, or ⌘J with selected text — still uses your preferred AI and reveals the panel where it runs.

The agents panel now keeps a small tab on the right edge whenever it is closed, so a conversation is always one click away even if you have never opened the panel. The terminal no longer has an edge tab of its own — ⌘J and the View menu open it — which clears the bottom-right corner it used to share with the Ask AI composer.

The bottom Ask AI composer moves from ⌘L to ⇧⌘L (Ctrl+Shift+L on Windows and Linux), and now hides whenever either panel is open — both are already places to type a request, so it stepped aside rather than offering a third.
