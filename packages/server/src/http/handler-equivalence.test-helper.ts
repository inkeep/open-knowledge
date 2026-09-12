import { type Node, Project, SyntaxKind, ts } from 'ts-morph';

export type NormalizedSyntax = readonly [kind: string, value: string | readonly NormalizedSyntax[]];

function readHandlerDeclaration(source: string, handlerName: string): Node {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { noLib: true },
  });
  const sourceFile = project.createSourceFile('handler.ts', source);
  const declaration = sourceFile
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((candidate) => candidate.getName() === handlerName);
  if (declaration === undefined) throw new Error(`${handlerName} is absent`);
  const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  if (statement === undefined) throw new Error(`${handlerName} has no statement`);
  return statement;
}

function normalizeSyntax(node: Node): NormalizedSyntax {
  const children = node
    .getChildren()
    .filter(
      (child) =>
        child.getKind() !== SyntaxKind.SingleLineCommentTrivia &&
        child.getKind() !== SyntaxKind.MultiLineCommentTrivia,
    );
  return children.length === 0
    ? [node.getKindName(), node.getText()]
    : [node.getKindName(), children.map(normalizeSyntax)];
}

export function normalizedHandler(source: string, handlerName: string): NormalizedSyntax {
  return normalizeSyntax(readHandlerDeclaration(source, handlerName));
}

export function orderedComments(source: string, handlerName: string): string[] {
  const declaration = readHandlerDeclaration(source, handlerName).getFullText();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    declaration,
  );
  const comments: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      comments.push(scanner.getTokenText());
    }
  }
  return comments;
}
