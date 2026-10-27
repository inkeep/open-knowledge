import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const contentLabelCompartment = new Compartment();

function contentLabelAttributes(label: string) {
  return EditorView.contentAttributes.of({ 'aria-label': label });
}

export function codeMirrorContentAttributes(label: string) {
  return contentLabelCompartment.of(contentLabelAttributes(label));
}

export function relabelCodeMirrorContent(view: EditorView, label: string): void {
  view.dispatch({ effects: contentLabelCompartment.reconfigure(contentLabelAttributes(label)) });
}
