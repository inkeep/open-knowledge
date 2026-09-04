interface DialogLike {
  showOpenDialog(opts: {
    properties: (
      | 'openDirectory'
      | 'createDirectory'
      | 'openFile'
      | 'multiSelections'
      | 'showHiddenFiles'
    )[];
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface PromptForPickerOpts {
  defaultPath?: string;
}

export function resolvePickedPathForIndex(raw: string, callIndex: number): string | null {
  const sequence = raw.split('\x1f').filter((s) => s.length > 0);
  if (sequence.length === 0) return null;
  const idx = Math.min(callIndex, sequence.length - 1);
  return sequence[idx] ?? null;
}

let testPickedPathCallIndex = 0;

function readTestPickedPath(): string | null {
  if (process.env.OK_DESKTOP_E2E_SMOKE !== '1') return null;
  const raw = process.env.OK_DESKTOP_TEST_PICKED_PATH;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const resolved = resolvePickedPathForIndex(raw, testPickedPathCallIndex);
  if (resolved === null) return null;
  testPickedPathCallIndex += 1;
  return resolved;
}

export async function promptForExistingFolder(
  dialogModule: DialogLike,
  opts: PromptForPickerOpts = {},
): Promise<string | null> {
  const testSeam = readTestPickedPath();
  if (testSeam !== null) return testSeam;
  const result = await dialogModule.showOpenDialog({
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
  });
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

export async function promptForExistingMarkdownFile(
  dialogModule: DialogLike,
  opts: PromptForPickerOpts = {},
): Promise<string | null> {
  const testSeam = readTestPickedPath();
  if (testSeam !== null) return testSeam;
  const result = await dialogModule.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'mdx'] }],
    ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
  });
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}
