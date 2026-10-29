export const EXCALIDRAW_COPY_SCRIPT = 'copy-excalidraw-assets.mjs';

export const ROUND_READS = {
  test: './copy-excalidraw-assets-concurrency.test.ts',
  reads: 'the Excalidraw asset copy script, which it copies into a scratch package and runs',
  include: [`packages/app/scripts/${EXCALIDRAW_COPY_SCRIPT}`],
};
