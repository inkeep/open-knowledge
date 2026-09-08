---
"@inkeep/open-knowledge": patch
---

The discovery-skill checkbox in Settings → Agent connections works, instead of sending you to Skills Studio forever.

Two things were wrong. The row read the wrong directory: it looked for the project bundle (`open-knowledge`) inside the user-global skills root, where the discovery bundle (`open-knowledge-discovery`) actually lives. So a discovery skill you had already installed read as missing no matter how many times you installed it, and the row kept offering to add it. And the box it offered could not be saved: the user-global rows had no per-agent writer, so every Save came back failed with an error pointing at Skills Studio, which lists a different set of agents and could not always honour the request either.

Each agent's row now installs and removes its own copy, in its own skills folder, leaving every other agent's alone. Both directions decline when two agents' skills folders resolve to the same directory, naming what shares it — installing through the alias would have made the other agent's row read as set up off a write you never asked for, and you could not have undone it from the same screen.

Turning a row on also records that you want the skill, so a machine-wide decline made during onboarding no longer removes it again at the next launch; turning off the last agent that had it records that too, so it does not come back everywhere.

A row is only offered for an agent whose folder is already on your machine — the option reads as unavailable rather than sitting checked and failing on save — which is the same rule Skills Studio uses, so the two screens agree about which agents can take a machine-wide skill. Creating the folder would have meant more than the one box you ticked: OpenKnowledge treats the presence of that folder as proof the tool is installed, so the next launch would have seeded your other enabled skills into it too.
