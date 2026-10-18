export function resolveVariable(sourceCode, identifier) {
  for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable && variable.defs.length > 0) return variable;
  }
  return null;
}
