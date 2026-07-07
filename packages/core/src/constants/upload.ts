export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/ogg'] as const;

// `audio/webm` is intentionally absent: file-type@22's magic-byte detection
// returns `video/webm` for any WebM/Matroska container regardless of whether
// the stream is audio-only. Listing `audio/webm` here would never match the
// MIME `fileTypeFromBuffer` returns and would 400 every audio-only-webm
// upload that reached the allowlist check.
//
// These three arrays survive PR #270's accept-all server pipeline as
// declarative metadata only — consumed by `<input accept>` in PropPanel's
// file picker (UX hint to the OS file dialog) and by built-ins.ts as data
// values on `htmlImgProps[0].accept` / `htmlVideoProps[0].accept` /
// `htmlAudioProps[0].accept`. The server itself is accept-all; these
// arrays are picker-side filters, not security boundaries.
export const ALLOWED_AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg'] as const;

// PDF MIME type — sole member of the PDF allowlist (vs the multi-format
// audio/video/image lists). Same role as the others: PropPanel file-picker
// hint via `pdfProps[0].accept` in `built-ins.ts`. The server pipeline is
// accept-all (no MIME-type or extension gate); this list is declarative
// metadata only.
export const ALLOWED_PDF_MIME_TYPES = ['application/pdf'] as const;

/**
 * Canonical image-extension set. One source of truth for every dispatch
 * question: client emit-shape (`pickInsertShape`), server mdast→PM
 * (`handlers.wikiLinkEmbed`), client TipTap renderHTML (WikiLinkEmbed).
 * Widening here (e.g. heic) lands in all three dispatch paths atomically.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
]);

/**
 * Canonical video-extension set. Strict subset of `WIKI_EMBED_EXTENSIONS`;
 * disjoint from `IMAGE_EXTENSIONS` and `AUDIO_EXTENSIONS`. Members are the
 * browser-renderable video containers — `<video>` element survives them
 * across modern engines, and the sirv middleware serves them with
 * `Content-Disposition: inline` (see `INLINE_RENDERABLE_EXTENSIONS`).
 *
 * One source of truth for video-shape dispatch: client emit
 * (`pickInsertShape` returns `'jsx-video'`) and server mdast→PM
 * (`handlers.wikiLinkEmbed` emits `jsxComponent('WikiEmbedVideo')`).
 */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

/**
 * Canonical PDF-extension set. Strict subset of `WIKI_EMBED_EXTENSIONS`;
 * disjoint from `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `AUDIO_EXTENSIONS`.
 * Single member today (`pdf`) — kept as a Set for symmetry with the other
 * media extension sets so downstream dispatch (handlers.wikiLinkEmbed in
 * `markdown/index.ts`) reads the same shape across all four media kinds.
 *
 * The actual rendering goes through `componentMap['Pdf']` (the Pdf.tsx
 * canonical) — `pdfjs-dist` lazy-loads on first PDF render and renders
 * each page to its own `<canvas>` in a scrollable container with our
 * own toolbar (thumbnails-sidebar toggle, title, jump-to-page input,
 * zoom in/out, layout dropdown). The library is dynamic-imported via a
 * module-level singleton so it stays out of the main app bundle.
 */
export const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['pdf']);

/**
 * Canonical audio-extension set. Strict subset of `WIKI_EMBED_EXTENSIONS`;
 * disjoint from `IMAGE_EXTENSIONS` and `VIDEO_EXTENSIONS`. Members render
 * inline via `<audio>` and serve with `Content-Disposition: inline`.
 *
 * Mirrors `VIDEO_EXTENSIONS`'s role: one dispatch source for
 * `pickInsertShape` (`'jsx-audio'`) and `handlers.wikiLinkEmbed`
 * (`jsxComponent('WikiEmbedAudio')`).
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
]);

/**
 * Canonical file-attachment extension set — the catch-all for downloadable
 * types where img / video / audio don't carry an inline-preview surface.
 * Disjoint from `IMAGE_EXTENSIONS` / `VIDEO_EXTENSIONS` / `AUDIO_EXTENSIONS`
 * (PDF is INTENTIONALLY a member — the wikilink/drop form renders PDFs as
 * File rows; the pdfjs canvas viewer is opt-in via the `<Pdf>` JSX form).
 * Members render via the `File` canonical (see
 * `packages/app/src/editor/components/File.tsx`) — Notion-style inline row
 * with file-up icon + bold name + optional dim size, wrapped in a styled
 * `<a>` link.
 *
 * One source of truth for file-attachment-shape dispatch: client emit
 * (`pickInsertShape` returns `'jsx-file'` for these so dropped `.pdf` /
 * `.zip` / `.docx` / etc. produce `jsxComponent('WikiEmbedFile')` block
 * inserts whose serialize emits `![[file.ext]]` source bytes) and server
 * mdast→PM (`handlers.wikiLinkEmbed` emits `jsxComponent('WikiEmbedFile')`
 * in block context).
 *
 * Kept narrow on purpose — extensions here are the common author-drop
 * shapes (PDF, office docs, archives, structured-text). Unknown/opaque
 * extensions outside this set still fall through to the plain text+link
 * compat in `markdown/index.ts` so `![[notes.foo]]` doesn't silently
 * render as a "file" when it might be something else.
 */
export const FILE_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // PDF — the wikilink/drop form (`![[doc.pdf]]`) renders as a File row
  // alongside docx / zip / etc. The Pdf canvas viewer stays available
  // via the explicit `<Pdf src="..." />` JSX form (rendered by `Pdf.tsx`
  // with pdfjs-dist) — opt-in inline preview, not the default for
  // dropped PDFs. Keeps the dropped-attachment UX uniform across types.
  'pdf',
  // Office documents
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  // Archives
  'zip',
  '7z',
  'tar',
  'gz',
  'rar',
  // Structured-text / data
  'csv',
  'tsv',
  'rtf',
  'json',
  'yaml',
  'yml',
  'xml',
  'txt',
  // Apple iWork
  'pages',
  'numbers',
  'key',
  // OpenDocument
  'odt',
  'ods',
  'odp',
  // E-books
  'epub',
  'mobi',
]);

/**
 * Hard blocklist at the main-process `openAsset` handler. Executable
 * extensions are refused before `shell.openPath` dispatch regardless of
 * containment / existence checks.
 *
 * Union of three lists:
 *   - Windows executable set (verified from Obsidian 1.12.7 source
 *     reconstruction)
 *   - POSIX shell / launchable set (same source — macOS / Linux)
 *   - OK's existing stored-XSS defense `SCRIPTED_DOC_EXTS`
 *     (HTML / SVG / XML / MHTML variants that execute JS when opened in a
 *     browser chrome)
 *
 * The union is the principled blocklist — every extension in it is either
 * a shell-executable (RCE risk via OS handler) or a scripted document
 * (stored-XSS risk via browser-tab preview). Consumed by the main-process
 * `openAssetSafely` handler (`packages/desktop/src/main/asset-allowlist.ts`).
 *
 * Non-goal: signature-based blocking. We gate on extension because
 * `shell.openPath` dispatches by OS handler which is itself extension-keyed
 * on every platform OK supports.
 */
export const EXECUTABLE_BLOCKLIST_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows executables
  'exe',
  'bat',
  'cmd',
  'ps1',
  'com',
  'msi',
  'vbs',
  'js',
  'jse',
  'wsf',
  'wsh',
  // `.hta` (HTML Application) executes via mshta.exe with full local
  // privileges, bypassing browser sandbox (MITRE ATT&CK T1218.005,
  // CVE-2017-0199 class). Long-standing RCE / phishing vector. Absent
  // from Obsidian's reconstructed Windows blocklist
  // — deliberate divergence for defense-in-depth.
  'hta',
  // POSIX shells + Linux desktop launchers
  'sh',
  'command',
  'csh',
  'ksh',
  'bash',
  'zsh',
  'fish',
  'desktop',
  'action',
  'workflow',
  // Scripted documents (OK's existing SCRIPTED_DOC_EXTS — stored-XSS class)
  'html',
  'htm',
  'svg',
  'xml',
  'mhtml',
  'svgz',
  // macOS installer + script classes. `.dmg`/`.pkg`/
  // `.mpkg` mount via Launch Services; `.scpt`/`.applescript` run in Script
  // Editor which can shell out; `.terminal`/`.prefpane` auto-open system UI
  // with embedded settings (social-engineering class).
  'dmg',
  'pkg',
  'mpkg',
  'scpt',
  'applescript',
  'terminal',
  'prefpane',
  // macOS URL-file classes — `.webloc`/`.inetloc`/`.fileloc` carry a URL
  // that Launch Services navigates on open. `.fileloc` can embed `file://`
  // schemes (CVE-2022-22590 class).
  'webloc',
  'inetloc',
  'fileloc',
  // Cross-platform package + archive-installer classes
  'jar',
  'appimage',
  'deb',
  'rpm',
  'msix',
  'appx',
  'ipa',
  'apk',
  // Windows shortcut / program-information files
  'pif',
  'scr',
  'lnk',
  'url',
]);

// ContentFilter admits non-image asset extensions so they sit alongside
// markdown in the file index. Serve-side dispatch uses
// `INLINE_RENDERABLE_EXTENSIONS` (below) for `Content-Disposition: inline`
// and attachment-serves the rest; extension-based admission here is
// defense-in-depth against source-file leakage (`.ts`/`.py`/`.sh` NOT in
// this set, so they stay excluded by the content filter even when sitting
// next to an .md sibling).
export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'apng',
  'heic',
  'heif',
  'tiff',
  'bmp',
  'ico',
  // Documents
  'pdf',
  // Video
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  'avi',
  'flv',
  'wmv',
  'mpeg',
  'mpg',
  // Audio
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
  // Archives
  'zip',
  '7z',
  'tar',
  'gz',
  'rar',
  // Fonts
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  // Office documents
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  // OpenDocument
  'odt',
  'ods',
  'odp',
  // Apple iWork
  'pages',
  'numbers',
  'key',
  // E-books
  'epub',
  'mobi',
  // Tabular / text / data
  'csv',
  'tsv',
  'txt',
  'rtf',
  'json',
  'yaml',
  'yml',
  'xml',
  'toml',
  'lock',
  // GPS exchange (benign XML data) — served as a download.
  'gpx',
  // Scripted documents. Admitted so author-created HTML files are
  // index/serve/link-resolvable (their links would otherwise render as
  // "non-existent" redlinks). `html`/`htm` are NOT in INLINE_RENDERABLE_EXTENSIONS
  // and are barred from the desktop `shell.openPath` path by
  // EXECUTABLE_BLOCKLIST_EXTENSIONS; the serve layer renders them only inside the
  // `SANDBOXED_HTML_CSP` opaque origin below. See `createAssetServeMiddleware` +
  // `handleAsset`.
  'html',
  'htm',
]);

/**
 * The `html`/`htm` set the serve layer renders inline ONLY under
 * `SANDBOXED_HTML_CSP`. A two-member set (like `PDF_EXTENSIONS`) so the
 * security-relevant predicate has a single source of truth rather than
 * `ext === 'html' || ext === 'htm'` scattered across serve paths.
 */
export const SANDBOXED_HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);

/**
 * CSP for inline-served author HTML. `sandbox allow-scripts` (no
 * `allow-same-origin`) puts the document in a unique opaque origin: scripts run
 * (interactive author HTML works), but it cannot read OK's cookies / storage or
 * make SAME-origin requests. `connect-src 'none'` is load-bearing on top of
 * that: a sandboxed document's CROSS-origin `fetch`/XHR/WebSocket sends
 * `Origin: null`, which OK's loopback CSRF gate allowlists (for the Electron
 * `file://` renderer) — without `connect-src 'none'` the script could reach OK's
 * unauthenticated `/api/*` (read/mutate the KB) or exfiltrate to an external
 * host. `connect-src` does NOT gate subresource loads, so the document's own
 * `<img>`/`<link>`/`<script src>` still render. Mirrors the SVG sandbox posture.
 */
export const SANDBOXED_HTML_CSP = "sandbox allow-scripts; connect-src 'none'";

/**
 * Extensions that the browser renders safely INLINE when served with the
 * correct Content-Type — images, PDFs, video, audio, safe SVG via `<img>`.
 * Anything outside this set served via sirv MUST get
 * `Content-Disposition: attachment` so the browser downloads rather than
 * attempting to render ambiguously (stored-XSS defense aligned with
 * HedgeDoc's GHSA-x74j-jmf9-534w posture and Docmost's extension-gated
 * dispatch). Consumed by the Vite dev-plugin sirv middleware
 * (`packages/app/src/server/hocuspocus-plugin.ts`).
 *
 * Strict subset of ASSET_EXTENSIONS. Expanding this set is a privilege
 * decision — every addition broadens the inline-render surface and its
 * XSS-risk envelope. Office docs / archives / fonts / data files stay OUT
 * so they're attachment-only.
 */
export const INLINE_RENDERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images (browsers render inline via `<img>` or the address-bar viewer)
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'apng',
  'heic',
  'heif',
  'tiff',
  'bmp',
  'ico',
  // SVG: served as `<img src>` only. Top-level navigation to an
  // SVG (`image/svg+xml`) executes embedded `<script>` regardless of
  // `X-Content-Type-Options: nosniff` — nosniff blocks request-
  // destinations of script/style and enables CORB, but `image/svg+xml`
  // is explicitly excluded from CORB (per MDN + Chromium CORB
  // explainer). The defenses that actually contain SVG XSS in this
  // codebase are:
  //   (a) `<img src>` embeds do NOT execute SVG scripts (only top-level
  //       nav does), so the editor render path is safe by construction.
  //   (b) `EXECUTABLE_BLOCKLIST_EXTENSIONS` blocks `.svg` from
  //       `openAssetSafely` / `shell.openPath`
  //       (`packages/desktop/src/main/asset-allowlist.ts`), so the
  //       click-to-open path can't hand off to a top-level browser tab
  //       in Electron.
  //   (c) `handleAsset` adds a CSP sandbox header on direct fetches
  //       (`Content-Security-Policy: sandbox; default-src 'none'; ...`)
  //       to neutralize embedded `<script>` if SVG IS served inline.
  // Aligns with Docmost's posture; cf. GHSA-rcg8-g69v-x23j (Plane SVG
  // XSS) for the upstream class. nosniff stays on the response for
  // additional defense against MIME confusion attacks even though it
  // does not address the script-execution vector for SVG specifically.
  'svg',
  // PDF (Chromium built-in viewer; attachment would defeat it)
  'pdf',
  // Video
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  // Audio
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
  // Plain-text data formats — rendered via the sidebar's `TextViewer`
  // (CodeMirror, read-only) when previewing. Safe to serve `inline`
  // because browsers never execute scripts from these MIME types; the
  // built-in viewer fetches the bytes via `fetch()` and shows them in
  // a sandboxed editor surface regardless.
  //
  // `lock` covers the lockfile family: `bun.lock`, `Cargo.lock`,
  // `Gemfile.lock`, `Pipfile.lock`, `composer.lock`, OK's own
  // `.ok/local/server.lock`, etc.
  // Lockfile contents vary by ecosystem but all are plain text with no
  // standard grammar; CodeMirror's no-language fallback renders them
  // with line numbers, which is the right floor for "let me see the
  // bytes" inspection.
  'json',
  'toml',
  'lock',
]);

// Internal dispatch typing. These enums discriminate shape-selection in the
// client `pickInsertShape` and server upload handler; they are not a user
// config surface.
export type EmitFormat = 'wikiembed' | 'markdown-image';
export type DedupMode = 'off' | 'same-dir';
export type DedupUIMode = 'silent' | 'toast' | 'confirm';

// Fixed upload-surface constants for behavior that remains non-configurable:
// dedup, emit format, MIME/extension admission, and executable blocking.
// Attachment placement is the one project setting in this area and lives at
// `content.attachmentFolderPath`; do not reintroduce a legacy `upload.*`
// config section.

/**
 * Where uploads land on disk, relative to the containing markdown doc's
 * directory. `'./'` = colocated (drop-next-to-doc UX). Consumed by the
 * server upload handler.
 */
export const DEFAULT_ATTACHMENT_FOLDER_PATH = './';

/**
 * How `pickInsertShape` emits renderable-asset drops. `'wikiembed'` =
 * `![[file.ext]]` (OK-native shape). `'markdown-image'` would emit
 * `![](path)` but is reserved for a future export-time transformation;
 * the runtime always uses `'wikiembed'`.
 */
export const DEFAULT_EMIT_FORMAT: EmitFormat = 'wikiembed';

/**
 * sha256 same-directory dedup scope. Consumed by the server upload handler;
 * if the bytes match an existing sibling, the upload handler returns the
 * existing path.
 */
export const DEFAULT_DEDUP_MODE: DedupMode = 'same-dir';

/**
 * Client feedback shape when a drop dedups to an existing file.
 * `'toast'` = "Reused existing file.png" toast notification.
 */
export const DEFAULT_DEDUP_UI: DedupUIMode = 'toast';

/**
 * Extensions that drop into the editor as `![[file.ext]]` wiki-embed refs.
 * Post-roundtrip, mdast→PM dispatches via `handlers.wikiLinkEmbed`:
 * block-context image/video/audio → `jsxComponent('WikiEmbed*')`;
 * everything else (inline embeds, allowlisted-but-no-descriptor cases) →
 * PM text+link mark with `sourceForm: 'wikiembed'`; opaque ext → plain
 * text+link.
 *
 * Kept as a ReadonlySet for O(1) membership check in the client emit path.
 * Identical contents (order-preserved as an array) are consumed by the
 * server mdast→PM pipeline via `Array.from(WIKI_EMBED_EXTENSIONS)`.
 */
export const WIKI_EMBED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  // Documents
  'pdf',
  // Video — common browser-renderable video containers. Each here renders
  // inline via the embed NodeView's chip + the sirv middleware's
  // `Content-Disposition: inline` (from INLINE_RENDERABLE_EXTENSIONS).
  // Extensions like .avi / .wmv / .flv that ARE admitted to serve
  // (ASSET_EXTENSIONS) but NOT inline-renderable by browsers stay OUT of
  // this wiki-embed emit set — they keep the opaque link-chip render
  // (no WikiEmbed* descriptor chrome) while still serializing as
  // `![[...]]` byte-identically.
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  // Audio
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
  // File attachments — opaque downloadable types (docx/zip/csv/…). Source
  // of truth in `FILE_ATTACHMENT_EXTENSIONS` above; duplicated as inline
  // members here so the wiki-embed allowlist stays a single literal set
  // (`WIKI_EMBED_EXTENSIONS.has(ext)` is hot in the parser handler at
  // `markdown/index.ts:1153`). The runtime assertion below pins the two
  // sets in lock-step — adding to one without the other fails import.
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'zip',
  '7z',
  'tar',
  'gz',
  'rar',
  'csv',
  'tsv',
  'rtf',
  'json',
  'yaml',
  'yml',
  'xml',
  'txt',
  'pages',
  'numbers',
  'key',
  'odt',
  'ods',
  'odp',
  'epub',
  'mobi',
]);

export type InlineAssetMediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

// Sidebar-clickable asset extensions, grouped by inline-render path.
// Each set is a STRICT subset of its canonical-class set (asserted below),
// and the union must remain a strict subset of `INLINE_RENDERABLE_EXTENSIONS`
// (asserted below) so `Content-Disposition: inline` is set at serve-time.
//
// Broader than the canonical sets on purpose: when an author clicks a
// non-markdown file in the file tree we want a real preview where the
// browser can render the bytes natively (image / video / audio elements)
// or via our Pdf component. Types where no preview is possible fall
// through to the generic "Open file" affordance in `AssetPreview`.
const SIDEBAR_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] as const;
const SIDEBAR_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'] as const;
const SIDEBAR_AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'] as const;
const SIDEBAR_PDF_EXTENSIONS = ['pdf'] as const;
// Plain-text data formats the sidebar previews via `TextViewer`
// (CodeMirror, read-only, language-detected from the extension). Distinct
// from the canonical `*_EXTENSIONS` sets above because text formats don't
// have a renderer-bound canonical (they're not embed primitives, just
// editor-visible source); this set is its own root of truth. Authors
// who paste arbitrary file types can still escape to the text viewer via
// the "View as text" button in the asset preview pane
// (rendered in `AssetPreview`'s generic-fallback branch alongside "Open
// file"); see `AssetPreview.tsx`'s `forceText` toggle.
const SIDEBAR_TEXT_EXTENSIONS = ['json', 'toml', 'lock'] as const;

function assertSubset(
  name: string,
  extensions: readonly string[],
  canonical: ReadonlySet<string>,
): void {
  for (const ext of extensions) {
    if (!canonical.has(ext)) {
      throw new Error(`${name}: ${ext} is not present in canonical upload constants`);
    }
  }
}

assertSubset('SIDEBAR_IMAGE_ASSET_EXTENSIONS', SIDEBAR_IMAGE_EXTENSIONS, IMAGE_EXTENSIONS);
assertSubset('SIDEBAR_VIDEO_ASSET_EXTENSIONS', SIDEBAR_VIDEO_EXTENSIONS, VIDEO_EXTENSIONS);
assertSubset('SIDEBAR_AUDIO_ASSET_EXTENSIONS', SIDEBAR_AUDIO_EXTENSIONS, AUDIO_EXTENSIONS);
assertSubset('SIDEBAR_PDF_ASSET_EXTENSIONS', SIDEBAR_PDF_EXTENSIONS, PDF_EXTENSIONS);
// No per-class assertSubset for `SIDEBAR_TEXT_EXTENSIONS` — text formats
// have no canonical `*_EXTENSIONS` superset in core (see the declaration
// comment above); the `SIDEBAR_RENDERABLE_ASSET_EXTENSIONS` aggregate
// guard at the bottom of this block still pins the safety constraint
// (must be a subset of `INLINE_RENDERABLE_EXTENSIONS`).
// `FILE_ATTACHMENT_EXTENSIONS` must stay a subset of `WIKI_EMBED_EXTENSIONS`
// — the wiki-embed handler routes a wiki-embed to `WikiEmbedFile` (and the
// drop-flow emits `![[]]` syntax) only when the extension is allowlisted.
// Adding to one set without the other would silently break the dispatch.
assertSubset('FILE_ATTACHMENT_EXTENSIONS', [...FILE_ATTACHMENT_EXTENSIONS], WIKI_EMBED_EXTENSIONS);
// Every embeddable/linkable type must be one OK indexes + serves +
// link-resolves. ASSET_EXTENSIONS gates ContentFilter admission, /api/asset
// serving, and collectReferencedAssets (which feeds link-resolution's
// `assetPaths`). A type in WIKI_EMBED_EXTENSIONS but not here drops out of all
// three: its `![[file.ext]]` renders as a "non-existent" redlink and /api/asset
// 404s it. Keeping this subset closed is what prevents that asymmetry class.
assertSubset('WIKI_EMBED_EXTENSIONS', [...WIKI_EMBED_EXTENSIONS], ASSET_EXTENSIONS);

export const SIDEBAR_IMAGE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  SIDEBAR_IMAGE_EXTENSIONS,
);
export const SIDEBAR_VIDEO_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  SIDEBAR_VIDEO_EXTENSIONS,
);
export const SIDEBAR_AUDIO_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  SIDEBAR_AUDIO_EXTENSIONS,
);
export const SIDEBAR_PDF_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(SIDEBAR_PDF_EXTENSIONS);
export const SIDEBAR_TEXT_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(SIDEBAR_TEXT_EXTENSIONS);
export const SIDEBAR_RENDERABLE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SIDEBAR_IMAGE_EXTENSIONS,
  ...SIDEBAR_VIDEO_EXTENSIONS,
  ...SIDEBAR_AUDIO_EXTENSIONS,
  ...SIDEBAR_PDF_EXTENSIONS,
  ...SIDEBAR_TEXT_EXTENSIONS,
]);

assertSubset(
  'SIDEBAR_RENDERABLE_ASSET_EXTENSIONS',
  [...SIDEBAR_RENDERABLE_ASSET_EXTENSIONS],
  INLINE_RENDERABLE_EXTENSIONS,
);

// Extensions that open in the read-only text viewer but are deliberately
// excluded from SIDEBAR_RENDERABLE_ASSET_EXTENSIONS (and therefore from
// INLINE_RENDERABLE_EXTENSIONS). The assertSubset above pins every
// sidebar-renderable extension as a strict subset of INLINE_RENDERABLE_EXTENSIONS
// — adding these to SIDEBAR_TEXT_EXTENSIONS would force them through the XSS/serve
// allowlist boundary. Instead, they resolve to mediaKind:'text' here, and
// AssetPreview fetches their bytes via the ungated /api/asset-text endpoint.
// /api/asset keeps returning 415 for them (serve allowlist is unchanged).
export const TEXT_VIEWER_FALLBACK_EXTENSIONS: ReadonlySet<string> = new Set(['base', 'canvas']);

// Code-file extensions live in a sibling module so the
// language→extension table can be shared with the app-side TextViewer
// (which maps the same canonical IDs to CodeMirror language packs).
// Re-exporting here keeps the existing dispatch import surface (one
// `mediaKindForSidebarAssetExtension` call site) unchanged.
import { CODE_FILE_EXTENSIONS } from './code-languages';

export { CODE_FILE_EXTENSIONS };

/**
 * Extensions OK can LINK to and INDEX (file tree, link autocomplete, resolution,
 * backlinks) — the serve/embed allowlist (`ASSET_EXTENSIONS`) PLUS the text-viewer
 * fallback set (`.base`/`.canvas`). These extra members are indexable + linkable but
 * are NOT served via `/api/asset` (that path stays `ASSET_EXTENSIONS`-gated and 415s
 * them); their bytes come from the ungated `/api/asset-text`.
 */
export const LINKABLE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ...ASSET_EXTENSIONS,
  ...TEXT_VIEWER_FALLBACK_EXTENSIONS,
]);

/**
 * Maps a file extension to the `InlineAssetMediaKind` the sidebar uses to render it.
 * Returns `null` for extensions that have no sidebar viewer (e.g. `.docx`, `.zip`).
 *
 * Also covers the text-viewer-fallback set (`.base`/`.canvas`): those extensions
 * return `'text'` here and are fetched via the ungated `/api/asset-text` endpoint,
 * even though they sit outside `ASSET_EXTENSIONS` (the serve/XSS boundary). The name
 * is broader than "sidebar" implies — callers using this to gate serve-path logic
 * should gate on `ASSET_EXTENSIONS` directly, not on a non-null return value here.
 */
export function mediaKindForSidebarAssetExtension(ext: string): InlineAssetMediaKind | null {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  if (SIDEBAR_IMAGE_ASSET_EXTENSIONS.has(normalized)) return 'image';
  if (SIDEBAR_VIDEO_ASSET_EXTENSIONS.has(normalized)) return 'video';
  if (SIDEBAR_AUDIO_ASSET_EXTENSIONS.has(normalized)) return 'audio';
  if (SIDEBAR_PDF_ASSET_EXTENSIONS.has(normalized)) return 'pdf';
  if (SIDEBAR_TEXT_ASSET_EXTENSIONS.has(normalized)) return 'text';
  if (TEXT_VIEWER_FALLBACK_EXTENSIONS.has(normalized)) return 'text';
  // Files whose extension matches a codeblock-supported language
  // (`ts` / `py` / `go` / ...) open by default in the read-only
  // text viewer with syntax highlighting — same kind dispatch as
  // the existing text-fallback set, distinct source list so the
  // intent ("this is source code") stays legible at the call site.
  if (CODE_FILE_EXTENSIONS.has(normalized)) return 'text';
  return null;
}
