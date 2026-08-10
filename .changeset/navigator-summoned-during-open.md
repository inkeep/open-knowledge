---
"@inkeep/open-knowledge": patch
---

Opening the Project Navigator while a project is still opening no longer makes it flash and vanish. Opening a project is slow — it starts a server, waits for it, then waits out the window's load — and the Navigator is reachable that whole time from the File menu and its shortcut. When the project window finally finished, it closed whichever Navigator was up by then, including one summoned in the meantime, destroying it mid-load. Launching straight into your last project and reaching for the launcher before that project finished was enough to hit it, and the bigger the project the wider the window. A project open now retires only the Navigator it actually took over from; one you summon while it is still working stays open.
