import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_URL_BASE } from './allowlist.mjs';
import { analyzeSource, describeViolation, loadPrecedentNumbers } from './index.mjs';
import { isInScope, normalizeRelativePath } from './scope.mjs';

export const PLUGIN_NAME = 'no-comments';
export const RULE_NAME = 'no-comments';
export const RULE_ID = `${PLUGIN_NAME}/${RULE_NAME}`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function relativePathFor(context) {
  const absolute = context.physicalFilename ?? context.filename;
  return normalizeRelativePath(relative(REPO_ROOT, absolute));
}

export const noCommentsRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow code comments outside the machine-checkable allowlist (directives, sanctioned md-audit tags, @deprecated, STOP:/WARN:/UPSTREAM(ref): contract markers, validated precedent citations, registered guard markers).',
      url: DOCS_URL_BASE,
    },
    schema: [
      {
        type: 'object',
        properties: {
          scope: { enum: ['declared', 'all'] },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const [options = {}] = context.options ?? [];
    const relPath = relativePathFor(context);
    if (options.scope !== 'all' && !isInScope(relPath)) return {};

    const precedentNumbers = loadPrecedentNumbers(REPO_ROOT);

    return {
      Program() {
        const { violations } = analyzeSource({
          source: context.sourceCode.text,
          relPath,
          precedentNumbers,
        });
        for (const violation of violations) {
          context.report({
            node: { range: [violation.comment.start, violation.comment.end] },
            message: describeViolation(violation),
          });
        }
      },
    };
  },
};

export default {
  meta: { name: PLUGIN_NAME },
  rules: { [RULE_NAME]: noCommentsRule },
};
