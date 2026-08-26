# Media — images and attachments

- **Markdown syntax only:** `![alt text](./path/to/image.png)`. Do NOT emit HTML `<img>` tags — they don't participate in OK's content graph and don't render consistently across Fumadocs / preview surfaces. Paths resolve relative to the doc.
- **Always a doc-relative path — never a server URL.** Reference an asset by its path relative to the doc (`./image.png`, `../assets/foo.png`), never an absolute `http://localhost:<port>/…`, `127.0.0.1`, or other server URL. `preview_url`'s `url` navigates the *preview* — it is NOT an asset path; never paste it (or any `localhost` base) into an `![]()`. An asset already in the tree is the same rule: find its path with `exec("ls -A <dir>")` and write the relative link. (Upload via `write({ asset })` hands you the exact relative `![alt](ref)` to copy.)
- **Save locally, don't hot-link.** Hot-linked external image URLs rot when the source disappears. Fetch it through the ingest procedure in `references/ingest-and-sources.md` (SSRF-safe fetch flags, size + executable-extension gates, wrapper frontmatter) — never an ad-hoc `WebFetch` / `curl` into the tree — then reference the local file via a relative markdown link and cite the ingested wrapper below.
- **Placement model.** Free-form image embeds → co-located alongside the referencing doc (sha256 same-directory dedup). Raw sources via `ingest` → `external-sources/<slug>.<ext>` + `external-sources/<slug>.md` (the wrapper-binary pair). Check via `exec("ls -A")` if the project uses a different convention.
- **Cannot fetch** (no network, paywall) → don't invent a local path. Omit, or mark inline `(TODO: image needs sourcing from <URL>)`.
- **Meaningful alt text required** — describes WHAT the image shows, not what it is. `![]()` / `![image]()` / `![filename.png]()` all fail. OK indexes alt text — it's both accessibility AND searchability.
- **Cite web image sources** below the image (Grounding rule):
  ```markdown
  ![Aang using the Avatar State to defeat Ozai](./external-sources/avatar-wiki-aang.png)
  *Source: [Avatar Wiki — Aang](./external-sources/avatar-wiki-aang.md)*
  ```
  (Both paths are relative to the citing doc; ingest lands the binary + wrapper pair side by side, so cite the wrapper next to the binary you embedded.) Original diagrams/screenshots may caption `*Original*` or omit. Cite the local ingested wrapper (whose frontmatter carries the original URL), not the external URL — an inline external link is a TODO meaning "still needs ingesting". Unattributed web images are equivalent to unsourced factual claims.
