---
"@inkeep/open-knowledge": patch
---

OKF provenance timestamps are now read as ISO 8601 datetimes carrying an explicit UTC offset, which is what OKF v0.2 §5 asks for. This changes the `okf` lint plugin in both directions, and one of the two is a tightening.

- **Documents that already follow OKF v0.2 stop warning.** `stale_after`, `usage_window.from`, `usage_window.to`, and each `sources[]` entry's `last_modified` plus its own window bounds previously accepted only a bare `YYYY-MM-DD` calendar date, so a conformant value such as `2026-09-23T00:00:00Z` was reported as a `frontmatter-provenance` warning. It no longer is.
- **Documents still written with date-only values start warning.** A value such as `stale_after: 2026-09-23` now reports one `frontmatter-provenance` warning, because the format now asks for an explicit offset. The remedy is to write it: `stale_after: 2026-09-23T00:00:00Z`. A datetime carrying no offset (`2026-09-23T00:00:00`) is rejected for the same reason, and the warning now names the shape to write rather than only the schema keyword.

**Why now.** OKF revised §5 in place on 2026-08-21, adding "Every timestamp-valued key in OKF is an ISO 8601 datetime with an explicit UTC offset" and migrating every example in the spec, without bumping the version. Both revisions are labeled v0.2 and a document written to either declares `okf_version: "0.2"`, so the declared version does not tell you which reading a document was authored against. The plugin now records the upstream commit its reading is pinned to.

**Other v0.2 checkers have not caught up yet.** `okf-conformance` still warns on a `stale_after` that is not a bare `YYYY-MM-DD`, which is the pre-revision wording of §5.5, so the two tools currently disagree about the same document. OpenKnowledge follows the current spec text and the format's own reference bundles, which now write `stale_after: 2026-12-31T00:00:00Z`.

Log files are unaffected. OKF §9 governs the date's form in a `log.md` entry heading, not these frontmatter keys, and `log-shape` is unchanged: `## 2026-06-30` and `## 2026-06-30: Shipped v2` both stay conformant.

The `okf` plugin ships disabled by default, so this reaches only projects that turned it on, and it emits advisory warnings rather than blocking anything.
