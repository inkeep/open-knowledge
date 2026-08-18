/**
 * Editor for a standalone Excalidraw canvas doc (`.excalidraw`). The canvas
 * state serialises to the doc's `Y.Text('source')` as an Excalidraw JSON
 * snapshot (via the package's own `serializeAsJSON` / `restore`, so the on-
 * disk bytes are a real `.excalidraw` document — round-trips through
 * excalidraw.com, the desktop app, the Obsidian plugin, and the VS Code
 * extension). Peers see the same board on every reconnect and the CRDT
 * undo history stays coherent.
 *
 * Field discipline is delegated to Excalidraw itself: `serializeAsJSON`
 * strips every `appState` field marked `export: false` in its schema
 * (theme, cursor position, active tool, selection, zoom, …), so per-peer
 * preferences never bleed into the shared doc.
 */
import { CaptureUpdateAction, Excalidraw, restore, serializeAsJSON } from '@excalidraw/excalidraw';
// Excalidraw ships its layout + toolbar CSS as a separate entry — without
// this import the `.excalidraw-container` chrome renders as unstyled DOM
// (toolbar labels flow inline, the whole app icon fills the viewport).
import '@excalidraw/excalidraw/index.css';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useLingui } from '@lingui/react/macro';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { replaceYText } from './MermaidDocEditor';

// Extend `Window` locally so setting `EXCALIDRAW_ASSET_PATH` doesn't require
// a global `any` cast (and doesn't leak Excalidraw's package-private symbol
// into every other consumer of `Window`).
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

// Point Excalidraw at the self-hosted asset tree vendored in via
// `scripts/copy-excalidraw-assets.mjs` (runs on `predev`/`prebuild`).
// Without this, the package falls back to its hardcoded
// `https://esm.sh/@excalidraw/excalidraw@<v>/dist/prod/` URL for every font
// file (`createUrls` in the published `chunk-K2UTITRG.js`) — a posture
// change for a local-first editor: offline users get system-font fallbacks,
// and every online render ships a request to a third-party CDN we do not
// otherwise depend on. Set at module load (before any Excalidraw component
// mounts) so the first canvas render already has the override in place.
if (typeof window !== 'undefined' && window.EXCALIDRAW_ASSET_PATH === undefined) {
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';
}

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0];
type RestoreResult = {
  elements: ReturnType<typeof restore>['elements'];
  appState: ReturnType<typeof restore>['appState'];
  files: ReturnType<typeof restore>['files'];
};

/**
 * Discriminated result so callers can tell "genuinely empty" from "we got
 * bytes but couldn't parse them" — the first is normal (new doc, blank
 * board), the second is a symptom (disk corruption, half-written file,
 * peer version drift) and needs a log so a diverging session leaves a
 * diagnostic trail. `restore(null, null, null)` produces a blank scene in
 * both branches so mount / sync never crashes on bad input.
 */
type ParseOutcome = { ok: true; scene: RestoreResult } | { ok: false; scene: RestoreResult };

function parseSnapshot(str: string): ParseOutcome {
  if (str.trim() === '') return { ok: true, scene: restore(null, null, null) };
  try {
    const parsed: unknown = JSON.parse(str);
    // `restore` accepts anything shaped like `{ elements?, appState?, files? }`
    // and coerces / repairs it into a valid Excalidraw scene.
    return { ok: true, scene: restore(parsed as Parameters<typeof restore>[0], null, null) };
  } catch {
    return { ok: false, scene: restore(null, null, null) };
  }
}

export function ExcalidrawDocEditor({ provider }: { provider: HocuspocusProvider }) {
  const { t } = useLingui();
  const ytext = provider.document.getText('source');
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);

  // Byte-identity guard: our own onChange writes the same string back through
  // the Y.Text observer; without this the observer would push that write
  // straight back into updateScene / addFiles and cause a self-loop. Seeded
  // with the on-mount source string so a byte-identical re-serialization
  // never re-enters the CRDT.
  const lastSavedRef = useRef<string>(ytext.toString());

  // Compute initial data once (not memoized on `ytext`, because React Compiler
  // handles stability — see WARN in root CLAUDE.md). Log a parse failure so a
  // corrupt-on-disk `.excalidraw` file leaves a diagnostic trail before the
  // editor swaps in a blank scene for it.
  const initialOutcome = parseSnapshot(ytext.toString());
  if (!initialOutcome.ok) {
    console.warn(
      "[ExcalidrawDocEditor] initial snapshot could not be parsed — falling back to a blank canvas; the original bytes remain in the doc until the user draws their first element (appState-only tweaks on an empty canvas don't unblock the guard)",
    );
  }

  // Mount-write suppression after a parse failure. Excalidraw fires an
  // `onChange` synchronously during mount with the parsed scene — which, when
  // parse failed, is the fallback blank scene from `restore(null, null, null)`.
  // That mount-onChange serializes to a fresh canonical Excalidraw JSON string
  // that differs from the corrupt bytes on disk, so the byte-identity guard
  // above does NOT block it, and `replaceYText` would silently overwrite the
  // recoverable-corrupt file with the blank scene before the user has done
  // anything. Gate writes on `elements.length > 0` while this ref is set: any
  // `onChange` that still holds Excalidraw's initial blank scene is dropped,
  // and the first real edit (`elements.length > 0`) unblocks the doc and
  // resumes normal writes. Structural check rather than a serialization pre-
  // compare so we don't have to predict `serializeAsJSON`'s runtime outputs
  // (source URL, defaults, timestamps).
  const blockBlankOverwriteRef = useRef<boolean>(!initialOutcome.ok);

  // Remote update → local scene. Local update → remote is handled in
  // `handleChange` below.
  useEffect(() => {
    if (excalidrawAPI === null) return;
    const sync = () => {
      const str = ytext.toString();
      if (str === lastSavedRef.current) return;
      lastSavedRef.current = str;
      const outcome = parseSnapshot(str);
      if (!outcome.ok) {
        // A remote peer or an external tool wrote something we can't parse.
        // Skip the apply rather than blanking the local canvas — the local
        // state is presumed intact, and there is no upside to overwriting
        // it with our fallback scene. The warn leaves a signal a
        // multi-peer divergence investigation can grep for.
        console.warn(
          '[ExcalidrawDocEditor] sync: remote snapshot could not be parsed — skipping this update',
        );
        return;
      }
      const { elements, appState, files } = outcome.scene;
      // `NEVER`: remote changes are applied silently, without landing on the
      // local undo stack. Otherwise a peer's edit would be undoable from
      // this client, which mangles the redo model — Excalidraw's own collab
      // adapter uses the same value.
      excalidrawAPI.updateScene({
        elements,
        appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      // `files` is a separate API: `updateScene` does not accept it, and
      // `onChange`'s `files` argument on the receiving side is the local
      // (potentially imageless) map — so we have to write the incoming
      // image bytes explicitly or two peers with pasted images will oscillate.
      const fileValues = Object.values(files);
      if (fileValues.length > 0) excalidrawAPI.addFiles(fileValues);
    };
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext, excalidrawAPI]);

  const handleChange: NonNullable<ExcalidrawProps['onChange']> = (elements, appState, files) => {
    // After a parse failure, refuse to persist Excalidraw's initial blank
    // scene — see `blockBlankOverwriteRef` above. Any onChange holding
    // `elements.length === 0` while the ref is set is either the mount-time
    // call or a still-blank subsequent tick; drop it. The first real edit
    // (elements.length > 0) unblocks the ref and lets normal writes resume,
    // finally clearing the corrupt bytes on disk.
    if (blockBlankOverwriteRef.current) {
      if (elements.length === 0) return;
      blockBlankOverwriteRef.current = false;
    }
    // `serializeAsJSON` produces the canonical `.excalidraw` doc shape:
    // `{ type: 'excalidraw', version: 2, source, elements, appState, files }`.
    // It strips every `appState` field marked `export: false` in the schema
    // (theme, selection, cursor, zoom, …) so a peer's local viewer state
    // never bleeds into the shared file. `'local'` opts into the file-tagged
    // source string; `'database'` is for remote-DB round-trips.
    const str = serializeAsJSON(elements, appState, files, 'local');
    if (str === lastSavedRef.current) return;
    lastSavedRef.current = str;
    replaceYText(ytext, str);
  };

  return (
    <main
      className="relative flex h-full min-h-0 flex-col bg-background"
      aria-label={t`Excalidraw canvas`}
      data-excalidraw-doc-editor=""
    >
      <div className="absolute inset-0 z-0">
        <Excalidraw
          excalidrawAPI={setExcalidrawAPI}
          initialData={initialOutcome.scene}
          onChange={handleChange}
        />
      </div>
    </main>
  );
}
