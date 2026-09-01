import { t } from '@lingui/core/macro';
import { toast } from 'sonner';

export type SkillImportKind = 'import' | 'upload';

interface SkillImportResult {
  name: string;
  alreadyImported?: boolean;
  collisionRenamedFrom?: string;
  warnings?: string[];
}

export function announceSkillImport(kind: SkillImportKind, result: SkillImportResult): void {
  if (result.alreadyImported) {
    toast.success(
      kind === 'upload'
        ? t`"${result.name}" was already added (identical content).`
        : t`"${result.name}" was already imported (identical content).`,
    );
  } else if (result.collisionRenamedFrom) {
    toast.success(
      kind === 'upload'
        ? t`Uploaded as "${result.name}" — the name "${result.collisionRenamedFrom}" was taken.`
        : t`Imported as "${result.name}" — the name "${result.collisionRenamedFrom}" was taken.`,
    );
  } else {
    toast.success(
      kind === 'upload' ? t`Uploaded "${result.name}".` : t`Imported "${result.name}".`,
    );
  }
  for (const w of result.warnings ?? []) toast.warning(w);
}
