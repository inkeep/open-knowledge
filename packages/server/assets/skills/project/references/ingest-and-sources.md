# Ingest — capture an external source as raw reference material

Capture an external source into the knowledge base as raw reference material. The KB is **closed-loop**: external sources are pulled IN so downstream docs cite local paths, never bare web URLs. This applies whether a user shared the source OR you fetched it yourself to ground a claim — agent-initiated fetches are not exempt (core §Grounding). **Raw preservation only** — no summary, no analysis, no interpretation.

**Bias toward binary preservation.** When the source is a binary file (PDF, image, audio, video, Office doc, archive, dataset), preserve the raw bytes — do NOT settle for a text scrape. OK ships a complete asset-embed surface (`![[file.ext]]` wiki-embed, file-watcher pickup, sha256 dedup, blocked-extension enforcement); this procedure bridges the source to it via your shell tool.

Sources land under `external-sources/` when the project has that folder (the `knowledge-base` starter pack's raw layer); otherwise pick the project's equivalent and stay consistent. Paths below are relative to the resolved `content.dir` (`config({ key: 'content.dir' })`).

## Step 0: Is this source worth preserving?

Before fetching anything, sanity-check:

- **Is it in scope?** If the source is unrelated to what this knowledge base is accumulating, ingest is pollution. Check the existing layout: `exec("ls -A <content-dir>")`.
- **Is it already ingested?** `exec("grep -rln <source-url-or-title-slug> <content-dir>")` — if the same source is already present with current content, stop and reuse. Re-ingest is appropriate when the source changed materially — see Step 5 for sha256-mismatch semantics.
- **Is the intent actually preservation or analysis?** If the user wants findings synthesized rather than raw bytes archived, redirect to a research pass (which captures sources as needed). Don't pre-ingest speculatively.

If all three checks pass, proceed.

### Shell-capability self-detection (evaluate before any shell call)

If your host does not expose a shell-like tool (no Bash / Terminal / shell-exec / equivalent), you cannot run `curl` for either the HEAD probe (Step 1a) or the binary download (Step 1b). Detect once at the start via a trivial probe (`echo ok` via the host's shell affordance, or a known-safe `which curl` invocation). On absence of a shell tool, route the source straight to **Step 1c (text fetch / shell-less fallback)** — skipping Step 1a's HEAD-tiebreaker classification and Step 1b's binary download entirely — and surface the degradation explicitly to the user.

## Step 1a: Detect source kind (binary vs text)

Classify the source before fetching. **`.svg` is intentionally absent from the binary-extension list — SVG can contain scripts and is treated as a scripted-document extension; see Step 1b's executable hard-block.**

- **URL with a binary file extension** (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.mp4`, `.webm`, `.mov`, `.m4v`, `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.docx`, `.xlsx`, `.pptx`, `.doc`, `.xls`, `.ppt`, `.zip`, `.7z`, `.tar`, `.gz`, `.rar`, `.csv`, `.tsv`, `.epub`, etc.) → treat as **binary**. Skip to Step 1b.
- **URL with a clear HTML/text extension** (`.html`, `.htm`, none, `.txt`, `.md`) → treat as **text**. Skip to Step 1c. The executable hard-block does NOT apply here because Step 1c never writes the source extension to disk — it writes a `.md` wrapper containing the extracted text.
- **Local file path** → use your native file read tool. If the local file is text (HTML, plain, markdown), skip to **Step 2b** (text wrapper). If it is a binary you want preserved verbatim, you already have the bytes on disk — skip Step 1b's download and go to **Step 2a** (binary wrapper), pointing `source_path:` at the existing local path (relative to the wrapper).
- **Ambiguous URL** (no extension, query-string download URL, redirect-y link) → run `curl -IL --proto =http,=https --proto-redir =http,=https --max-redirs 5 -A 'Mozilla/5.0' <url>` to read response headers, then classify by `Content-Type`:
  - `application/pdf`, `image/*` (except `image/svg+xml`), `video/*`, `audio/*`, `application/zip`, `application/vnd.openxmlformats-*`, `application/epub+zip` → **binary**
  - `text/html`, `text/plain`, `application/json` (when the source is a doc/article, not data) → **text**
  - `application/octet-stream` → ambiguous; treat as binary BUT note in chat that the server didn't declare a specific type, and the captured `sha256` + bytes record gives downstream tooling the signal if the bytes turn out to be HTML.

### STOP gates evaluated during Step 1a (before any download)

1. **Streaming-video / DRM-protected media.** If the URL hostname matches a known streaming pattern (examples — illustrative, not exhaustive: `youtube.com`, `youtu.be`, `vimeo.com`, `twitch.tv`, `tiktok.com`, `spotify.com`, `open.spotify.com`, `podcasts.apple.com`) **OR** the HEAD response shows `Content-Type: text/html` on a URL that looked like media **OR** the HEAD shows anti-bot characteristics (`Server: cloudflare` + `cf-mitigated` / `cf-chl-bypass` headers, an Akamai/Imperva challenge response, 403 with an HTML body) → **STOP**. Tell the user: "Streaming services and DRM-protected media require `yt-dlp` or vendor-specific tooling — out of scope. Paste the transcript, or run `yt-dlp` manually and re-share the resulting file as a local path."

2. **URL scheme — HARD BLOCK.** If the URL scheme is not `http://` or `https://` (i.e., `file://`, `gopher://`, `ftp://`, etc.) → **HARD STOP**. Tell the user: "Ingest only fetches `http(s)` URLs. Other schemes (local-file paths, intranet protocols) bypass the size + redirect safeguards and risk pulling cloud-metadata or local-service responses into the KB. If you have a local file, pass its path directly as a local-file source instead of a URL."

3. **Auth-walled / paywalled / 4xx.** If HEAD returns 401/402/403/407/429 → STOP. Ask the user to paste the content or share a local copy.

## Step 1b: Binary fetch

You've classified the source as binary and Step 1a's STOP gates passed. Step 1b adds **write-path-specific** STOP gates that only apply when we're about to land bytes on disk under the source extension:

### Step 1b STOP gates (write-path only)

1. **Executable / scripted-document extension — HARD BLOCK.** If the URL extension is one OK's upload blocklist covers — Windows executables, POSIX shells, scripted documents (including `.svg` and `.xml`), macOS installer classes, URL-files, cross-platform packages, and Windows shortcut classes — **HARD STOP**. Refuse to download. Tell the user: "Executable / scripted-document extensions are not auto-fetched — the runtime backstop is desktop-only, so plan-level enforcement is the only line of defense in CLI / web contexts. If you genuinely want to archive this file, `curl` it manually outside the agent and reference the local path." This gate fires HERE (write path) and NOT against Step 1c — Step 1c writes a `.md` wrapper with extracted text, not the source extension on disk.

2. **Size pre-check.** Run `curl -IL --max-redirs 5 -A 'Mozilla/5.0' '<SOURCE_URL>'` (if not already done in Step 1a's ambiguous-URL branch) and read `Content-Length`:
   - greater than 100 MB → **HARD STOP**. Tell the user the source exceeds GitHub's 100 MB file-size cap and offer the manual-`curl` + Git-LFS escape path.
   - greater than 50 MB → STOP and ask explicitly: "Source is X MB (above the 50 MB GitHub warn threshold). Proceed?"
   - absent → proceed; the `curl --max-filesize` flag is the enforced backstop. Note in chat that the size could not be pre-verified.
   - 50 MB or under → proceed.

### Slug derivation (strict shape)

Pick a kebab-case slug from the source's filename or title (e.g., `karpathy-2024-llm-os`). The slug becomes both the binary basename and the wrapper basename. Don't put dates in the slug — dates go in frontmatter (and in dated-sibling slugs on re-ingest per Step 5).

**The slug MUST match `^[a-z0-9][a-z0-9-]{0,99}$` — kebab-case, ASCII letters / digits / single hyphens only. NO dots, slashes, leading hyphens, or path segments. If you derive the slug from a server-controlled value (`Content-Disposition: filename=`, URL path basename), strip non-conforming characters before using it.** A server returning `Content-Disposition: attachment; filename="../../etc/passwd"` is adversarial; the slug constraint prevents path traversal from a malicious source landing bytes outside the sources folder. If the stripped result is empty, ask the user for a slug.

### Download

Use your shell tool. Create the destination first if it doesn't exist:

```bash
mkdir -p "<content-dir>/external-sources"
curl -L --fail \
  --proto =http,=https --proto-redir =http,=https \
  --max-redirs 5 \
  --max-time 60 \
  --max-filesize 104857600 \
  -o "<content-dir>/external-sources/<slug>.<ext>" \
  -A 'Mozilla/5.0' \
  '<SOURCE_URL>'
```

**Shell-escape any special characters in the URL (single quotes, backticks, dollar signs). Do NOT paste a URL containing a literal single quote directly into the single-quoted curl argument — break it into a shell-safe form first.**

Flag rationale:
- `-L` follows redirects (CDN-fronted sources need this).
- `--proto =http,=https --proto-redir =http,=https` refuses any scheme other than http(s), and refuses redirects that would downgrade to another scheme. Prevents redirect-chain SSRF into `file://`, `gopher://`, or cloud-metadata endpoints reached via `--max-redirs`.
- `--fail` exits non-zero on HTTP 4xx/5xx instead of writing an error body to disk.
- `--max-redirs 5` caps redirect chains (exit 47 on excess).
- `--max-time 60` caps total request time (exit 28).
- `--max-filesize 104857600` enforces the 100 MB hard cap as defense-in-depth in case the server omits or lies about `Content-Length` (exit 63). The option has shipped since curl 7.10.8 (2003) — every modern install has it.

If curl exits non-zero:
- 47 (too many redirects) → STOP. Likely a tracking-link or auth-flow URL. Ask the user to paste.
- 28 (timeout) → STOP. Slow source. Ask the user to retry or share locally.
- 63 (`--max-filesize` triggered) → `rm -f` the truncated output. STOP and tell the user the server's `Content-Length` was missing or wrong.
- 22 (HTTP error returned by `--fail`) → STOP. Auth wall, anti-scraping, or vanished URL. Ask the user to paste.
- Other (e.g., 1 = unsupported protocol from `--proto`) → STOP and report the curl exit code to the user.

After a successful download, record the byte size and sha256:

```bash
ls -l "<content-dir>/external-sources/<slug>.<ext>"      # bytes
sha256sum "<content-dir>/external-sources/<slug>.<ext>"  # or 'shasum -a 256' on macOS
```

OK's file-watcher picks up the new file and emits `asset-create`. The sidebar refreshes; the file is now indexed.

## Step 1c: Text fetch (HTML / article sources, or shell-less host fallback)

Either the source is genuinely text (HTML article, plain text doc) OR your host is shell-less and binary preservation is unavailable.

Use your available web fetch tool (`WebFetch` or your host's equivalent). If the fetcher returns an obvious *summary* of the page instead of the raw content (some LLM-backed fetch tools do this), note it and try a raw alternative (`curl -sL <url>` if your host has a shell, or ask the user to paste). The goal is verbatim bytes.

If the fetch fails (login wall, 401/402/403/429, anti-scraping block), **stop and ask the user to paste the content directly**. Do not save a stub, an error page, or a login wall as "raw content" — that poisons the knowledge base.

## Step 2a: Save the binary wrapper (only after Step 1b succeeded)

Write a markdown wrapper at `external-sources/<slug>.md`. **Declare the full tag list explicitly — do NOT assume a folder-level cascade exists** (folder frontmatter is self-only; it does not flow into child docs — see `references/folder-model.md`).

```yaml
---
title: Original title of the source (from <title>, Content-Disposition filename, or your best read)
description: One-line summary from the source (their words, not yours)
type: source
source_url: https://example.com/path/to/file.pdf
source_path: ./<slug>.<ext>    # relative to this wrapper
media_type: application/pdf    # RFC 6838 type/subtype, from HEAD Content-Type
bytes: 1234567                 # integer, from ls -l or stat
sha256: <hex sha256 digest>    # full 64-char hex, of the embedded binary
date_fetched: YYYY-MM-DD
author: Original author if known
preservation: binary
supersedes:                    # OPTIONAL — dated-sibling re-ingest (Step 5)
  - <prior-slug>.md
tags:
  - source
  - immutable
  - layer-ingest
  - binary
---

![[<slug>.<ext>]]
```

The body is just the wiki-embed reference. For images, video, and audio, the embed renders inline. **For PDFs and other opaque file-attachment types (docx, xlsx, zip, etc.), the `![[file.ext]]` form renders as a Notion-style File row that click-dispatches to the appropriate viewer** — the pdfjs canvas viewer is opt-in via the explicit `<Pdf src="./<slug>.pdf" />` JSX form, NOT the wiki-embed default. If the user wants the inline canvas viewer for this specific PDF, they can post-edit the wrapper body to swap the embed for that form.

Write via `write` (NOT native `Write` — the CRDT path is mandatory for in-scope markdown).

## Step 2b: Save the text wrapper (only after Step 1c — text path or shell-less fallback)

Write a markdown wrapper at `external-sources/<slug>.md` with the text content preserved verbatim in the body. Strip obvious boilerplate (nav menus, cookie banners, ads, footer links, "related articles" widgets) but **do not summarize, paraphrase, or interpret**.

Frontmatter shape:

```yaml
---
title: Original title of the source
description: One-line summary from the source (their words, not yours)
type: source
source_url: https://example.com/article
media_type: text/html
date_fetched: YYYY-MM-DD
author: Original author if known
preservation: text-extracted    # OR: text-only (a shell-less fallback for a binary source)
# NOTE: no `source_path` — text wrappers ARE the content. `source_path` is meaningful only for
# binary wrappers (Step 2a), where it points at the co-located binary sibling.
tags:
  - source
  - immutable
  - layer-ingest
  - text
---
```

**If this is a shell-less fallback for a source that should have been binary** (you detected binary in Step 1a but your host couldn't `curl`), set `preservation: text-only` AND prepend a top-of-body admonition so a future agent (or you, on a different host) can detect and upgrade:

```markdown
> Binary not preserved — this is an extracted-text snapshot of a binary source.
> Re-run ingest from a shell-capable client to capture the original file.

(...verbatim extracted text follows...)
```

Downstream tooling can grep `preservation: text-only` in frontmatter to find docs that need upgrading.

## Step 3: Preserve the content faithfully

For binary wrappers: the wrapper body is the wiki-embed reference; no further body content is needed. All metadata lives in frontmatter.

For text wrappers:
- **Keep** headings, lists, quotes, code blocks, images, citations, references.
- **Strip** obvious boilerplate: nav menus, cookie banners, ads, footer links, "related articles" widgets.
- **Do NOT** summarize, critique, paraphrase, or interpret.
- **For very long sources**, consider splitting by major section with cross-references in frontmatter.

## Step 4: Verify

- File(s) exist under the sources folder (binary + wrapper, or wrapper alone for text).
- Valid frontmatter (at minimum `title`, `description`, `type: source`, `source_url`, `preservation`, and the full `tags` list — plus `source_path` for binary wrappers).
- For binary preservation: `sha256` and `bytes` recorded; `media_type` matches what the HEAD response returned.
- `exec("ls -A <content-dir>/external-sources/")` lists the new file(s) with enrichment.

## Step 5: Re-ingest semantics (sha256 mismatch on a previously-ingested source)

If `external-sources/<slug>.<ext>` already exists when you reach Step 1b:

1. Compute its sha256.
2. If the new sha matches the existing sha → **STOP** (no-op). Tell the user: "Already at `external-sources/<slug>.<ext>` — sha256 matches, no change."
3. If the new sha differs → save the new bytes as `external-sources/<slug>.YYYY-MM-DD.<ext>` (today's date in the slug) AND write a **new** wrapper `external-sources/<slug>.YYYY-MM-DD.md` whose `supersedes:` is a YAML list naming the predecessor:
   ```yaml
   supersedes:
     - <slug>.md
   ```
   **Do not mutate the old wrapper or the old binary** — the sources layer is append-only by convention.

The latest-dated wrapper is the "current view"; older wrappers remain valid as historical snapshots.

## Step 6: Discuss takeaways with the user (no file write)

After preservation, briefly surface back to the user what the source actually contains — in **chat**, not in the raw file. The raw file stays verbatim; the human collaborator gets a quick orientation.

- 3-5 bullet points capturing the source's main claims, with no editorializing.
- Note any **tensions** with existing knowledge-base docs you surfaced in Step 0 — agents that ingest in isolation miss the "wait, this contradicts `[prior article](./path/to/prior.md)`" signal.
- Offer next steps: "Shall I research this topic now, or is preservation enough?" Don't silently chain into a research pass — the user may have just wanted the archive.
- For binary preservation: include the one-line breadcrumb (`saved external-sources/<slug>.<ext> — <bytes> bytes, sha256 <abbrev>`).
- For a shell-less text fallback of a binary source: explicitly tell the user the binary was not preserved and recommend re-running from a shell-capable client.

## Step 7 (optional): Update neighbor docs to link the new source

If the source is directly relevant to an existing article or research doc, update that doc to link the new raw source. A preserved source that no doc points at is an island. Limit this to 1-3 high-signal neighbors.

- Follow the `write` / `edit` contract from the core skill.
- For binary wrappers, prefer linking to the wrapper (the markdown doc), not the binary directly. The wrapper is the closed-loop citation target; the binary is the embedded asset within it.
- Do NOT mass-update every neighbor. Focused cross-linking is rewarded; noisy neighbor-pings degrade the signal.

## Non-goals

- **No analysis** — don't interpret, compare, or critique the source. That is the research layer's job.
- **No promotion to a canonical article** — that is the consolidate layer's job, later.
- **No silent chaining into research** — ingest completes on its own; the user explicitly opts into a research pass.
- **No synthesis inside the raw file** — takeaways live in chat or a separate summary doc, never mixed into the preserved source.
- **No OCR / transcription** — binary preservation only.
- **No streaming-video direct download** — `yt-dlp` is a separate workflow; STOP and route to it (Step 1a STOP gate 1).
- **No executable / scripted-document auto-fetch** — hard-blocked at Step 1b STOP gate 1 (write-path only). The user runs `curl` manually outside the agent if they need to archive such a file.

This procedure feeds a three-layer pipeline (ingest → research → consolidate). Ingest is this file, and ships with every `ok init`; research and consolidate are two member skills of the `knowledge-base` starter pack, available only once it is seeded. See `references/starter-packs.md`.
