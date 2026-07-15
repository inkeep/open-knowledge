---
"@inkeep/open-knowledge": minor
---

Hovering a link in the editor now shows a preview card. Links to other documents in the project get a doc card — title, folder path, tags, last-edited time, backlink count, and a short excerpt — built entirely from the local index and file contents: on by default, no configuration, and nothing leaves the machine. This is a hover-behavior change for existing users: resolved internal links previously showed only the URL pill, which is still there with all its actions — the card renders alongside it.

External links get an opt-in preview card showing the destination's site name, page title, description, and favicon. It is off by default and per machine: enable it from **Settings → This project → Link previews**, which sets `linkPreviews.enabled` in project-local config (never shared with collaborators). When enabled, hovering an external link sends that link's URL to the destination site to fetch preview metadata — one request per previewed link, with no cookies or credentials attached. The opt-in is enforced by the local server (with it off, no external request is made), results are cached locally, requests to private or internal addresses are refused, and any preview that can't be fetched quietly falls back to the plain URL pill.
