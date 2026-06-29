
const CREATE_TOP_LEVEL_FILE_EVENT = 'open-knowledge:create-top-level-file';

export interface CreateFileRequest {
  initialDir?: string;
  template?: { folder: string; name: string };
}

export function emitCreateTopLevelFile(detail: CreateFileRequest = {}): void {
  window.dispatchEvent(new CustomEvent<CreateFileRequest>(CREATE_TOP_LEVEL_FILE_EVENT, { detail }));
}

export function subscribeToCreateTopLevelFile(
  onRequest: (request: CreateFileRequest) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<CreateFileRequest | undefined>).detail;
    onRequest(detail ?? {});
  };
  window.addEventListener(CREATE_TOP_LEVEL_FILE_EVENT, listener);
  return () => window.removeEventListener(CREATE_TOP_LEVEL_FILE_EVENT, listener);
}
