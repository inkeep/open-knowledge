import { ChunkedInsertError, HtmlPayloadTooLargeError } from '@inkeep/open-knowledge-core';
import type { UrlPortabilityReason } from './clipboard-sanitize.ts';
import type { ClipboardSource } from './detect-source.ts';


type ClipboardEventName =
  | 'clipboard-slow-op'
  | 'clipboard-source-detected'
  | 'clipboard-html-conversion-failed'
  | 'clipboard-serialize-failed'
  | 'clipboard-chunked-insert-failed'
  | 'clipboard-hast-override-invoked'
  | 'clipboard-walker-fallback-fired'
  | 'clipboard-walker-url-blocked'
  | 'clipboard-walker-unmapped-lucide-detected'
  | 'clipboard-walker-url-source-emitted'
  | 'clipboard-walker-non-portable-render-source-emitted'
  | 'clipboard-walker-url-classifier-failed';

type ClipboardView = 'wysiwyg' | 'source';

type ClipboardOp = 'copy' | 'cut' | 'paste' | 'drop';

export type ClipboardBranch =
  | 'A'
  | 'B-wrapper'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'shift'
  | 'codeblock'
  | 'serialize';

type ClipboardStage =
  | 'htmlToMdast'
  | 'mdastToMarkdown'
  | 'mdManagerParse'
  | 'applyJsonSlice'
  | 'branchA'
  | 'chunkedYTextInsert';

type SerializeKind = 'text' | 'html';

interface ClipboardTiming {
  op: ClipboardOp;
  view: ClipboardView;
  branch: ClipboardBranch;
  source: ClipboardSource;
  htmlBytes?: number;
}

interface ClipboardLogEvent {
  op?: ClipboardOp;
  view: ClipboardView;
  branch: ClipboardBranch;
  source: ClipboardSource;
}

interface ConversionFailInfo {
  view: ClipboardView;
  stage: ClipboardStage;
  source: ClipboardSource;
  branch?: ClipboardBranch;
  reason: string;
  errorClass?: string;
  htmlBytes?: number;
}

interface SerializeFailInfo {
  view: ClipboardView;
  kind: SerializeKind;
  reason: string;
}

interface ChunkedInsertFailInfo {
  view: ClipboardView;
  chunksCompleted: number;
  totalChunks: number;
  bytesWritten: number;
  bytesRemaining: number;
  reason: string;
}

const SLOW_PASTE_MS = 250;
const SLOW_COPY_MS = 100;

export function logIfSlow(start: number, timing: ClipboardTiming): void {
  const elapsed = performance.now() - start;
  const threshold = timing.op === 'paste' || timing.op === 'drop' ? SLOW_PASTE_MS : SLOW_COPY_MS;
  if (elapsed < threshold) return;
  console.warn(
    JSON.stringify({
      event: 'clipboard-slow-op' satisfies ClipboardEventName,
      op: timing.op,
      view: timing.view,
      elapsedMs: Math.round(elapsed),
      branch: timing.branch,
      source: timing.source,
      ...(timing.htmlBytes != null ? { htmlBytes: timing.htmlBytes } : {}),
    }),
  );
}

export function logSourceDetected(ev: ClipboardLogEvent): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-source-detected' satisfies ClipboardEventName,
      view: ev.view,
      source: ev.source,
      branch: ev.branch,
    }),
  );
}

export function logConversionFail(info: ConversionFailInfo): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-html-conversion-failed' satisfies ClipboardEventName,
      view: info.view,
      stage: info.stage,
      source: info.source,
      ...(info.branch != null ? { branch: info.branch } : {}),
      reason: info.reason,
      ...(info.errorClass != null ? { errorClass: info.errorClass } : {}),
      ...(info.htmlBytes != null ? { htmlBytes: info.htmlBytes } : {}),
    }),
  );
}

export function logSerializeFail(info: SerializeFailInfo): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-serialize-failed' satisfies ClipboardEventName,
      view: info.view,
      kind: info.kind,
      reason: info.reason,
    }),
  );
}

export function logWalkerFallback(info: { descriptor: string; view: ClipboardView }): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-fallback-fired' satisfies ClipboardEventName,
      descriptor: info.descriptor,
      view: info.view,
    }),
  );
}

export function logNonPortableRenderSourceEmitted(info: {
  descriptor: string;
  view: ClipboardView;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-non-portable-render-source-emitted' satisfies ClipboardEventName,
      descriptor: info.descriptor,
      view: info.view,
    }),
  );
}

type WalkerUrlBlockedReason =
  | 'scheme'
  | 'srcset-candidate'
  | 'embedded-url'
  | 'event-handler'
  | 'unsafe-url-or-expression';

export function logWalkerUrlBlocked(info: {
  attr: string;
  reason: WalkerUrlBlockedReason;
  view: ClipboardView;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-url-blocked' satisfies ClipboardEventName,
      view: info.view,
      attr: info.attr,
      reason: info.reason,
    }),
  );
}

export type WalkerUrlSourceTag = 'img' | 'video' | 'audio' | 'source' | 'a' | 'picture';

export type WalkerUrlSourceClass = 'mdx-component' | 'mdx-inline';

type WalkerUrlClassifierFailedPhase = 'classifier-throw' | 'serializer-null' | 'serializer-throw';

export function logWalkerUrlSourceEmitted(info: {
  view: ClipboardView;
  tag: WalkerUrlSourceTag;
  class: WalkerUrlSourceClass;
  reason: UrlPortabilityReason;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-url-source-emitted' satisfies ClipboardEventName,
      view: info.view,
      tag: info.tag,
      class: info.class,
      reason: info.reason,
    }),
  );
}

export function logWalkerUrlClassifierFailed(info: {
  view: ClipboardView;
  tag: WalkerUrlSourceTag;
  phase: WalkerUrlClassifierFailedPhase;
  errorClass?: string;
}): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-url-classifier-failed' satisfies ClipboardEventName,
      view: info.view,
      tag: info.tag,
      phase: info.phase,
      ...(info.errorClass != null ? { errorClass: info.errorClass } : {}),
    }),
  );
}

const unmappedLucideSeen = new Set<string>();
export function logUnmappedLucideIcon(info: { lucideClass: string; view: ClipboardView }): void {
  if (unmappedLucideSeen.has(info.lucideClass)) return;
  unmappedLucideSeen.add(info.lucideClass);
  console.warn(
    JSON.stringify({
      event: 'clipboard-walker-unmapped-lucide-detected' satisfies ClipboardEventName,
      view: info.view,
      lucideClass: info.lucideClass,
    }),
  );
}

export function resetUnmappedLucideSeenForTest(): void {
  unmappedLucideSeen.clear();
}

export function logChunkedInsertFail(info: ChunkedInsertFailInfo): void {
  console.warn(
    JSON.stringify({
      event: 'clipboard-chunked-insert-failed' satisfies ClipboardEventName,
      view: info.view,
      chunksCompleted: info.chunksCompleted,
      totalChunks: info.totalChunks,
      bytesWritten: info.bytesWritten,
      bytesRemaining: info.bytesRemaining,
      reason: info.reason,
    }),
  );
}

export function classifyError(err: unknown): string | undefined {
  if (err instanceof HtmlPayloadTooLargeError) return 'HtmlPayloadTooLargeError';
  if (err instanceof ChunkedInsertError) return 'ChunkedInsertError';
  if (err instanceof Error && err.name && err.name !== 'Error') return err.name;
  return undefined;
}
