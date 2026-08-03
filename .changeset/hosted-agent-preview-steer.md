---
"@inkeep/open-knowledge": patch
---

Agents in the in-app agent panel no longer answer with a `localhost` preview link to the app you are already looking at. After creating or editing a doc, an agent would sometimes end its reply with a bare `http://localhost:<port>/#/...` URL instead of just bringing the doc up on screen. The steer that prevents this already existed, but it only recognized agents running in the desktop app's built-in terminal, so the agent panel never received it and fell back to handing over a raw URL. Every way a panel agent reaches OpenKnowledge now carries the same signal, and the guidance is explicit that the URL should not be pasted into a reply when you are already in the app. Agents outside the app are unaffected and still get a URL they can open.
