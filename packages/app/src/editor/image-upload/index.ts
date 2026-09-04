import {
  AUDIO_EXTENSIONS,
  DEFAULT_DEDUP_UI,
  DEFAULT_EMIT_FORMAT,
  extensionOf,
  FILE_ATTACHMENT_EXTENSIONS,
  formatFileSize,
  IMAGE_EXTENSIONS,
  ProblemDetailsSchema,
  randomUUID,
  type UploadAssetSuccess,
  UploadAssetSuccessSchema,
  VIDEO_EXTENSIONS,
  WIKI_EMBED_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import type { Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { toast } from 'sonner';
import { getEditorDocName } from '../extensions/doc-context.ts';
import { buildUnresolvedWikiLinkAttrs } from '../extensions/wiki-link-helpers.ts';
import { HttpResponseParseError } from '../http-client.ts';
import { reportUploadFailure, type UploadFailureReport } from './upload-failure.ts';

const uploadPluginKey = new PluginKey<UploadPluginState>('imageUpload');

interface UploadPluginState {
  decorations: DecorationSet;
  uploads: Map<string, number>;
}

function createSkeletonWidget(file?: File): HTMLElement {
  const el = document.createElement('div');
  el.className =
    'image-upload-skeleton w-full h-40 rounded-md bg-muted animate-pulse motion-reduce:animate-none my-2';
  el.setAttribute('data-upload-widget', 'loading');
  el.setAttribute('role', 'status');
  const fileName = file?.name;
  el.setAttribute('aria-label', fileName ? t`Uploading ${fileName}` : t`Uploading file`);
  return el;
}

type UploadMeta =
  | { type: 'add'; id: string; pos: number; widget: HTMLElement }
  | { type: 'remove'; id: string };

export const uploadDecorationPlugin = new Plugin<UploadPluginState>({
  key: uploadPluginKey,

  state: {
    init() {
      return { decorations: DecorationSet.empty, uploads: new Map() };
    },

    apply(tr, prev) {
      const mappedDecorations = prev.decorations.map(tr.mapping, tr.doc);
      const mappedUploads = new Map<string, number>();
      for (const [id, pos] of prev.uploads) {
        mappedUploads.set(id, tr.mapping.map(pos));
      }

      const meta = tr.getMeta(uploadPluginKey) as UploadMeta | undefined;
      if (!meta) {
        return { decorations: mappedDecorations, uploads: mappedUploads };
      }

      if (meta.type === 'add') {
        const deco = Decoration.widget(meta.pos, meta.widget, {
          id: meta.id,
          stopEvent: () => true,
        });
        const newDecorations = mappedDecorations.add(tr.doc, [deco]);
        const newUploads = new Map(mappedUploads);
        newUploads.set(meta.id, tr.mapping.map(meta.pos));
        return { decorations: newDecorations, uploads: newUploads };
      }

      if (meta.type === 'remove') {
        const toRemove = mappedDecorations.find(
          undefined,
          undefined,
          (spec) => spec.id === meta.id,
        );
        const newDecorations = mappedDecorations.remove(toRemove);
        const newUploads = new Map(mappedUploads);
        newUploads.delete(meta.id);
        return { decorations: newDecorations, uploads: newUploads };
      }

      return { decorations: mappedDecorations, uploads: mappedUploads };
    },
  },

  props: {
    decorations(state) {
      return uploadPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
    },
  },
});

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function splitSegments(p: string): string[] {
  return p.split('/').filter((s) => s !== '');
}

export function shortestImageRef(assetPath: string, mdPath: string): string {
  const assetDir = parentDir(assetPath);
  const mdDir = parentDir(mdPath);
  const assetName = basename(assetPath);
  if (assetDir === mdDir) return assetName;

  const fromParts = splitSegments(mdDir);
  const toParts = splitSegments(assetDir);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  if (ups === 0) {
    return `./${[...downs, assetName].join('/')}`;
  }
  return [...new Array(ups).fill('..'), ...downs, assetName].join('/');
}

function docNameFromEditor(editor: Editor): string | null {
  return getEditorDocName(editor);
}

interface InsertShape {
  kind:
    | 'wikiembed'
    | 'jsx-img'
    | 'jsx-video'
    | 'jsx-audio'
    | 'jsx-file'
    | 'markdown-link'
    | 'wiki-link';
  ext: string;
}

export function buildMediaJsxNodeData(
  kind: 'jsx-img' | 'jsx-video' | 'jsx-audio',
  resolvedSrc: string,
): {
  type: 'jsxComponent';
  attrs: {
    componentName: 'img' | 'video' | 'audio';
    kind: 'element';
    attributes: never[];
    sourceRaw: '';
    sourceDirty: true;
    props: Record<string, unknown>;
  };
} {
  const componentName = kind === 'jsx-img' ? 'img' : kind === 'jsx-video' ? 'video' : 'audio';
  const props: Record<string, unknown> =
    kind === 'jsx-img' ? { src: resolvedSrc } : { src: resolvedSrc, controls: true };
  return {
    type: 'jsxComponent',
    attrs: {
      componentName,
      kind: 'element',
      attributes: [],
      sourceRaw: '',
      sourceDirty: true,
      props,
    },
  };
}

export function pickInsertShape(filename: string): InsertShape {
  const ext = extensionOf(filename);
  if (ext === 'md' || ext === 'mdx') {
    return { kind: 'wiki-link', ext };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { kind: 'jsx-img', ext };
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return { kind: 'jsx-video', ext };
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return { kind: 'jsx-audio', ext };
  }
  if (FILE_ATTACHMENT_EXTENSIONS.has(ext)) {
    return { kind: 'jsx-file', ext };
  }
  if (WIKI_EMBED_EXTENSIONS.has(ext)) {
    if (DEFAULT_EMIT_FORMAT === 'wikiembed') return { kind: 'wikiembed', ext };
    return { kind: 'markdown-link', ext };
  }
  return { kind: 'markdown-link', ext };
}

export async function uploadAndInsert(
  file: File,
  editor: Editor,
  insertPos: number,
): Promise<void> {
  const docName = docNameFromEditor(editor);
  const parentDocName = docName ? `${docName}.md` : '';
  if (!parentDocName) {
    toast.error(t`Cannot upload: no document is open`);
    return;
  }
  const uploadId = randomUUID();
  const sizeAtDrop = file.size;

  const skeletonWidget = createSkeletonWidget(file);
  editor.view.dispatch(
    editor.state.tr.setMeta(uploadPluginKey, {
      type: 'add',
      id: uploadId,
      pos: insertPos,
      widget: skeletonWidget,
    }),
  );

  const formData = new FormData();
  formData.append('file', file);
  formData.append('parentDocName', parentDocName);

  let res: Response;
  try {
    res = await fetch('/api/upload', { method: 'POST', body: formData });
  } catch (networkError) {
    let report: UploadFailureReport | undefined;
    try {
      report = await reportUploadFailure({ file, sizeAtDrop, error: networkError });
    } catch (reportError) {
      console.error('[uploadAndInsert] upload failed, and diagnosing it failed too', {
        docName: parentDocName,
        networkError,
        reportError,
      });
    }
    if (report) {
      console.error('[uploadAndInsert] upload failed before reaching the server', {
        ...report.log,
        docName: parentDocName,
      });
    }
    showError(editor, uploadId, report?.message);
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await res.json();
  } catch (parseError) {
    console.error('[uploadAndInsert] Response is not JSON:', parseError);
    showError(editor, uploadId);
    return;
  }

  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(rawBody);
    if (!problem.success) {
      const cause = new HttpResponseParseError('Upload response did not match ProblemDetails.', {
        cause: problem.error,
        status: res.status,
      });
      console.error('[uploadAndInsert] Server error (unparseable):', cause);
      showError(editor, uploadId);
      return;
    }
    console.error('[uploadAndInsert] Server error:', problem.data);
    showError(editor, uploadId, problem.data.title);
    return;
  }

  const success = UploadAssetSuccessSchema.safeParse(rawBody);
  if (!success.success) {
    const cause = new HttpResponseParseError(
      'Upload success response did not match UploadAssetSuccess.',
      {
        cause: success.error,
        status: res.status,
      },
    );
    console.error('[uploadAndInsert] Response missing src:', cause);
    showError(editor, uploadId);
    return;
  }
  const body: UploadAssetSuccess = success.data;
  const src = body.src;
  const deduped = body.deduped === true;
  const parentDocDir = parentDir(parentDocName);
  const assetContentPath =
    typeof body.path === 'string' && body.path.length > 0
      ? body.path
      : parentDocDir
        ? `${parentDocDir}/${src}`
        : src;

  if (deduped && DEFAULT_DEDUP_UI !== 'silent') {
    toast.info(t`Already at ${assetContentPath} — reusing.`);
  }

  const shape = pickInsertShape(file.name);

  const { state } = editor;
  const pluginState = uploadPluginKey.getState(state);
  const mappedPos = pluginState?.uploads.get(uploadId) ?? insertPos;

  const tr = state.tr.setMeta(uploadPluginKey, { type: 'remove', id: uploadId });

  const relPath = shortestImageRef(assetContentPath, parentDocName);

  const resolvedSrc = `/${assetContentPath}`;

  if (shape.kind === 'jsx-file') {
    const jsxNode = state.schema.nodes.jsxComponent;
    if (!jsxNode) {
      console.error('[uploadAndInsert] jsxComponent node missing from schema');
      showError(editor, uploadId);
      return;
    }
    const fileNodeData = {
      type: 'jsxComponent' as const,
      attrs: {
        componentName: 'WikiEmbedFile',
        kind: 'element' as const,
        attributes: [],
        sourceRaw: '',
        sourceDirty: true,
        props: {
          src: resolvedSrc,
          target: src,
          alias: null,
          anchor: null,
          size: formatFileSize(file.size),
        },
      },
    };
    editor
      .chain()
      .command(({ tr: chainTr }) => {
        chainTr.setMeta(uploadPluginKey, { type: 'remove', id: uploadId });
        return true;
      })
      .focus()
      .insertContentAt(mappedPos, fileNodeData)
      .command(({ tr: chainTr, dispatch }) => {
        if (!dispatch) return true;
        const realPos = chainTr.mapping.map(mappedPos);
        const inserted = chainTr.doc.nodeAt(realPos);
        if (inserted?.type.name === 'jsxComponent') {
          chainTr.setSelection(NodeSelection.create(chainTr.doc, realPos));
        }
        return true;
      })
      .run();
    return;
  }

  if (shape.kind === 'jsx-img' || shape.kind === 'jsx-video' || shape.kind === 'jsx-audio') {
    const jsxNode = state.schema.nodes.jsxComponent;
    if (!jsxNode) {
      console.error('[uploadAndInsert] jsxComponent node missing from schema');
      showError(editor, uploadId);
      return;
    }
    const childData = buildMediaJsxNodeData(shape.kind, resolvedSrc);

    editor
      .chain()
      .command(({ tr: chainTr }) => {
        chainTr.setMeta(uploadPluginKey, { type: 'remove', id: uploadId });
        return true;
      })
      .focus()
      .insertContentAt(mappedPos, childData)
      .command(({ tr: chainTr, dispatch }) => {
        if (!dispatch) return true;
        const realPos = chainTr.mapping.map(mappedPos);
        const inserted = chainTr.doc.nodeAt(realPos);
        if (inserted?.type.name === 'jsxComponent') {
          chainTr.setSelection(NodeSelection.create(chainTr.doc, realPos));
        }
        return true;
      })
      .run();
    return;
  }

  if (shape.kind === 'wikiembed') {
    const node = state.schema.nodes.wikiLinkEmbed;
    if (!node) {
      console.error('[uploadAndInsert] wikiLinkEmbed node missing from schema');
      showError(editor, uploadId);
      return;
    }
    tr.insert(mappedPos, node.create({ target: src, alias: null, anchor: null, resolvedSrc }));
  } else if (shape.kind === 'wiki-link') {
    const wikiLinkNode = state.schema.nodes.wikiLink;
    if (!wikiLinkNode) {
      console.error('[uploadAndInsert] wikiLink node missing from schema');
      showError(editor, uploadId);
      return;
    }
    const basename = file.name.replace(/\.(md|mdx)$/i, '');
    const attrs = buildUnresolvedWikiLinkAttrs(basename);
    if (!attrs) {
      tr.insert(mappedPos, state.schema.text(file.name));
    } else {
      tr.insert(mappedPos, wikiLinkNode.create(attrs));
    }
  } else {
    const linkMark = state.schema.marks.link;
    if (linkMark) {
      const text = state.schema.text(file.name, [linkMark.create({ href: relPath })]);
      tr.insert(mappedPos, text);
    } else {
      tr.insert(mappedPos, state.schema.text(file.name));
    }
  }

  editor.view.dispatch(tr);
}

function showError(editor: Editor, uploadId: string, message?: string): void {
  editor.view.dispatch(editor.state.tr.setMeta(uploadPluginKey, { type: 'remove', id: uploadId }));
  toast.error(message ?? t`Upload failed`);
}
