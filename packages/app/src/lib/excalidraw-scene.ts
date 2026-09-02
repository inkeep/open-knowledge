type ExcalidrawModule = typeof import('@excalidraw/excalidraw');

export type ExcalidrawScene = {
  elements: ReturnType<ExcalidrawModule['restoreElements']>;
  appState: ReturnType<ExcalidrawModule['restoreAppState']>;
  files: NonNullable<Parameters<ExcalidrawModule['serializeAsJSON']>[2]>;
};

export function restoreScene(mod: ExcalidrawModule, data: unknown): ExcalidrawScene {
  const imported = (data ?? null) as {
    elements?: Parameters<ExcalidrawModule['restoreElements']>[0];
    appState?: Parameters<ExcalidrawModule['restoreAppState']>[0];
    files?: ExcalidrawScene['files'];
  } | null;
  return {
    elements: mod.restoreElements(imported?.elements, null),
    appState: mod.restoreAppState(imported?.appState, null),
    files: imported?.files ?? {},
  };
}

export function serializeScene(
  mod: ExcalidrawModule,
  elements: Parameters<ExcalidrawModule['serializeAsJSON']>[0],
  appState: Parameters<ExcalidrawModule['serializeAsJSON']>[1],
  files: Parameters<ExcalidrawModule['serializeAsJSON']>[2],
): string {
  return mod.serializeAsJSON(mod.getNonDeletedElements(elements), appState, files, 'local');
}
