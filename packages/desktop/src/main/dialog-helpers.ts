import { isAbsolute } from 'node:path';
import { getLogger } from './desktop-logger.ts';

type OpenDialogOptions = Parameters<DialogLike['showOpenDialog']>[0];

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
  showErrorBox(title: string, content: string): void;
}

const NO_SELECTION_COPY = {
  folder: {
    title: 'Couldn\u2019t open that folder',
    body: 'The folder picker closed without choosing a folder. Try again, and select the folder in the list instead of typing its path.',
  },
  file: {
    title: 'Couldn\u2019t open that file',
    body: 'The file picker closed without choosing a file. Try again, and select the file in the list instead of typing its path.',
  },
} as const;

function unusablePickShape(picked: string | undefined): 'none' | 'empty' | 'relative' | null {
  if (picked === undefined) return 'none';
  if (picked.length === 0) return 'empty';
  if (!isAbsolute(picked)) return 'relative';
  return null;
}

async function runPicker(
  dialogModule: DialogLike,
  target: keyof typeof NO_SELECTION_COPY,
  options: OpenDialogOptions,
): Promise<string | null> {
  const log = getLogger('dialog');
  let result: Awaited<ReturnType<DialogLike['showOpenDialog']>>;
  try {
    result = await dialogModule.showOpenDialog(options);
  } catch (err) {
    log.error({ outcome: 'failed', target, err }, 'picker failed to open');
    throw err;
  }
  if (result.canceled) {
    log.info({ outcome: 'canceled', target }, 'picker closed');
    return null;
  }
  const picked = result.filePaths[0];
  const unusable = unusablePickShape(picked);
  if (unusable !== null) {
    log.warn(
      { outcome: 'no-selection', target, shape: unusable, count: result.filePaths.length },
      'picker returned no usable path',
    );
    const copy = NO_SELECTION_COPY[target];
    dialogModule.showErrorBox(copy.title, copy.body);
    return null;
  }
  return picked;
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
  return runPicker(dialogModule, 'folder', {
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
  });
}

export async function promptForExistingMarkdownFile(
  dialogModule: DialogLike,
  opts: PromptForPickerOpts = {},
): Promise<string | null> {
  const testSeam = readTestPickedPath();
  if (testSeam !== null) return testSeam;
  return runPicker(dialogModule, 'file', {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'mdx'] }],
    ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
  });
}
