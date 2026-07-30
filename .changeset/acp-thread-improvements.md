---
"@inkeep/open-knowledge": patch
---

In-app agent (ACP) threads: four improvements.

- **Numbered lists in agent replies no longer render off-screen.** Ordered- and unordered-list markers were being clipped off the left edge of the narrow thread panel; lists now get inline-start padding so their markers stay on screen.
- **Agent settings persist per agent type.** Picking a model, reasoning effort, or agent mode in a thread is remembered for that agent, and the next thread you start with the same agent opens on those settings — applied before the first turn (model first, so dependent options like thought level re-validate).
- **A mode that lets the agent act without asking is marked.** Because modes carry across threads, a permissive one — Claude's Bypass Permissions and Accept Edits, Codex's Agent (full access), Gemini's YOLO and Auto Edit, goose's Auto — puts a small amber dot on the settings button, with a hover tooltip spelling out what it allows. (Cursor exposes no permissive mode over ACP, and goose's Smart Approve still prompts for risky steps, so neither is flagged.) The marking follows whichever mode is actually in force, whether you just picked it or it carried over from your last thread. It's a recognition heuristic over the mode's name, so it's a hint, not a guarantee — it never blocks or changes a mode.
- **Thread transcripts are stored globally in `~/.ok/threads/`** (alongside the existing `~/.ok/acp-agents` and `~/.ok/runtimes`) instead of per-project, so they survive project-folder moves. Each project still sees only its own threads (matched by working directory). Threads created before this change are read back from their old per-project location — nothing to migrate. Per-project tool-permission grants are unchanged.
