---
"@inkeep/open-knowledge": minor
---

New `ok audit [path]` CLI command — the unified validation audit (markdownlint problems and broken internal links in one source-tagged, per-file report) is now available from the terminal, completing surface parity with the `audit` MCP tool and `GET /api/audit`. It delegates to the running project server (the links validator needs the live backlink index), scopes to a folder or single file via the optional path argument, and exits non-zero when problems are found for CI use. `--json` emits the full uncapped diagnostic plane; `--errors-only` restricts the failing exit to error-severity findings. `ok lint` is unchanged and remains the headless, lint-only alternative that needs no server.
