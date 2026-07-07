/**
 * Themed `html preview` starter snippets.
 *
 * Each starter is a complete, copy-ready `html preview` embed that styles
 * itself entirely with OK's injected theme tokens (`var(--chart-1)`,
 * `var(--card)`, `var(--foreground)`, …) — so it tracks the reader's light/dark
 * theme with no hand-picked colors. Every snippet is pure inline HTML / CSS /
 * JS with no external dependencies, so it renders self-contained — no network
 * access required.
 *
 * Single source of truth for two surfaces:
 *   - the `palette` MCP tool's `embedPatterns` (agent path)
 *   - the slash-command starter family in the editor (human path)
 *
 * Token reference: see `PREVIEW_THEME_TOKENS` — the same subset injected into
 * every preview iframe.
 */

/** One copy-ready themed `html preview` starter. */
export interface PreviewEmbedStarter {
  /** Stable id — slash-item suffix + `embedPatterns[].id`. */
  readonly id: 'chart' | 'stat-cards' | 'custom-svg' | 'interactive-control';
  /** Human-facing title (slash-menu label, `embedPatterns[].title`). */
  readonly title: string;
  /** One-line description of what the starter renders. */
  readonly description: string;
  /** The embed body — goes inside a ` ```html preview ` fenced block. */
  readonly html: string;
}

const CHART_HTML = `<div style="font-family:system-ui,sans-serif;padding:20px;color:var(--foreground)">
  <h3 style="margin:0 0 14px;font-size:15px;font-weight:600">Revenue by region</h3>
  <div id="bars" style="display:flex;align-items:flex-end;gap:14px;height:170px"></div>
  <script>
    var data = [['North', 42], ['South', 58], ['East', 71], ['West', 64], ['Central', 80]];
    var max = Math.max.apply(null, data.map(function (d) { return d[1]; }));
    document.getElementById('bars').innerHTML = data.map(function (d, i) {
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;' +
        'gap:6px;height:100%;justify-content:flex-end">' +
        '<span style="font-size:12px;font-weight:600">' + d[1] + '</span>' +
        '<div style="width:100%;height:' + (d[1] / max * 100) + '%;' +
        'background:var(--chart-' + (i + 1) + ');' +
        'border-radius:var(--radius) var(--radius) 0 0"></div>' +
        '<span style="font-size:12px;color:var(--muted-foreground)">' + d[0] + '</span>' +
        '</div>';
    }).join('');
  </script>
</div>`;

const STAT_CARDS_HTML = `<div style="font-family:system-ui,sans-serif;padding:20px">
  <div id="cards" style="display:flex;gap:14px;flex-wrap:wrap"></div>
  <script>
    var stats = [
      ['Active users', '12,480', '+8.2% MoM', 'var(--chart-2)'],
      ['Revenue', '$48.2k', '+3.1% MoM', 'var(--chart-1)'],
      ['Churn', '2.4%', '-0.5% MoM', 'var(--chart-5)']
    ];
    document.getElementById('cards').innerHTML = stats.map(function (s) {
      return '<div style="flex:1;min-width:150px;padding:16px;background:var(--card);' +
        'color:var(--card-foreground);border:1px solid var(--border);' +
        'border-radius:var(--radius)">' +
        '<div style="font-size:13px;color:var(--muted-foreground)">' + s[0] + '</div>' +
        '<div style="font-size:26px;font-weight:700;margin-top:4px">' + s[1] + '</div>' +
        '<div style="font-size:12px;font-weight:600;margin-top:4px;color:' + s[3] + '">' +
        s[2] + '</div>' +
        '</div>';
    }).join('');
  </script>
</div>`;

// Theme tokens INSIDE an SVG must be routed through `style="..."` rather
// than the matching presentation attribute (`fill=` / `stroke=`). CSS
// `var()` is NOT a valid SVG `<paint>` value per the W3C spec — Chromium
// 113+ tolerates it as a non-standard extension, but Safari / older
// Chromium silently fall back to the spec default (`fill: black`,
// `stroke: none`), so the rings render as black blobs. Routing through
// `style=` is the canonical form that works in every browser.
const CUSTOM_SVG_HTML = `<div style="font-family:system-ui,sans-serif;padding:20px;display:flex;align-items:center;gap:20px;color:var(--foreground)">
  <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="70 percent complete">
    <circle cx="60" cy="60" r="46" stroke-width="14" style="fill: none; stroke: var(--border)" />
    <circle cx="60" cy="60" r="46" stroke-width="14"
      stroke-linecap="round" stroke-dasharray="289" stroke-dashoffset="87"
      transform="rotate(-90 60 60)" style="fill: none; stroke: var(--chart-1)" />
    <text x="60" y="67" text-anchor="middle" font-size="22" font-weight="700"
      style="fill: var(--foreground)">70%</text>
  </svg>
  <div>
    <div style="font-weight:600;font-size:15px">Onboarding progress</div>
    <div style="font-size:13px;color:var(--muted-foreground);margin-top:2px">7 of 10 steps complete</div>
  </div>
</div>`;

const INTERACTIVE_CONTROL_HTML = `<div style="font-family:system-ui,sans-serif;padding:20px;color:var(--foreground)">
  <label for="amt" style="font-size:14px;font-weight:600">Monthly budget</label>
  <div id="out" style="font-size:30px;font-weight:700;color:var(--chart-1);margin:6px 0">$2,500</div>
  <input id="amt" type="range" min="500" max="10000" step="100" value="2500"
    style="width:100%;accent-color:var(--primary)" />
  <p style="font-size:13px;color:var(--muted-foreground)">Drag to adjust — the figure updates live.</p>
  <script>
    var amt = document.getElementById('amt');
    var out = document.getElementById('out');
    amt.addEventListener('input', function () {
      out.textContent = '$' + Number(amt.value).toLocaleString();
    });
  </script>
</div>`;

export const PREVIEW_EMBED_STARTERS: readonly PreviewEmbedStarter[] = [
  {
    id: 'chart',
    title: 'Chart',
    description: 'A bar chart whose series colors track the OK chart palette.',
    html: CHART_HTML,
  },
  {
    id: 'stat-cards',
    title: 'Stat cards',
    description: 'A row of metric cards on themed card surfaces.',
    html: STAT_CARDS_HTML,
  },
  {
    id: 'custom-svg',
    title: 'Custom SVG',
    description: 'An inline SVG progress ring drawn with theme tokens.',
    html: CUSTOM_SVG_HTML,
  },
  {
    id: 'interactive-control',
    title: 'Interactive control',
    description: 'A themed range slider with a live-updating value.',
    html: INTERACTIVE_CONTROL_HTML,
  },
];

/**
 * The full ` ```html preview ` fenced block for a starter — copy-ready
 * markdown an agent can paste straight into a document.
 */
export function previewEmbedFence(starter: PreviewEmbedStarter): string {
  return ['```html preview', starter.html, '```'].join('\n');
}
