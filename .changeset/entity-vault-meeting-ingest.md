---
"@inkeep/open-knowledge": patch
---

The `entity-vault` starter pack skill now covers ingesting meetings from a recorder. When a meeting-recorder MCP (Granola, Fireflies, Circleback, tl;dv, Fathom) is registered alongside `open-knowledge`, the agent pulls recent meetings and writes each one into `meetings/`, addressed as `meetings/<source>-<source_meeting_id>` so re-syncing a meeting updates it in place instead of creating a duplicate. Meeting notes ingested this way carry `source:` and `source_meeting_id:` frontmatter, which is the dedup key. Transcripts stay verbatim, and the recorder is bring-your-own, so the same behavior works on demand or driven by a scheduler. The pack's `meeting` template now carries the `source` and `source_meeting_id` keys and a `## Transcript` section, so a meeting you author by hand and one pulled from a recorder share the same shape.
