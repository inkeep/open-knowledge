import { resolveVariable } from './binding.mjs';

const SONNER = 'sonner';

function importedName(specifier) {
  const imported = specifier.imported;
  if (!imported) return '';
  return imported.type === 'Identifier' ? imported.name : String(imported.value ?? '');
}

export function sonnerToastBindings(program) {
  const direct = new Set();
  const namespaces = new Set();
  for (const statement of program.body ?? []) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.source?.value !== SONNER || statement.importKind === 'type') continue;
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.add(specifier.local.name);
      } else if (
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        importedName(specifier) === 'toast'
      ) {
        direct.add(specifier.local.name);
      }
    }
  }
  return { direct, namespaces };
}

function resolvesToImport(sourceCode, identifier) {
  const variable = resolveVariable(sourceCode, identifier);
  return variable?.defs.every((def) => def.type === 'ImportBinding') ?? false;
}

function isImportedAs(node, names, sourceCode) {
  return node?.type === 'Identifier' && names.has(node.name) && resolvesToImport(sourceCode, node);
}

function isToastObject(node, bindings, sourceCode) {
  if (node?.type === 'Identifier') return isImportedAs(node, bindings.direct, sourceCode);
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'toast' &&
    isImportedAs(node.object, bindings.namespaces, sourceCode)
  );
}

export function toastCallMethod(call, bindings, sourceCode) {
  const callee = call.callee;
  if (isToastObject(callee, bindings, sourceCode)) return '';
  if (
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property?.type === 'Identifier' &&
    isToastObject(callee.object, bindings, sourceCode)
  ) {
    return callee.property.name;
  }
  return null;
}
