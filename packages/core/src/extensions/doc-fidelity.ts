/**
 * Doc-level source-form fidelity attribute.
 *
 * Declares `sourceDocBoundary` on the `doc` topNode so document-boundary
 * bytes that no block node owns (the head BOM, leading/trailing blank
 * lines, inter-block blank-line counts) survive the programmatic
 * parse → PM → serialize round-trip. The parse pipeline captures the state
 * (`captureDocBoundary` in `markdown/pipeline.ts`) and the serializer
 * replays it (`serializeMd`).
 *
 * The Y.XmlFragment stores only the doc's children, never doc attrs — so
 * the CRDT/WYSIWYG path drops this state by construction and keeps its
 * canonical blank handling (covered by the bridge tolerance set). The attr
 * is a snapshot for the programmatic round-trip, not an editing surface.
 */
import { Extension } from '@tiptap/core';

export const DocFidelity = Extension.create({
  name: 'docFidelity',

  addGlobalAttributes() {
    return [
      {
        types: ['doc'],
        attributes: {
          sourceDocBoundary: { default: null, rendered: false },
        },
      },
    ];
  },
});
