---
"@inkeep/open-knowledge": patch
---

Signing in to an agent now reads as a sign-in rather than an error. When a thread is waiting on authentication, the agent's mark and name take the pane with the ways in stacked beneath, one leading and the rest as alternatives, instead of an amber alert card with a row of equally loud buttons.

Device-code flows now show their code. An agent signing in has no session yet, so the code and confirmation URL it prints are the only place that information exists, and OK was discarding them; the browser would ask the user to confirm a code their device never displayed. The code now appears while the sign-in runs, one tap to copy, with the confirmation page linked below it.

A sign-in in flight has a status of its own. It used to report `installing`, so clicking a method replaced the prompt with "Starting the agent" while the agent was in fact waiting on the user, and the sign-in options vanished mid-flow.

A completed sign-in the running agent cannot see now relaunches the agent instead of asking again. An agent that reads its credentials at startup will still refuse a session even after `authenticate` succeeds, and the fix has always been to restart it, which is what Retry did. OK now takes that step itself.

Startup failures no longer pile up on a working thread. Each failed attempt left a card behind, so a thread that eventually signed in opened on a stack of warnings about a sign-in the user had already completed. A launch that succeeds retires the failures it took to get there; failures inside a live session still stand.
