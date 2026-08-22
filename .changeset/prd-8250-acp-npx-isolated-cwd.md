---
"@inkeep/open-knowledge": patch
---

Fixed a Claude ACP failed-to-start with `npm error Override without name: @modelcontextprotocol/sdk>zod`. When the project you opened lives inside a monorepo whose root `package.json` uses pnpm's flat `parent>child` override syntax, npm's arborist would walk up from the agent's cwd, hit that file, and reject the flat key before the agent could initialize. `npx`-kind ACP spawns now run from an OK-owned dir under ~/.ok/ so arborist doesn't discover the ancestor workspace; the agent still receives its actual workspace over the ACP session handshake.
