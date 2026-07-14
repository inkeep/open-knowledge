---
"@inkeep/open-knowledge": patch
---

Remember each project's window position across opens and relaunches. Reopening a project now restores its editor window to the exact frame it last had — same display, same position, same size, including maximized / full-screen state — instead of the cascade default; cascade remains the fallback for projects with no memory or whose remembered display is no longer connected. The desktop also tracks which project window was most recently focused: a post-update relaunch reopens every window at its old position and brings the window you were actually working in back to the front, and a normal cold start reopens the project you were last in rather than the one you happened to open last. Focus tracking freezes the moment shutdown begins, so the window-close cascade during quit or update install can't mislabel "last active" with whichever window closed last.
