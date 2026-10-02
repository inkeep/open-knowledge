import { readFileSync } from 'node:fs';
import type { Principal } from '@inkeep/open-knowledge-core';
import { Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { describe, expect, test } from 'vitest';
import { extractActorIdentity } from './extract-actor-identity.ts';

const fixturePrincipal: Principal = {
  id: 'principal-11111111-2222-3333-4444-555555555555',
  display_name: 'Miles',
  display_email: 'miles@example.test',
  source: 'git-config',
  created_at: '2026-04-29T10:00:00.000Z',
};

describe('extractActorIdentity — agent branch', () => {
  test('agent only (no principal loaded) → kind=agent, writerId prefixed, anonymous principalId', () => {
    const result = extractActorIdentity({ agentId: 'claude-1', agentName: 'Claude' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.writerId).toBe('agent-claude-1');
    expect(result.displayName).toBe('Claude');
    expect(result.actor.principalId).toBeUndefined();
    expect(result.actor.agentType).toBe('bot');
  });

  test('agent + principal loaded → kind=agent AND actor.principalId populated (D-A8)', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-2', agentName: 'Claude', clientName: 'claude-code' },
      () => fixturePrincipal,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.writerId).toBe('agent-claude-2');
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
    expect(result.actor.agentType).toBe('claude');
    expect(result.actor.clientName).toBe('claude-code');
  });

  test('agentId already prefixed with agent- → toBroadcasterKey is idempotent', () => {
    const result = extractActorIdentity({ agentId: 'agent-claude-3' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.writerId).toBe('agent-claude-3');
  });

  test('agent default name when agentName not provided', () => {
    const result = extractActorIdentity({ agentId: 'claude-1' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.displayName).toBe('Claude');
  });

  test('agent colorSeed defaults to rawAgentId when not set', () => {
    const result = extractActorIdentity({ agentId: 'claude-7' }, () => null);
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.colorSeed).toBe('claude-7');
  });

  test('agent colorSeed honors explicit body.colorSeed', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-7', colorSeed: 'team-purple' },
      () => null,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.colorSeed).toBe('team-purple');
  });

  test('clientName/clientVersion/label sanitized via sanitizeGitIdentity', () => {
    const result = extractActorIdentity(
      {
        agentId: 'claude-1',
        clientName: 'claude-code',
        clientVersion: '1.0.0',
        label: 'refactor-1',
      },
      () => null,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.actor.clientName).toBe('claude-code');
    expect(result.actor.clientVersion).toBe('1.0.0');
    expect(result.actor.label).toBe('refactor-1');
  });
});

describe('extractActorIdentity — principal fallback', () => {
  test('no agentId + principal loaded → kind=principal with principal id', () => {
    const result = extractActorIdentity({}, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.writerId).toBe(fixturePrincipal.id);
    expect(result.displayName).toBe('Miles');
    expect(result.colorSeed).toBe(fixturePrincipal.id);
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
  });

  test('agentId empty string treated as absent → falls back to principal', () => {
    const result = extractActorIdentity({ agentId: '' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
  });

  test('agentId with invalid characters rejected → falls back to principal', () => {
    const result = extractActorIdentity({ agentId: 'has spaces' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
  });

  test('agentId not a string treated as absent', () => {
    const result = extractActorIdentity({ agentId: 42 }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
  });

  test('summary "absent" when no body.summary supplied', () => {
    const result = extractActorIdentity({}, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.summary.kind).toBe('absent');
  });
});

describe('extractActorIdentity — anonymous fallback', () => {
  test('no agentId + no principal loaded → kind=anonymous (D22 invariant)', () => {
    const result = extractActorIdentity({}, () => null);
    expect(result.kind).toBe('anonymous');
  });

  test('no agentId + getPrincipal undefined → kind=anonymous', () => {
    const result = extractActorIdentity({}, undefined);
    expect(result.kind).toBe('anonymous');
  });
});

describe('extractActorIdentity — D-A11 trust boundary', () => {
  test('body-supplied principalId is silently ignored — server principal wins', () => {
    const result = extractActorIdentity({ principalId: 'principal-fake' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.writerId).toBe(fixturePrincipal.id);
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
  });

  test('body-supplied principalId is silently ignored — anonymous when no server principal', () => {
    const result = extractActorIdentity({ principalId: 'principal-fake' }, () => null);
    expect(result.kind).toBe('anonymous');
  });

  test('body-supplied principalId is ignored even when agentId present', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-1', principalId: 'principal-fake' },
      () => fixturePrincipal,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.actor.principalId).toBe(fixturePrincipal.id);
  });
});

describe('extractActorIdentity — summary validation', () => {
  test('valid string summary surfaces as summary.kind=value', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-1', summary: 'A valid summary' },
      () => null,
    );
    expect(result.kind).toBe('agent');
    if (result.kind !== 'agent') return;
    expect(result.summary.kind).toBe('value');
    if (result.summary.kind !== 'value') return;
    expect(result.summary.value).toBe('A valid summary');
  });

  test('non-string summary surfaces as kind=invalid-summary (caller returns 400)', () => {
    const result = extractActorIdentity({ summary: 42 }, () => fixturePrincipal);
    expect(result.kind).toBe('invalid-summary');
  });

  test('invalid-summary signals before agent vs principal resolution', () => {
    const result = extractActorIdentity(
      { agentId: 'claude-1', summary: { not: 'string' } },
      () => fixturePrincipal,
    );
    expect(result.kind).toBe('invalid-summary');
  });

  test('whitespace-only summary classified as absent (matches normalizeSummary)', () => {
    const result = extractActorIdentity({ summary: '   ' }, () => fixturePrincipal);
    expect(result.kind).toBe('principal');
    if (result.kind !== 'principal') return;
    expect(result.summary.kind).toBe('absent');
  });
});

function isPrincipalKeyText(value: string): boolean {
  return value.replace(/^[^a-zA-Z0-9_]*/, '').startsWith('principalId');
}

function unwrapBodyNode(node: Node | undefined): Node | undefined {
  while (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isExpressionWithTypeArguments(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isNonNullExpression(node)
  )
    node = node.getExpression();
  return node;
}

function isBodyReceiver(node: Node | undefined): boolean {
  node = unwrapBodyNode(node);
  return (
    (Node.isIdentifier(node) && node.getText().endsWith('body')) ||
    (Node.isPropertyAccessExpression(node) && node.getName().endsWith('body'))
  );
}

function principalKey(node: Node | undefined, computed: boolean): boolean {
  node = unwrapBodyNode(node);
  if (Node.isComputedPropertyName(node)) return principalKey(node.getExpression(), true);
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return isPrincipalKeyText(node.getLiteralValue());
  if (Node.isNumericLiteral(node)) return isPrincipalKeyText(String(node.getLiteralValue()));
  if (!computed && Node.isIdentifier(node)) return isPrincipalKeyText(node.getText());
  return true;
}

function principalReads(file: SourceFile): string[] {
  const violations: string[] = [];
  for (const node of file.getDescendants()) {
    if (
      (Node.isPropertyAccessExpression(node) &&
        isBodyReceiver(node.getExpression()) &&
        isPrincipalKeyText(node.getName())) ||
      (Node.isElementAccessExpression(node) &&
        isBodyReceiver(node.getExpression()) &&
        principalKey(node.getArgumentExpression(), true))
    ) {
      violations.push(`body-principal-access: ${node.getText()}`);
    }
    if (Node.isVariableDeclaration(node) && isBodyReceiver(node.getInitializer())) {
      const pattern = node.getNameNode();
      if (Node.isObjectBindingPattern(pattern)) {
        for (const element of pattern.getElements()) {
          if (
            element.getDotDotDotToken() ||
            principalKey(element.getPropertyNameNode() ?? element.getNameNode(), false)
          ) {
            violations.push(`body-principal-destructure: ${element.getText()}`);
          }
        }
      }
    }
    if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      isBodyReceiver(node.getRight())
    ) {
      const pattern = unwrapBodyNode(node.getLeft());
      if (Node.isObjectLiteralExpression(pattern)) {
        for (const property of pattern.getProperties()) {
          if (Node.isSpreadAssignment(property) || principalKey(property.getNameNode(), false)) {
            violations.push(`body-principal-destructure: ${property.getText()}`);
          }
        }
      }
    }
  }
  return violations;
}

function createIdentityProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { noLib: true },
  });
}

function bodyPrincipalReads(source: string): string[] {
  const identityProject = createIdentityProject();
  const file = identityProject.createSourceFile('/extract-actor-identity.ts', source, {
    overwrite: true,
  });
  try {
    return principalReads(file);
  } finally {
    identityProject.removeSourceFile(file);
  }
}

function actorIdentityViolations(source: string): string[] {
  const identityProject = createIdentityProject();
  const file = identityProject.createSourceFile('/extract-actor-identity.ts', source, {
    overwrite: true,
  });
  try {
    const violations = identityProject
      .getProgram()
      .getSyntacticDiagnostics(file)
      .map((error) => `syntax: ${error.getCode()} at ${error.getStart()}`);
    if (file.getExportDeclarations().some((declaration) => declaration.getModuleSpecifier())) {
      violations.push('actor-identity re-export');
    }
    const functions = file.getFunctions().filter((declaration) => declaration.isExported());
    const declaration = functions[0];
    const parameter = declaration?.getParameters()[0];
    const name = parameter?.getNameNode();
    if (
      functions.length !== 1 ||
      declaration?.getName() !== 'extractActorIdentity' ||
      !declaration.getBody() ||
      !Node.isIdentifier(name) ||
      name.getText() !== 'body'
    ) {
      violations.push('actor-identity implementation census');
    }
    if (parameter && Node.isIdentifier(name) && name.getText() === 'body') {
      for (const reference of parameter.findReferencesAsNodes()) {
        const parent = reference.getParent();
        if (
          (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
          parent.getExpression() === reference
        )
          continue;
        if (
          Node.isVariableDeclaration(parent) &&
          parent.getInitializer() === reference &&
          Node.isObjectBindingPattern(parent.getNameNode())
        )
          continue;
        if (
          Node.isBinaryExpression(parent) &&
          parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
          parent.getRight() === reference &&
          Node.isObjectLiteralExpression(unwrapBodyNode(parent.getLeft()))
        )
          continue;
        if (
          Node.isCallExpression(parent) &&
          parent.getArguments().length === 1 &&
          parent.getArguments()[0] === reference
        ) {
          const callee = parent.getExpression();
          if (Node.isIdentifier(callee) && callee.getText() === 'parseAgentBodyFields') continue;
        }
        violations.push(`body-parameter-use: ${parent.getText()}`);
      }
    }
    return [...violations, ...principalReads(file)];
  } finally {
    identityProject.removeSourceFile(file);
  }
}

describe('extractActorIdentity — structural D-A11 trust boundary', () => {
  test.each([
    'body.principalId',
    "body['principalId']",
    'body["principalId"]',
    'body[principalId]',
    'body[/principalId/.source]',
    'body[$principalId]',
    'body[πprincipalId]',
    'body.$principalId',
    "body['$principalId']",
    "body[('principalId')]",
    "body['principalId' as const]",
    'body[principalId + suffix]',
    `body[\`principalId\${suffix}\`]`,
    'body[`principalId`]',
    'body?.principalId',
    "body?.['principalId']",
    'body?.["principalId"]',
    'request.body.principalId',
    'body.principalIdFallback',
    'const { principalId } = body;',
    'const { principalId: claimed } = body;',
    "const { ['principalId']: claimed } = body;",
    "const { 'principalId': claimed } = body;",
    '({ principalId } = body);',
  ])('detects a body principal read in %s', (source) => {
    expect(bodyPrincipalReads(source)).toHaveLength(1);
  });

  test('allows server identity and adjacent body fields, including destructuring', () => {
    expect(
      bodyPrincipalReads(`
      principal.id; actor.principalId; body.agentId;
      const { principalId } = actor;
      const { agentId: principalId } = body;
      body['agentId']; body?.agentId;
      /* body.principalId */
      const example = "body['principalId']";
    `),
    ).toEqual([]);
  });

  test.each([
    [`body[\`\${''}principalId\`]`, "body['agentId']"],
    [`body[\`\${''}principalId\${''}\`]`, 'body[`agentId`]'],
    ['body[key]', "body['agentId']"],
    ['body[key()]', "body['agentId']"],
    ["body['agent' + 'Id']", "body['agentId']"],
    ['body[/principalId/.source]', "body['agentId']"],
    ["body[('principalId' as string)]", "body[('agentId' as string)]"],
    ["body['principalId' satisfies string]", "body['agentId' satisfies string]"],
    ["body['principalId'!]", "body['agentId'!]"],
    ['body[selector]', 'body[0]'],
    ['(body as Record<string, unknown>).principalId', '(body as Record<string, unknown>).agentId'],
    ['(<Record<string, unknown>>body).principalId', '(<Record<string, unknown>>body).agentId'],
    [
      "(body<Record<string, unknown>>)['principalId']",
      "(body<Record<string, unknown>>)['agentId']",
    ],
    [
      '(body satisfies Record<string, unknown>).principalId',
      '(body satisfies Record<string, unknown>).agentId',
    ],
    ['body!.principalId', 'body!.agentId'],
    ['(request.body).principalId', '(request.body).agentId'],
  ])('principal access pair: %s', (bad, good) => {
    expect(
      bodyPrincipalReads(bad).filter((violation) => violation.startsWith('body-principal-access:')),
    ).toHaveLength(1);
    expect(bodyPrincipalReads(good)).toEqual([]);
  });
  test.each([
    ['const { ...rest } = body', 'const { agentId: rest } = body'],
    ['const { [key]: claim } = body', "const { ['agentId']: claim } = body"],
    ["const { ['principalId']: claim } = body", "const { ['agentId']: claim } = body"],
    ['({ ...rest } = body)', '({ agentId: rest } = body)'],
    ['({ [key]: claim } = body)', "({ ['agentId']: claim } = body)"],
    ["({ ['principalId']: claim } = body)", "({ ['agentId']: claim } = body)"],
    ['const { principalId } = body', 'const { agentId } = body'],
  ])('principal destructuring pair: %s', (bad, good) => {
    expect(
      bodyPrincipalReads(bad).filter((violation) =>
        violation.startsWith('body-principal-destructure:'),
      ),
    ).toHaveLength(1);
    expect(bodyPrincipalReads(good)).toEqual([]);
  });

  const validIdentitySource =
    'export function extractActorIdentity(body) { parseAgentBodyFields(body); return body.agentId; }';
  test.each([
    'const payload = body;',
    'void (body as Record<string, unknown>).agentId;',
    'void (body satisfies Record<string, unknown>).agentId;',
    'void body!.agentId;',
    'const copy = { ...body };',
    'void readClaim(body);',
    'return body;',
    'void { body };',
    'parseAgentBodyFields(body, other);',
  ])('refuses unaccounted parameter reference %s', (statement) => {
    expect(actorIdentityViolations(validIdentitySource)).toEqual([]);
    expect(
      actorIdentityViolations(`export function extractActorIdentity(body) { ${statement} }`),
    ).toHaveLength(1);
    expect(
      actorIdentityViolations(`export function extractActorIdentity(body) { ${statement} }`)[0],
    ).toContain('body-parameter-use:');
  });
  test.each(["export * from './impl';", "export { extractActorIdentity } from './impl';"])(
    'refuses identity re-export %s',
    (forward) => {
      expect(actorIdentityViolations(validIdentitySource)).toEqual([]);
      expect(actorIdentityViolations(`${validIdentitySource}\n${forward}`)).toEqual([
        'actor-identity re-export',
      ]);
    },
  );
  test.each([
    '',
    'export function different(body) {}',
    'function extractActorIdentity(body) {}',
    'export function extractActorIdentity(payload) {}',
    'export declare function extractActorIdentity(body);',
    'export function extractActorIdentity(body) {} export function other() {}',
  ])('requires the identity implementation census: %s', (source) => {
    expect(actorIdentityViolations(validIdentitySource)).toEqual([]);
    expect(actorIdentityViolations(source)).toEqual(['actor-identity implementation census']);
  });
  test('checks syntax and resolves body references by symbol', () => {
    expect(
      actorIdentityViolations(`${validIdentitySource} function other(body) { return body; }`),
    ).toEqual([]);
    expect(
      actorIdentityViolations(`${validIdentitySource} const broken = ;`).filter((value) =>
        value.startsWith('syntax:'),
      ),
    ).toHaveLength(1);
  });

  test('extract-actor-identity.ts never reads body-supplied principalId (D-A11 trust boundary)', () => {
    expect(
      actorIdentityViolations(
        readFileSync(new URL('./extract-actor-identity.ts', import.meta.url), 'utf8'),
      ),
    ).toEqual([]);
  });
});
