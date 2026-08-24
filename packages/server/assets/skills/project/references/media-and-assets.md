# Media — images and attachments

- **Markdown syntax only:** `![alt text](./path/to/image.png)`. Do NOT emit HTML `<img>` tags — they don't participate in OK's content graph and don't render consistently across Fumadocs / preview surfaces. Paths resolve relative to the doc.
- **Always a doc-relative path — never a server URL.** Reference an asset by its path relative to the doc (`./image.png`, `../assets/foo.png`), never an absolute `http://localhost:<port>/…`, `127.0.0.1`, or other server URL. `preview_url`'s `url` navigates the *preview* — it is NOT an asset path; never paste it (or any `localhost` base) into an `![]()`. An asset already in the tree is the same rule: find its path with `exec("ls -A <dir>")` and write the relative link. (Upload via `write({ asset })` hands you the exact relative `![alt](ref)` to copy.)
- **Save locally, don't hot-link.** Hot-linked external image URLs rot when the source disappears. For every fetched external asset (especially untrusted or user-provided URLs), run the approved ingest procedure in [`ingest-and-sources.md`](ingest-and-sources.md) — do not fetch bytes straight into the tree with `WebFetch` / `curl` ad hoc. Save locally, reference via relative markdown link, cite the ingested source below.
- **Placement model.** Free-form image embeds → co-located alongside the referencing doc (sha256 same-directory dedup). Raw sources via `ingest` → `external-sources/<slug>.<ext>` + `external-sources/<slug>.md` (the wrapper-binary pair). Check via `exec("ls -A")` if the project uses a different convention.
- **Cannot fetch** (no network, paywall) → don't invent a local path. Omit, or mark inline `(TODO: image needs sourcing from <URL>)`.
- **Meaningful alt text required** — describes WHAT the image shows, not what it is. `![]()` / `![image]()` / `![filename.png]()` all fail. OK indexes alt text — it's both accessibility AND searchability.
- **Cite web image sources** below the image (Grounding rule):

  ```markdown
  ![Aang using the Avatar State to defeat Ozai](./assets/images/aang/avatar-state.png)
  *Source: [Avatar Wiki — Aang](./external-sources/avatar-wiki-aang.md)*
  ```

  Note that the wrapper's frontmatter holds `source_url:` with the original page URL. Do not actually ingest Avatar Wiki — example only.

  Original diagrams/screenshots may caption `*Original*` or omit. Unattributed web images are equivalent to unsourced factual claims.
