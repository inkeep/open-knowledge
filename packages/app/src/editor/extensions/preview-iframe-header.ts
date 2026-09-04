import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import {
  domPreviewTokenEnv,
  type PreviewTokenEnv,
  readLivePreviewTokens,
  renderTokenDecls,
} from './preview-live-tokens';

export type PreviewTheme = 'light' | 'dark';

const PREVIEW_THEME_MESSAGE_KEY = 'okPreviewTheme';

const PREVIEW_TOKENS_MESSAGE_KEY = 'okPreviewTokens';

export interface PreviewThemeMessage {
  [PREVIEW_THEME_MESSAGE_KEY]: PreviewTheme;
  [PREVIEW_TOKENS_MESSAGE_KEY]?: Record<string, string>;
}

export function buildPreviewThemeMessage(
  theme: PreviewTheme,
  env: PreviewTokenEnv | null = domPreviewTokenEnv(),
): PreviewThemeMessage {
  const tokens = readLivePreviewTokens(env);
  return tokens
    ? { [PREVIEW_THEME_MESSAGE_KEY]: theme, [PREVIEW_TOKENS_MESSAGE_KEY]: tokens }
    : { [PREVIEW_THEME_MESSAGE_KEY]: theme };
}

const PREVIEW_HEIGHT_MESSAGE_KEY = 'okPreviewHeight';

export function parsePreviewHeightMessage(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const h = (data as Record<string, unknown>)[PREVIEW_HEIGHT_MESSAGE_KEY];
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.ceil(h) : null;
}

const PREVIEW_CSP_VIOLATION_MESSAGE_KEY = 'okPreviewCspViolation';

export interface PreviewBlockedRequest {
  directive: string;
  uri: string;
}

export const PREVIEW_CSP_VIOLATION_SAMPLE_CAP = 20;

export function parsePreviewCspViolationMessage(
  data: unknown,
): { blocked: PreviewBlockedRequest[]; truncated: boolean } | null {
  if (typeof data !== 'object' || data === null) return null;
  const payload = (data as Record<string, unknown>)[PREVIEW_CSP_VIOLATION_MESSAGE_KEY];
  if (typeof payload !== 'object' || payload === null) return null;
  const rawBlocked = (payload as Record<string, unknown>).blocked;
  if (!Array.isArray(rawBlocked)) return null;
  const blocked: PreviewBlockedRequest[] = [];
  for (const item of rawBlocked) {
    if (typeof item !== 'object' || item === null) continue;
    const directive = (item as Record<string, unknown>).directive;
    const uri = (item as Record<string, unknown>).uri;
    if (typeof directive === 'string' && typeof uri === 'string') {
      blocked.push({ directive, uri });
    }
  }
  if (blocked.length === 0) return null;
  return { blocked, truncated: (payload as Record<string, unknown>).truncated === true };
}

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

function themeDecls(theme: PreviewTheme): string {
  return PREVIEW_THEME_TOKENS.map((t) => `${t.name}:${t[theme]}`).join(';');
}

function themeTokenStyle(env: PreviewTokenEnv | null): string {
  const live = readLivePreviewTokens(env);
  const liveBlock =
    live && Object.keys(live).length > 0 ? `\n:root,:root.dark{${renderTokenDecls(live)}}` : '';
  return `<style>
:root{${themeDecls('light')};color-scheme:light}
:root.dark{${themeDecls('dark')};color-scheme:dark}${liveBlock}
body{background:var(--background);color:var(--foreground)}
</style>`;
}

function previewBootstrapScript(theme: PreviewTheme): string {
  const initialClass = theme === 'dark' ? "d.classList.add('dark');" : '';
  return (
    `<script>(function(){` +
    `var d=document.documentElement;${initialClass}` +
    `var applied=[];` +
    `addEventListener('message',function(e){` +
    `if(e.source!==parent)return;` +
    `var t=e&&e.data&&e.data.${PREVIEW_THEME_MESSAGE_KEY};` +
    `if(t==='dark'){d.classList.add('dark');}` +
    `else if(t==='light'){d.classList.remove('dark');}` +
    `var k=e&&e.data&&e.data.${PREVIEW_TOKENS_MESSAGE_KEY};` +
    `if(k){` +
    `for(var i=0;i<applied.length;i++){if(!(applied[i] in k)){try{d.style.removeProperty(applied[i]);}catch(_e){}}}` +
    `applied=[];` +
    `for(var n in k){applied.push(n);try{d.style.setProperty(n,k[n]);}catch(_e){}}` +
    `}` +
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
    `var cspSeen=new Set();var cspList=[];var cspTrunc=false;var cspTimer;` +
    `function cspFlush(){parent.postMessage({${PREVIEW_CSP_VIOLATION_MESSAGE_KEY}:{blocked:cspList.slice(),truncated:cspTrunc}},'*');}` +
    `addEventListener('securitypolicyviolation',function(e){` +
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

const PREVIEW_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https:; " +
  "style-src 'unsafe-inline' https: data:; " +
  'img-src https: data: blob:; ' +
  'font-src https: data:; ' +
  'connect-src https: wss: data: blob:; ' +
  'media-src https: data: blob:; ' +
  "frame-src https:; child-src https:; form-action 'none'; base-uri 'none';";

export function buildPreviewIframeHeader(
  theme: PreviewTheme,
  env: PreviewTokenEnv | null = domPreviewTokenEnv(),
): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
${themeTokenStyle(env)}
${PREVIEW_SCROLLBAR_STYLE}
${previewBootstrapScript(theme)}`;
}
