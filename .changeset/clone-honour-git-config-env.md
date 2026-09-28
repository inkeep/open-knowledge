---
"@inkeep/open-knowledge": patch
---

`ok clone` and `ok share publish` no longer fail just because the environment passes Git settings through the `GIT_CONFIG_COUNT` environment variables, as it can when Claude Code runs them; Git now applies those settings.
