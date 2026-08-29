
import { SUPPORTED_DOC_EXTENSIONS } from '../../../constants/doc-extensions.ts';
import { defineOkfRule } from '../okf-runner.ts';

const RESERVED_STEMS = ['index', 'log'] as const;

function stemOf(docName: string): string {
  const base = docName.slice(docName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  const ext = base.slice(dot).toLowerCase();
  return (SUPPORTED_DOC_EXTENSIONS as readonly string[]).includes(ext) ? base.slice(0, dot) : base;
}

export const reservedCasing = defineOkfRule('reserved-casing', (_tree, file) => {
  const docName = file.data.okfDocName;
  if (docName === undefined) return;
  const stem = stemOf(docName);
  const lower = stem.toLowerCase();
  if (!RESERVED_STEMS.includes(lower as (typeof RESERVED_STEMS)[number])) return;
  if (stem === lower) return;
  file.message(
    `This file is named "${stem}", but the Open Knowledge Format only recognizes "${lower}". On a case-sensitive filesystem a consumer reads it as an ordinary concept document rather than the reserved file it is meant to be.`,
  );
});
