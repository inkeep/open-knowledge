---
"@inkeep/open-knowledge": minor
---

External link hover previews are now on by default. Previously they shipped off by default (opt-in). Hovering an external link in the editor now shows a preview card — site name, page title, description, favicon — fetched by your local server, which sends that link's URL to the destination site (one request per previewed link). Turn it off per machine in Settings → Link previews, which sets `linkPreviews.enabled: false` in project-local config. Unchanged: the SSRF guard still refuses to fetch private or internal hosts, no cookies or credentials are attached, results are cached locally, and any fetch failure falls back silently to the plain URL pill. Internal document-to-document previews were already always on and read entirely from the local index with no network request. Note: external previews are not yet available in the packaged desktop app; this default applies to the browser and `ok ui` surfaces.
