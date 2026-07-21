---
"@inkeep/open-knowledge": patch
---

Fixed the empty-state "Create" composer so pressing Enter launches whatever the Create button shows. Previously, when the composer was set to start an in-app agent ("Start an agent" / a registered agent), pressing Enter fell through to a different action instead of launching that agent — only a mouse click on the button worked. Enter now performs the same action as the button in every mode (in-app agent, terminal CLI, or desktop app agent), so the keyboard and pointer paths never diverge. Desktop builds also gain an opt-in `OK_FORCE_A11Y=1` launch flag that exposes the full web UI to the macOS accessibility tree, for VoiceOver and GUI-automation tooling.
