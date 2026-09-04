---
"@inkeep/open-knowledge": patch
---

Setting up OpenKnowledge in an existing folder no longer ignores you if you hit Enter or Setup straight away.

The setup dialog checks which AI tools are on your machine so it can offer to wire them into the project. That check runs in the background, and until it finished the Setup button was disabled. A disabled Setup button also means the browser refuses to submit the form when you press Enter, so pressing Enter in the first second or so did nothing at all: no spinner, no error, no project. The dialog just sat there, and the only way to find out you had to try again was to try again.

Detecting your AI tools is an enhancement, not a precondition for setting up a folder, so it no longer gates the button. Setup is live as soon as the dialog is.

A setup you start while the check is still running waits for it and then proceeds, so your tools are wired up just as they would be if you had waited. The wait is bounded from the moment the dialog opens rather than from when you press Setup, so waiting a while and then pressing it costs you nothing extra. If the check has not come back within eight seconds, setup goes ahead and connects nothing rather than leaving you looking at a dialog that will not respond, and the AI tools row stops saying it is still checking so you can wire them up later from Settings. Cancel and Escape stay live the whole time, and Setup shows a spinner while it waits.
