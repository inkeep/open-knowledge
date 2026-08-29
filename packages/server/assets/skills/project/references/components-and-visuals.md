# Components + visuals — markdown-native forms and `html preview` embeds

## Components — write the markdown-native form, not JSX

OK auto-promotes markdown-native syntax into themed canonical components at parse time. **Write the markdown-native form — don't reach for JSX when one exists.** The promoted component is themed, accessible, and part of the content graph; hand-rolled JSX is none of those, and it fights the model's markdown prior instead of using it.

| Want | Write this (markdown-native) | Promotes to |
| --- | --- | --- |
| Callout / admonition | `> [!NOTE]` + body — 15 types (NOTE, TIP, IMPORTANT, WARNING, CAUTION, …); append `+` / `-` (`> [!NOTE]+`) to make it foldable | themed Callout |
| Collapsible section | `<details><summary>Title</summary>` … `</details>` | themed Accordion |
| Diagram | a ` ```mermaid ` fenced block (flowchart, sequence, class, state, ER, gantt, pie) — label-text pitfalls + escapes: `palette({ components: ["Mermaid"] })`; parse failures come back as `warnings` entries on write/edit | Mermaid diagram |
| Math | `$x$` inline, `$$…$$` block | KaTeX Math |
| Highlight | `==text==` | highlight mark |
| Author-only comment (hidden from readers) | `%%text%%` or `<!-- text -->` (mid-sentence, a body that is only a formatted word, `%%**bold**%%`, stays prose — pair it with plain text; alone on a line it is fine) | comment mark |
| Inline a doc or asset | `![[file]]` | wiki embed |

**These delimiters are live in ordinary prose.** `==`, `$`, `$$`, `%%`, `<!--` … `-->` and `~~` format — or hide — whatever sits between them, wherever they appear, not only where you meant them as syntax. To show a literal pair, wrap it in an inline code span (`` `==x==` ``, `` `$5` ``), which always works and reads as code; or backslash-escape a delimiter to keep it as running prose. Escaping either side is enough for `==`, `$`, `%%` and `<!--`: `\==x\==`, `\$5`, `\%\%note\%\%`, `\<!-- note -->`. For `~~`, escape both tildes (`\~\~x\~\~`) — a one-sided `\~~x~~` renders right but gets rewritten to the two-sided form on save. Watch `%%` and `<!-- -->` in particular: an accidental pair doesn't restyle the text, it hides it.

`Tabs` and `Excalidraw` are the only canonicals with **no** markdown-native form — write the JSX directly (`<Tabs><Tab label="…">…</Tab></Tabs>`; `Excalidraw` below).

`<Excalidraw src="path/board.excalidraw" />` embeds a live snapshot of an Excalidraw board — the `src` is doc-relative or root-relative and MUST keep the `.excalidraw` extension, and the referenced board must already exist: MCP `write` cannot create `.excalidraw` docs (it authors `.md`/`.mdx` only), so only reference boards a human has created. The embed re-renders as the board changes and links to the board's own canvas editor.

For any canonical's full JSX prop schema, call `palette({ components: [ids] })`. If no canonical fits, any `<TagName>…</TagName>` falls through as raw MDX — but prefer a canonical when one matches.

**Discover the palette in one call.** `palette` returns every markdown-native form (copy-ready `example` + `guidance`), the themed `html preview` embed starters, and the injected theme-token list — the source of truth for component-forward, themed authoring. Canonical names/counts beyond the markdown-native set are project-specific; the inventory in the `write` / `edit` descriptions and `palette({ components })` are authoritative for those.

**Show findings, don't just tell them.** When a point is quantitative or comparative — a trend over time, a breakdown, a before/after, a ranking, a distribution — present it visually: a chart or stat-card `html preview` embed, a ` ```mermaid ` diagram, a table, or a Callout for the headline takeaway. Prose-only buries the insight. This matters most where the document's job is to make findings legible — **`research` reports and `consolidate` articles especially**, and any write-up meant to present results. A research article with three dense paragraphs of numbers should have been a chart. Reach for `palette` as you draft, not after.

## `html preview` — themed interactive embeds

A ` ```html preview ` fence (also `htm` / `xml`) renders a standalone HTML/CSS/JS page as a live sandboxed iframe — the extend-to-anything primitive for charts, stat cards, custom SVG, calculators, demos. The iframe auto-sizes to its content; pass `h=` / `w=` (e.g. ` ```html preview h=400px `) only to pin a fixed size.

**Start from a starter — don't hand-roll.** `palette` returns `embedPatterns` (chart, stat cards, custom SVG, interactive control), each already wired to the theme tokens. Copy one and fill in your data — that is the only path that cannot render unthemed. Hand-author a fence from scratch only when no starter is close.

**MUST — never hardcode colors in an `html preview` embed.** OK injects its theme tokens into every preview iframe; an embed that hardcodes hex / `rgb()` renders unthemed — a white box on a dark page, clashing with every component around it. This is the single most common embed mistake. Wire every color to a token: `var(--chart-1..5)` for chart series, `var(--foreground)` / `var(--muted-foreground)` for text, `var(--card)` / `var(--background)` for surfaces, plus `var(--border)`, `var(--primary)`, `var(--radius)`. Don't set a `body` background at all unless you specifically mean to — the iframe already carries a themed one.

````
```html preview
<div style="font-family:system-ui;padding:20px;color:var(--foreground)">
  <h3 style="margin:0 0 10px">Themed embed</h3>
  <div style="display:flex;gap:8px">
    <div style="flex:1;height:48px;background:var(--chart-1);border-radius:var(--radius)"></div>
    <div style="flex:1;height:48px;background:var(--chart-2);border-radius:var(--radius)"></div>
    <div style="flex:1;height:48px;background:var(--chart-3);border-radius:var(--radius)"></div>
  </div>
</div>
```
````

Done wrong, that same embed is `body{background:#fff;color:#1a1a1a}` with a `background:#2563eb` bar — a white box with a hardcoded blue, blind to the reader's theme.

**Charts.** A pure-CSS or inline-SVG chart wired to `var(--chart-*)` re-skins on a theme toggle for free — prefer it. A JS charting library (Chart.js, D3) works too, but a themed `body` does NOT theme the colors you pass the library in JS — read the token at runtime instead of hardcoding:

```js
const c1 = getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim();
// → pass c1 to Chart.js / D3 as the series color
```

**Boundary.** Reach for a canonical (via its markdown-native form) when one matches the semantic need — it is themed and integrated. Reach for ` ```html preview ` for interactive or bespoke content no canonical covers. ` ```<lang> ` fences for other languages are plain syntax-highlighted code, no preview.

**External resources load directly.** The preview iframe has open network access — an embed can load external stylesheets, `fetch` live data, pull map tiles / remote images, use web fonts, or embed third-party iframes over `https:`. A Leaflet map, a live-`fetch` chart, or a Google-Font embed renders with no extra setup. The iframe is a sandboxed null-origin frame, so an embed can reach the network but can never read the knowledge base, cookies, or auth. (`'unsafe-eval'` is not granted — Chart.js / Leaflet / Plotly don't need it; a library that compiles expression strings at runtime won't run.)
