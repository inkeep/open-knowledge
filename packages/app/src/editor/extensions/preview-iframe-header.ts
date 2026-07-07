import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';

/** The reader's resolved app theme, baked into a preview iframe's `srcDoc`. */
export type PreviewTheme = 'light' | 'dark';

/**
 * `postMessage` payload key the parent uses to re-skin a live preview iframe
 * on a theme toggle. Single source of truth — the injected bootstrap script
 * and {@link buildPreviewThemeMessage} both key off this constant.
 */
const PREVIEW_THEME_MESSAGE_KEY = 'okPreviewTheme';

/** The `postMessage` payload shape sent parent → preview iframe on toggle. */
export interface PreviewThemeMessage {
  [PREVIEW_THEME_MESSAGE_KEY]: PreviewTheme;
}

/**
 * Build the message the NodeView posts into a preview iframe when the reader
 * toggles the app theme. The iframe's bootstrap script flips its root class
 * in response — no `srcDoc` rebuild, no reload.
 */
export function buildPreviewThemeMessage(theme: PreviewTheme): PreviewThemeMessage {
  return { [PREVIEW_THEME_MESSAGE_KEY]: theme };
}

/**
 * `postMessage` payload key the preview iframe uses to report its rendered
 * content height back to the parent NodeView (iframe → parent). The NodeView
 * fits the iframe to this height when the fence carries no explicit `h=`.
 * Single source of truth — the injected bootstrap script and
 * {@link parsePreviewHeightMessage} both key off this constant.
 */
const PREVIEW_HEIGHT_MESSAGE_KEY = 'okPreviewHeight';

/**
 * Read a content-height report posted by a preview iframe. Returns the
 * rounded-up positive pixel height, or `null` when `data` is not a
 * height-report message.
 */
export function parsePreviewHeightMessage(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const h = (data as Record<string, unknown>)[PREVIEW_HEIGHT_MESSAGE_KEY];
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.ceil(h) : null;
}

/**
 * `postMessage` payload key the preview iframe uses to report CSP-blocked
 * requests back to the parent NodeView (iframe → parent). The preview runs
 * untrusted content under a restrictive CSP; when the policy (or the host's
 * own security layer) blocks a request, the browser fires
 * `securitypolicyviolation` inside the iframe and drops it silently. The
 * bootstrap script collects those and posts them here so the NodeView can
 * surface a reader-visible notice — the reader can't see the iframe console,
 * least of all inside the Claude desktop preview browser. Single source of
 * truth — the injected bootstrap script and
 * {@link parsePreviewCspViolationMessage} both key off this constant.
 */
const PREVIEW_CSP_VIOLATION_MESSAGE_KEY = 'okPreviewCspViolation';

/** One CSP-blocked request: the violated directive and the (browser-reported,
 *  possibly origin-truncated or `inline`/`eval`) URI it blocked. */
export interface PreviewBlockedRequest {
  directive: string;
  uri: string;
}

/**
 * Max distinct blocked requests carried in one report. A pathological embed
 * could fire hundreds of violations; the cap keeps the `postMessage` payload
 * (and the notice) bounded, and the `truncated` flag tells the reader more were
 * blocked than are listed. Shared by the inline bootstrap script (via string
 * interpolation) and the tests.
 */
export const PREVIEW_CSP_VIOLATION_SAMPLE_CAP = 20;

/**
 * Read a CSP-violation report posted by a preview iframe. Returns the
 * deduped/bounded blocked-request list plus the truncation flag, or `null` when
 * `data` is not a CSP-violation message or carries no valid entries.
 */
export function parsePreviewCspViolationMessage(
  data: unknown,
): { blocked: PreviewBlockedRequest[]; truncated: boolean } | null {
  if (typeof data !== 'object' || data === null) return null;
  const payload = (data as Record<string, unknown>)[PREVIEW_CSP_VIOLATION_MESSAGE_KEY];
  if (typeof payload !== 'object' || payload === null) return null;
  const rawBlocked = (payload as Record<string, unknown>).blocked;
  if (!Array.isArray(rawBlocked)) return null;
  // The iframe is an untrusted source — validate each entry's shape rather than
  // trusting the report wholesale; drop anything that is not a string pair.
  const blocked: PreviewBlockedRequest[] = [];
  for (const item of rawBlocked) {
    if (typeof item !== 'object' || item === null) continue;
    const directive = (item as Record<string, unknown>).directive;
    const uri = (item as Record<string, unknown>).uri;
    if (typeof directive === 'string' && typeof uri === 'string') {
      blocked.push({ directive, uri });
    }
  }
  // An empty list carries no information — treat it as not-a-report so the
  // NodeView never shows an empty notice.
  if (blocked.length === 0) return null;
  return { blocked, truncated: (payload as Record<string, unknown>).truncated === true };
}

/**
 * Scrollbar styling shipped inside the preview document. The iframe's null
 * origin (`sandbox="allow-scripts"` without `allow-same-origin`) blocks
 * cross-frame styling, so `subtle-scrollbar` CSS travels as part of the
 * srcDoc rather than being inherited from the host page.
 */
const PREVIEW_SCROLLBAR_STYLE = `<style>
  html, body { scrollbar-width: thin; scrollbar-color: rgba(115,115,115,0.4) transparent; }
  html::-webkit-scrollbar, body::-webkit-scrollbar,
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  html::-webkit-scrollbar-track, body::-webkit-scrollbar-track,
  *::-webkit-scrollbar-track { background: transparent; }
  html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb,
  *::-webkit-scrollbar-thumb { background: rgba(115,115,115,0.4); border-radius: 4px; }
  html::-webkit-scrollbar-thumb:hover, body::-webkit-scrollbar-thumb:hover,
  *::-webkit-scrollbar-thumb:hover { background: rgba(115,115,115,0.6); }
</style>`;

/** Render the injected token subset for one theme as `--name:value;` declarations. */
function themeDecls(theme: PreviewTheme): string {
  return PREVIEW_THEME_TOKENS.map((t) => `${t.name}:${t[theme]}`).join(';');
}

/**
 * The theme `<style>` injected into every preview `srcDoc`. Carries OK's
 * design tokens for BOTH themes — `:root` (light) and `:root.dark` (dark) —
 * so embedded `html preview` content can reference `var(--chart-1)`,
 * `var(--foreground)`, … and track the reader's theme. `color-scheme` lets
 * native iframe controls / scrollbars / form widgets honor dark mode;
 * the `body` defaults give a from-scratch embed a themed surface without
 * hand-styling. An embed that sets its own `body` background still wins —
 * the user `<style>` comes later in source order.
 */
function themeTokenStyle(): string {
  return `<style>
:root{${themeDecls('light')};color-scheme:light}
:root.dark{${themeDecls('dark')};color-scheme:dark}
body{background:var(--background);color:var(--foreground)}
</style>`;
}

/**
 * The inline bootstrap `<script>` injected into every preview `srcDoc`. It
 * does two things:
 *
 *   1. Theme — sets the initial theme class (flash-free first paint — baked
 *      from the reader's resolved theme, never `prefers-color-scheme`) and
 *      listens for the parent's `postMessage` so a theme toggle re-skins the
 *      live iframe with no reload. The listener honors only the parent window
 *      (`e.source !== parent` is dropped) — an embed's own script cannot spoof
 *      a theme flip.
 *   2. Auto-height — reports its rendered content height back to the parent
 *      (`postMessage`) on load and whenever the body resizes, so the NodeView
 *      can fit the iframe to its content instead of a fixed default.
 *
 * Both channels are non-network `postMessage` traffic; `script-src
 * 'unsafe-inline'` permits the inline script — no special handling. The height
 * read is `body`-box-based (not `documentElement`), so it reflects the
 * content's natural height and lets the iframe shrink, not just grow.
 */
function previewBootstrapScript(theme: PreviewTheme): string {
  const initialClass = theme === 'dark' ? "d.classList.add('dark');" : '';
  return (
    `<script>(function(){` +
    `var d=document.documentElement;${initialClass}` +
    `addEventListener('message',function(e){` +
    `if(e.source!==parent)return;` +
    `var t=e&&e.data&&e.data.${PREVIEW_THEME_MESSAGE_KEY};` +
    `if(t==='dark'){d.classList.add('dark');}` +
    `else if(t==='light'){d.classList.remove('dark');}` +
    `});` +
    `var raf;` +
    `function report(){` +
    `var b=document.body;if(!b)return;` +
    `var r=b.getBoundingClientRect();` +
    `var mb=parseFloat(getComputedStyle(b).marginBottom)||0;` +
    `parent.postMessage({${PREVIEW_HEIGHT_MESSAGE_KEY}:Math.ceil(r.bottom+mb)},'*');` +
    `}` +
    `function schedule(){if(raf){cancelAnimationFrame(raf);}raf=requestAnimationFrame(report);}` +
    `function init(){` +
    `schedule();addEventListener('load',schedule);` +
    `if(window.ResizeObserver){try{new ResizeObserver(schedule).observe(document.body);}catch(_e){}}` +
    `}` +
    `if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}` +
    `else{init();}` +
    // CSP-violation reporting: the policy (or the host's own security layer)
    // drops blocked requests silently and the reader can't see the iframe
    // console — least of all in the desktop preview browser. Collect the
    // blocked requests, dedupe + bound them, and debounce one coalesced report
    // to the parent so the NodeView can surface a notice. `parent.postMessage`
    // is same-frame-tree (not network), so the CSP never blocks the report.
    `var cspSeen=new Set();var cspList=[];var cspTrunc=false;var cspTimer;` +
    `function cspFlush(){parent.postMessage({${PREVIEW_CSP_VIOLATION_MESSAGE_KEY}:{blocked:cspList.slice(),truncated:cspTrunc}},'*');}` +
    `addEventListener('securitypolicyviolation',function(e){` +
    // Once the cap is hit and truncation flagged, ignore every later violation:
    // one report already says "capped, and more were blocked", so this bounds
    // the dedupe Set and stops the reschedule loop under a pathological embed
    // that mints unique blocked URIs without end.
    `if(cspTrunc)return;` +
    `var dir=(e&&(e.effectiveDirective||e.violatedDirective))||'';` +
    `var uri=(e&&e.blockedURI)||'';` +
    `var k=dir+' '+uri;` +
    `if(cspSeen.has(k))return;cspSeen.add(k);` +
    `if(cspList.length<${PREVIEW_CSP_VIOLATION_SAMPLE_CAP}){cspList.push({directive:dir,uri:uri});}else{cspTrunc=true;}` +
    `if(cspTimer){clearTimeout(cspTimer);}cspTimer=setTimeout(cspFlush,250);` +
    `});` +
    `})();</script>`
  );
}

/**
 * The preview iframe's Content Security Policy. The preview runs author- and
 * agent-supplied HTML/JS, and the iframe is `sandbox="allow-scripts"` with NO
 * `allow-same-origin` — a null origin, so a preview script can never read the
 * knowledge base, cookies, the auth token, or the parent DOM. The CSP governs
 * only the iframe's NETWORK surface, and we keep it open so embeds that need
 * external resources (Leaflet maps + tiles, live-data `fetch`, web fonts,
 * third-party iframes, media) render:
 *
 *   - `script`/`style`/`img`/`font`/`connect`/`media`/`frame` open to the
 *     `https:`/`wss:`/`data:`/`blob:` scheme-sources. `https:`/`wss:` force
 *     TLS; we never use `*` or a bare `http:`/`ws:`, so plaintext is excluded.
 *   - `'unsafe-eval'` is deliberately NOT granted — the common embed libraries
 *     (Chart.js, Leaflet, Plotly, and similar) don't need it, and it is a real
 *     `eval()`/`new Function()` XSS-amplification vector.
 *   - `form-action`/`base-uri` stay `'none'`: no embed needs them, and both are
 *     cheap exfil/redirect protections.
 *
 * This is open by design — an embed CAN make arbitrary outbound requests
 * (network exfiltration of data it already holds) and external loads reveal the
 * reader's IP. That is acceptable for OK's local-first model, where you author
 * your own content; a future multi-tenant host that needs to lock this down
 * will do so with an operator/deploy-level control (env / build flag the
 * tenant can't edit), NOT a content-editable config field.
 */
const PREVIEW_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https:; " +
  "style-src 'unsafe-inline' https: data:; " +
  'img-src https: data: blob:; ' +
  'font-src https: data:; ' +
  'connect-src https: wss: data: blob:; ' +
  'media-src https: data: blob:; ' +
  "frame-src https:; child-src https:; form-action 'none'; base-uri 'none';";

/**
 * Build the header injected at the top of every preview iframe's `srcDoc`:
 * the CSP `<meta>` tag, the theme-token `<style>`, the scrollbar `<style>`,
 * and the bootstrap `<script>` (theme + auto-height).
 *
 * `theme` only seeds the initial class baked into the bootstrap script — the
 * CSP and both `<style>` blocks are theme-independent, so the header differs
 * between themes by exactly that one class statement.
 */
export function buildPreviewIframeHeader(theme: PreviewTheme): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
${themeTokenStyle()}
${PREVIEW_SCROLLBAR_STYLE}
${previewBootstrapScript(theme)}`;
}
