---
"@inkeep/open-knowledge": patch
---

MCP tools now declare their schemas as JSON Schema 2020-12, so clients that validate structured output no longer reject the entire tool surface. The MCP SDK converts our tool schemas without specifying a target dialect, which lands on draft-07, and a client validating against the declared dialect refuses to compile the schema and drops the tool before it can run. Because every OpenKnowledge tool declares an output schema, one strict client turned that into a total MCP outage: no reads, writes, or searches succeeded. Only the declared label was wrong, never the schemas themselves, so this is a relabel with no change to what any tool accepts or returns.
