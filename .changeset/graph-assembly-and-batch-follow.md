---
"@inkeep/open-knowledge": patch
---

The docked Graph tab assembles live while an agent builds a knowledge base: when pages land in a burst with the graph open, the whole project graph frames itself and grows in — new pages scale and fade in with a brief halo, new edges fade in, and nodes are colored by their `cluster:` frontmatter. Follow mode also now understands batch writes (`documents: [...]`), which previously produced no navigation at all — the editor sat still through entire builds; it now follows the agent to the most recent page in each batch. The graph's view choreography is entirely signal-driven, so the `graph_view` MCP tool is retired (one less tool in every agent's context) along with its view-command plumbing; the knowledge-base pack skill sheds its view-choreography instructions in favor of plain authoring guidance: link every page at creation and give related pages a shared cluster.
