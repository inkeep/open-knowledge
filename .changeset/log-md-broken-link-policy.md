---
"@inkeep/open-knowledge": patch
---

Broken links inside a `log.md` no longer show up as work to do.

A project log is an append-only history. Its entries name pages that have since moved, and pages nobody has written yet, so unresolved links are what a log is supposed to accumulate. Until now every one of them was reported as a broken link to repair: in the Problems panel, as a sidebar tint, as an editor squiggle, in `ok audit`, and in the advisory an agent gets back from every write or edit. That last one is what made this more than noise, because agents are told to read that advisory and fix what it names, and the only way to fix a stale entry in a log is to edit history that was meant to be permanent.

A new project setting, **Ignore broken links in log.md** under **Settings ▸ This project ▸ Preferences ▸ Content rules**, leaves those links out of all of it. It is on by default and shared with the project through `config.yml` as `validation.suppressLogLinkAdvisories`. Turn it off and every finding comes straight back, everywhere, with no restart.

If you gate CI on `ok audit --errors-only` with `validation.links: error`, reserved-log findings no longer contribute to `errorCount` while this default-on setting is enabled. Set `validation.suppressLogLinkAdvisories: false` to keep the previous gate.

The match is deliberately narrow: the stem must be exactly lowercase `log`, with a supported Markdown extension, at any depth. The extension's case is not what decides, so `log.MD` is a reserved log too; `LOG.md` and `catalog.md` are ordinary documents and keep their findings. What decides is the file a link is written in, not the file it points at, so a broken link to a log from anywhere else still reports normally.

Nothing is hidden from the views you use to inspect links on purpose. The Links panel, the editor's unresolved-link styling, `links({ kind: "dead" })`, and `GET /api/dead-links` all show a log's unresolved links in both states.

For agents, filtered results are now explicitly conditional rather than quietly redefined. When the policy withholds findings, audit, write, and edit responses carry `brokenLinkSuppression`, naming the reason `reserved-log-policy` and how many final findings were withheld. On write and edit it sits beside `brokenLinks`. When `brokenLinkSuppression` is absent, `brokenLinks: []` still means what it always did: every outbound link resolves. When the marker is present, treat the empty list as filtered, not confirmed. No href or path comes back, because none of them is repair work, and the bundled project skill and MCP tool descriptions now say exactly that.
