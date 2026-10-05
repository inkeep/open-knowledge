import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-app-core-barrel-import');

const CORE_BARREL = '@inkeep/open-knowledge-core';

const MESSAGE = `Bare ${CORE_BARREL} import in app production source — it pulls core's whole barrel into the editor's module graph. Import each binding from the core subpath of the module that exports it (${CORE_BARREL}/<module>, declared in packages/core/package.json exports). See ${URL}`;

function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  return undefined;
}

function withoutQueryOrHash(specifier) {
  return specifier?.split(/[?#]/, 1)[0];
}

export const noAppCoreBarrelImport = {
  meta: {
    type: 'problem',
    docs: {
      description: `App production source may not reference the bare ${CORE_BARREL} barrel; import core subpaths.`,
      url: URL,
    },
  },
  create(context) {
    function check(sourceNode) {
      if (withoutQueryOrHash(stringValue(sourceNode)) !== CORE_BARREL) return;
      context.report({ node: sourceNode, message: MESSAGE });
    }
    return {
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        check(node.source);
      },
      TSImportType(node) {
        check(node.source);
      },
      TSExternalModuleReference(node) {
        check(node.expression);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        check(node.arguments[0]);
      },
    };
  },
};
