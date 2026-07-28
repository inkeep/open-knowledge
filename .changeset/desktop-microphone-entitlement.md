---
'@inkeep/open-knowledge-desktop': patch
'@inkeep/open-knowledge': patch
---

Fix microphone access for CLI tools run in the OpenKnowledge terminal on macOS.

Any tool that asked for the microphone from a shell launched inside the app
failed silently. No permission dialog appeared, OpenKnowledge never showed up
under System Settings → Privacy & Security → Microphone, and from the tool's
side recording simply captured silence with no error — so there was no way to
grant access and no signal that anything was wrong.

macOS attributes a permission request to the *responsible process* — the
top-level app that started the chain — not to the process that actually asked.
A tool running in the terminal therefore requests the microphone as
OpenKnowledge. Under Hardened Runtime the app must carry
`com.apple.security.device.audio-input` to be eligible to prompt at all; the
app was missing it, so macOS denied every request without ever showing a
dialog. The entitlement is now declared on the main app bundle, matching how
VS Code, Zed, Ghostty, and Cursor ship the same capability.

The consent dialog's text is now declared by the app as well. It previously
fell through to Electron's stock string ("This app needs access to the
microphone"), which described the wrong thing — the app records no audio of
its own. It now reads "A program running in OpenKnowledge's terminal wants to
use the microphone," so the permission being granted is accurate at the moment
it is granted. Granting it covers any tool run in the terminal; macOS shows the
recording indicator whenever the microphone is live, and access stays
revocable in System Settings.

The entitlement is deliberately scoped to the main app bundle and not to
helper processes, and the camera equivalent is not included.
