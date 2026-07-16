---
"@inkeep/open-knowledge": minor
---

Report a bug can now include a screenshot of the app. When you open the Report a bug dialog, OpenKnowledge captures the app exactly as it looked underneath the dialog and shows you a preview inside the compose step. The screenshot is included by default; uncheck it to leave it out. Because the preview shows precisely what will be attached, you can confirm the picture before sending it: a screenshot is an image of your screen and is not redacted the way logs are, so review it and uncheck it if anything on screen shouldn't be shared. When kept, the screenshot rides inside the report bundle at `extra/screenshot.png`, and like the rest of the bundle it never leaves your machine until you send the report.
