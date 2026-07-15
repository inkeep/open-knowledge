---
"@inkeep/open-knowledge": patch
---

Fix "Report a Bug" in the packaged desktop app. Send now attempts to upload your
report to the OpenKnowledge team, instead of always opening the "send it by
email" draft. The packaged app shipped with no bug-report intake configured, so
every Send skipped the upload and fell straight through to email. It now targets
the production intake by default (`OK_BUG_REPORT_INTAKE_URL` still overrides, and
unpackaged dev builds are unchanged so a dev run never uploads by accident). If
the upload cannot be completed, Send still offers the same email draft, so no
report is lost.
