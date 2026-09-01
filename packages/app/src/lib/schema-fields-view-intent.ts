type FieldsViewListener = (assetPath: string) => void;

let pendingFieldsView: string | null = null;
const listeners = new Set<FieldsViewListener>();

export function requestSchemaFieldsView(assetPath: string): void {
  pendingFieldsView = assetPath;
  for (const listener of listeners) listener(assetPath);
}

export function consumeSchemaFieldsView(assetPath: string): boolean {
  if (pendingFieldsView !== assetPath) return false;
  pendingFieldsView = null;
  return true;
}

export function subscribeSchemaFieldsView(listener: FieldsViewListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
