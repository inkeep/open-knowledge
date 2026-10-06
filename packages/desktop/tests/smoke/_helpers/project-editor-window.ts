import { realpathSync } from 'node:fs';
import type { ElectronApplication, Page } from '@playwright/test';

function canonicalPathIfPresent(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function findProjectEditorWindow(
  app: ElectronApplication,
  projectDir: string,
): Promise<Page | undefined> {
  const canonicalProjectDir = realpathSync(projectDir);
  for (const page of app.windows()) {
    const editorProjectPath = await page
      .evaluate(() =>
        window.okDesktop?.config?.mode === 'editor'
          ? window.okDesktop.config.projectPath
          : undefined,
      )
      .catch(() => undefined);
    if (
      editorProjectPath !== undefined &&
      canonicalPathIfPresent(editorProjectPath) === canonicalProjectDir
    ) {
      return page;
    }
  }
  return undefined;
}
