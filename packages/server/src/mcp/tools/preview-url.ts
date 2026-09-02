import { resolveLockDir } from '../../config/paths.ts';
import { lockBaseUrl } from '../../process-lock.ts';
import { lockAdvertisesUi, readServerLock } from '../../server-lock.ts';
import type { ConfigOrResolver } from './shared.ts';

export const PREVIEW_URL_SOURCES = ['lock'] as const;
export type PreviewUrlSource = (typeof PREVIEW_URL_SOURCES)[number];

interface PreviewUrlResult {
  url: string;
  source: PreviewUrlSource;
}

export interface PreviewUrlContext {
  lockDir: string;
}

export interface PreviewUrlDeps {
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

export function encodeDocName(docName: string): string {
  return docName.split('/').map(encodeURIComponent).join('/');
}

export function encodeFolderRoute(folder: string): string {
  const normalized = folder.replace(/^\/+|\/+$/g, '');
  return normalized ? `${encodeDocName(normalized)}/` : '';
}

export function encodeSkillRoute(scope: string, name: string): string {
  return `__skill__/${scope}/${encodeDocName(name)}`;
}

type PreviewAttachWarning =
  | {
      action: 'attach-preview-once';
      previewUrl: string;
      message: string;
      autoOpen: boolean;
    }
  | {
      action: 'start-ui';
      previewUrl: null;
      message: string;
      autoOpen: boolean;
    };

const START_UI_MESSAGE =
  'No UI is running for this project. Start one to see the preview: `ok start` (terminal), or open the project in OK Electron.';
const ATTACH_PREVIEW_ONCE_MESSAGE =
  "No browser is attached to the preview. Open it in your host's surface: `preview_url`, then drive your in-app browser (Claude Code Desktop: `preview_start({url})` to open the pane, then `navigate({url})` to move; Cursor: `Navigate`; Codex desktop: `@Browser`); on a stdio CLI with no browser, `ok open <doc>`.";

export function buildPreviewAttachWarning(
  preview: { url: string } | null,
  autoOpen: boolean,
): PreviewAttachWarning {
  if (preview) {
    return {
      action: 'attach-preview-once',
      previewUrl: preview.url,
      message: ATTACH_PREVIEW_ONCE_MESSAGE,
      autoOpen,
    };
  }
  return {
    action: 'start-ui',
    previewUrl: null,
    message: START_UI_MESSAGE,
    autoOpen,
  };
}

export const START_UI_TEXT_HINT = START_UI_MESSAGE;

export async function resolvePreviewUrlForTool(
  docName: string,
  deps: PreviewUrlDeps,
  cwd?: string,
): Promise<PreviewUrlResult | null> {
  const effectiveCwd = cwd ?? (await deps.resolveCwd());
  const lockDir = resolveLockDir(effectiveCwd);
  return resolvePreviewUrl(docName, { lockDir });
}

export interface UiInfo {
  baseUrl: string | null;
}

export function resolveUiInfo(ctx: PreviewUrlContext): UiInfo {
  try {
    const serverLock = readServerLock(ctx.lockDir);
    if (serverLock && serverLock.draining !== true && lockAdvertisesUi(serverLock)) {
      const baseUrl = lockBaseUrl(serverLock);
      if (baseUrl !== null) return { baseUrl };
    }
  } catch (err) {
    process.stderr.write(
      `[preview-url] readServerLock failed at ${ctx.lockDir} while resolving ui info: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return { baseUrl: null };
}

export async function awaitUiBaseUrl(
  ctx: PreviewUrlContext,
  opts: { timeoutMs: number; pollIntervalMs: number },
): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    const { baseUrl } = resolveUiInfo(ctx);
    if (baseUrl !== null) return baseUrl;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, opts.pollIntervalMs));
  }
}

export async function buildListResolver(
  deps: PreviewUrlDeps,
  cwd?: string,
): Promise<{ resolve(docName: string): PreviewUrlResult | null }> {
  const effectiveCwd = cwd ?? (await deps.resolveCwd());
  const lockDir = resolveLockDir(effectiveCwd);
  const ctx: PreviewUrlContext = { lockDir };
  return {
    resolve: (docName: string) => resolvePreviewUrl(docName, ctx),
  };
}

export function docNameFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return path.slice(0, -3);
  if (lower.endsWith('.mdx')) return path.slice(0, -4);
  return path;
}

export function resolvePreviewUrl(
  docName: string,
  ctx: PreviewUrlContext,
): PreviewUrlResult | null {
  return previewForRoute(`/#/${encodeDocName(docName)}`, ctx);
}

export function resolveSkillPreviewUrl(
  scope: string,
  name: string,
  ctx: PreviewUrlContext,
): PreviewUrlResult | null {
  return previewForRoute(`/#/${encodeSkillRoute(scope, name)}`, ctx);
}

function previewForRoute(hash: string, ctx: PreviewUrlContext): PreviewUrlResult | null {
  const { baseUrl } = resolveUiInfo(ctx);
  if (baseUrl !== null) return { url: hash, source: 'lock' };
  return null;
}
