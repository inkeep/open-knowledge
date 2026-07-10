---
"@inkeep/open-knowledge": patch
---

Fix the `write` and `edit` MCP tools failing with a schema-conversion error on constrained-decoding hosts like LM Studio (`Error resolving ref #/definitions/__schema0`). Their `frontmatter` field advertised a recursive JSON Schema (`$ref: "#/definitions/__schema0"`); LM Studio — and some function-calling APIs like Gemini — can't resolve an intra-schema `$ref` in a tool definition and reject the whole tool. Claude and most MCP clients resolve it leniently, so this only surfaced on local-inference hosts.

The `frontmatter` value now advertises a flat, `$ref`-free JSON Schema (scalar | array | object | null), while a runtime refinement re-applies the exact recursive validation — so accepted/rejected inputs are unchanged for every client and every write path (nested `null` is still rejected, deep nesting and heterogeneous arrays still accepted). Added a test that compiles every tool's input and output schema and fails if any emits a `$ref`, so this can't silently regress.
