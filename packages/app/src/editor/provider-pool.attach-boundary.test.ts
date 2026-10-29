import { join } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { describe, expect, test } from 'vitest';
import { ATTACH_BOUNDARY_MODULE } from './provider-pool.attach-boundary.reads';

const SANCTIONED_CALLERS = ['attachValidatedPersistence', 'open'] as const;

describe('persistence-attach boundary (buildPersistence callers)', () => {
  test('buildPersistence has exactly the two sanctioned callers', () => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const sourceFile = project.addSourceFileAtPath(join(import.meta.dir, ATTACH_BOUNDARY_MODULE));

    const callerMethods = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => {
        const expression = call.getExpression();
        return (
          expression.getKind() === SyntaxKind.PropertyAccessExpression &&
          expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName() ===
            'buildPersistence'
        );
      })
      .map((call) => {
        const method = call.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
        const line = call.getStartLineNumber();
        return `${method?.getName() ?? '<outside-method>'} (${ATTACH_BOUNDARY_MODULE}:${line})`;
      })
      .sort();

    expect(callerMethods.map((entry) => entry.split(' ')[0])).toEqual([...SANCTIONED_CALLERS]);
  });
});
